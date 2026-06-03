import * as path from 'path';
import * as fs from 'fs';
import * as childProcess from 'child_process';
import * as vscode from 'vscode';
import { generateDsl, resolveDslUsage, DslError } from './cgen';
import { formatCgen } from './formatter';
import { CgenProjectIndex } from './indexer';
import { createDslSuggestion } from './suggestions';

interface ParsedDiagnostic {
  line: number;
  message: string;
}

let saveEditorFn: (() => Promise<void>) | undefined;
let projectIndexPromise: Promise<CgenProjectIndex | undefined> | undefined;
let postProgressMessage: ((active: boolean) => void) | undefined;
let postDiagnosticsMessage: ((diagnostics: ParsedDiagnostic[]) => void) | undefined;
let currentEditorContent = '';

interface FormatPolicy {
  formatOnSave: boolean;
  formatOnPaste: boolean;
}

interface EditorFontConfig {
  family: string;
  size: number;
  weight: string;
  featureSettings: string;
  variantLigatures: string;
  faceUri?: string;
}

export function activate(context: vscode.ExtensionContext) {
  projectIndexPromise = initializeProjectIndex(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('cgen.openDslEditor', () => openDslEditor(context)),
    vscode.commands.registerCommand('cgen.saveEditor', () => saveEditorFn?.()),
    vscode.commands.registerCommand('cgen.openScratchFile', openScratchFile),
    vscode.commands.registerCommand('cgen.generateFromFile', () => generateFromCurrentFile(context)),
    vscode.commands.registerCommand('cgen.internalSuggestionAccepted', async (contextKey: string, prefix: string, label: string, kind: string) => {
      const workspaceFolder = getWorkspaceFolder();
      if (!workspaceFolder) { return; }
      const projectIndex = await getProjectIndex(context, workspaceFolder);
      projectIndex?.recordSuggestionAccepted(contextKey, prefix, label, kind);
    }),
    vscode.languages.registerDocumentFormattingEditProvider('cgen', {
      provideDocumentFormattingEdits(document) {
        const formatted = formatCgen(document.getText());
        return [vscode.TextEdit.replace(fullDocumentRange(document), formatted)];
      }
    }),
    vscode.languages.registerCompletionItemProvider(
      'cgen',
      {
        async provideCompletionItems(document, position) {
          const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri) ?? getWorkspaceFolder();
          if (!workspaceFolder) { return undefined; }
          const projectIndex = await getProjectIndex(context, workspaceFolder);
          if (!projectIndex) { return undefined; }

          const text = document.getText();
          const cursor = document.offsetAt(position);
          const result = await createDslSuggestion(projectIndex, { text, cursor });
          if (!result || result.candidates.length === 0) { return undefined; }

          const tailLen = Math.max(0, result.candidates[0].length - result.insertText.length);
          const rangeStart = document.positionAt(Math.max(0, cursor - tailLen - result.replaceLeft));
          const range = new vscode.Range(rangeStart, position);

          return result.candidates.map((label, i) => {
            const item = new vscode.CompletionItem(label, kindToVscodeKind(result.candidateKinds[i]));
            item.insertText = label;
            item.range = range;
            item.command = {
              command: 'cgen.internalSuggestionAccepted',
              title: '',
              arguments: [result.contextKey, result.prefix, label, result.candidateKinds[i]]
            };
            return item;
          });
        }
      },
      '.', '@', '('
    )
  );
}

export function deactivate() {
  projectIndexPromise?.then((index) => index?.dispose(), () => undefined);
}

async function openDslEditor(context: vscode.ExtensionContext) {
  const workspaceFolder = getWorkspaceFolder();
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('CGen needs an open workspace folder.');
    return;
  }

  const config = vscode.workspace.getConfiguration('cgen');
  const scratchUri = vscode.Uri.joinPath(workspaceFolder.uri, '.cgen', 'session.cgen');
  const stateUri = vscode.Uri.joinPath(workspaceFolder.uri, '.cgen', 'session.json');

  let initialCursor = 0;
  let initialScroll = 0;
  let initialFilePath: string | undefined;
  try {
    const state = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(stateUri)).toString('utf8'));
    initialCursor = state.cursor ?? 0;
    initialScroll = state.scrollTop ?? 0;
    initialFilePath = state.filePath ?? undefined;
  } catch { /* no saved state */ }

  let currentFilePath: string | undefined;
  let initialValue: string;
  if (initialFilePath) {
    try {
      initialValue = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(initialFilePath))).toString('utf8');
      currentFilePath = initialFilePath;
    } catch {
      initialFilePath = undefined;
      try {
        initialValue = Buffer.from(await vscode.workspace.fs.readFile(scratchUri)).toString('utf8');
      } catch {
        initialValue = config.get<string>('defaultDsl', '');
      }
    }
  } else {
    try {
      initialValue = Buffer.from(await vscode.workspace.fs.readFile(scratchUri)).toString('utf8');
    } catch {
      initialValue = config.get<string>('defaultDsl', '');
    }
  }

  const editorFont = getEditorFontConfig(currentFilePath ? vscode.Uri.file(currentFilePath) : scratchUri);
  const editorFontFile = resolveEditorFontFile(editorFont.family, editorFont.weight);
  const localResourceRoots = [context.extensionUri];
  if (editorFontFile) {
    localResourceRoots.push(vscode.Uri.file(path.dirname(editorFontFile.fsPath)));
  }

  const panel = vscode.window.createWebviewPanel(
    'cgen.dslEditor',
    'CGen',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots
    }
  );

  if (editorFontFile) {
    editorFont.faceUri = panel.webview.asWebviewUri(editorFontFile).toString();
    editorFont.family = `"CGenEditorFont", ${editorFont.family}`;
  }

  panel.webview.html = getWebviewHtml(
    panel.webview,
    context.extensionUri,
    initialValue,
    editorFont,
    initialCursor,
    initialScroll
  );
  if (currentFilePath) {
    panel.title = `CGen — ${path.basename(currentFilePath)}`;
  }

  let currentContent = initialValue;

  async function postFormatPolicy() {
    await panel.webview.postMessage({ type: 'formatPolicy', policy: getFormatPolicy(currentFileUri() ?? scratchUri) });
  }

  function currentFileUri(): vscode.Uri | undefined {
    return currentFilePath ? vscode.Uri.file(currentFilePath) : undefined;
  }

  async function saveToFile() {
    postProgressMessage?.(true);
    try {
      let targetUri = currentFileUri();
      if (currentFilePath) {
        targetUri = vscode.Uri.file(currentFilePath);
      } else {
        const uri = await vscode.window.showSaveDialog({
          filters: { 'CGen DSL': ['cgen'] },
          defaultUri: vscode.Uri.joinPath(workspaceFolder!.uri, 'main.cgen')
        });
        if (uri) {
          currentFilePath = uri.fsPath;
          targetUri = uri;
          const name = path.basename(uri.fsPath);
          panel.title = `CGen — ${name}`;
          await panel.webview.postMessage({ type: 'title', text: name });
          await postFormatPolicy();
          await saveSession(0, 0);
        }
      }

      if (!targetUri) {
        return;
      }

      if (getFormatPolicy(targetUri).formatOnSave) {
        currentContent = formatCgen(currentContent);
        await panel.webview.postMessage({ type: 'format', text: currentContent });
      }
      await vscode.workspace.fs.writeFile(targetUri, Buffer.from(currentContent, 'utf8'));
    } finally {
      postProgressMessage?.(false);
    }
  }

  async function saveSession(cursor: number, scrollTop: number) {
    await vscode.workspace.fs.writeFile(stateUri, Buffer.from(JSON.stringify({
      cursor,
      scrollTop,
      filePath: currentFilePath ?? null
    }), 'utf8'));
  }

  saveEditorFn = saveToFile;
  postProgressMessage = (active) => {
    void panel.webview.postMessage({ type: 'progress', active });
  };
  postDiagnosticsMessage = (diagnostics) => {
    void panel.webview.postMessage({ type: 'error', diagnostics });
  };
  projectIndexPromise?.then((index) => {
    if (index) { index.onBusyChange = postProgressMessage; }
  });
  const configDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('editor.formatOnSave') || event.affectsConfiguration('editor.formatOnPaste')) {
      postFormatPolicy().catch(() => undefined);
    }
  });
  panel.onDidDispose(() => {
    saveEditorFn = undefined;
    postProgressMessage = undefined;
    postDiagnosticsMessage = undefined;
    projectIndexPromise?.then((index) => {
      if (index) { index.onBusyChange = undefined; }
    });
    configDisposable.dispose();
  });
  await postFormatPolicy();

  panel.webview.onDidReceiveMessage(async (message: { type: string; text?: string; cursor?: number; scrollTop?: number; id?: number; line?: number; action?: string; data?: unknown; contextKey?: string; prefix?: string; label?: string; kind?: string }) => {
    if (message.type === 'expand') {
      await vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup');
      return;
    }

    if (message.type === 'change' && typeof message.text === 'string') {
      currentContent = message.text;
      currentEditorContent = message.text;
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceFolder.uri, '.cgen'));
      await vscode.workspace.fs.writeFile(scratchUri, Buffer.from(message.text, 'utf8'));
      if (typeof message.cursor === 'number') {
        await saveSession(message.cursor, message.scrollTop ?? 0);
      }
      projectIndexPromise?.then((index) => index?.onSourceChanged?.());
      return;
    }

    if (message.type === 'suggest' && typeof message.text === 'string' && typeof message.cursor === 'number' && typeof message.id === 'number') {
      const projectIndex = await getProjectIndex(context, workspaceFolder);
      const suggestion = projectIndex
        ? await createDslSuggestion(projectIndex, {
            text: message.text,
            cursor: message.cursor
          })
        : undefined;
      await panel.webview.postMessage({
        type: 'suggestion',
        id: message.id,
        insertText: suggestion?.insertText ?? '',
        replaceLeft: suggestion?.replaceLeft ?? 0,
        candidates: suggestion?.candidates ?? [],
        candidateKinds: suggestion?.candidateKinds ?? [],
        contextKey: suggestion?.contextKey ?? '',
        prefix: suggestion?.prefix ?? ''
      });
      return;
    }

    if (message.type === 'suggestionAccepted' && typeof message.contextKey === 'string' && typeof message.label === 'string') {
      const projectIndex = await getProjectIndex(context, workspaceFolder);
      projectIndex?.recordSuggestionAccepted(
        message.contextKey,
        message.prefix ?? '',
        message.label,
        message.kind ?? ''
      );
      return;
    }

    if (message.type === 'save') {
      if (typeof message.text === 'string') { currentContent = message.text; }
      await saveToFile();
      return;
    }

    if (message.type === 'load') {
      postProgressMessage?.(true);
      try {
        const uris = await vscode.window.showOpenDialog({
          filters: { 'CGen DSL': ['cgen'] },
          canSelectMany: false
        });
        if (uris && uris.length > 0) {
          const bytes = await vscode.workspace.fs.readFile(uris[0]);
          currentFilePath = uris[0].fsPath;
          currentContent = Buffer.from(bytes).toString('utf8');
          const name = path.basename(uris[0].fsPath);
          panel.title = `CGen — ${name}`;
          await panel.webview.postMessage({ type: 'load', text: currentContent });
          await panel.webview.postMessage({ type: 'title', text: name });
          await postFormatPolicy();
          await saveSession(0, 0);
        }
      } finally {
        postProgressMessage?.(false);
      }
      return;
    }

if (message.type !== 'generate' || typeof message.text !== 'string') {
      return;
    }

    try {
      currentContent = message.text;
      const { files, root, usage } = await generateDsl(workspaceFolder, context.extensionUri, message.text);
      const projectIndex = await getProjectIndex(context, workspaceFolder);
      projectIndex?.updateFromArtifacts(root);
      projectIndex?.updateSymbolUsage(usage);
      await panel.webview.postMessage({ type: 'error', diagnostics: [], jump: true });
      vscode.window.showInformationMessage(`CGen generated ${files.length} file(s).`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await panel.webview.postMessage({ type: 'error', diagnostics: parseErrorDiagnostics(msg), jump: true });
      vscode.window.showErrorMessage(msg);
    }
  });
}

async function generateFromCurrentFile(context: vscode.ExtensionContext) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('Open a .cgen file first.');
    return;
  }

  if (!isCgenDocument(editor.document)) {
    vscode.window.showErrorMessage('CGen can generate only from .cgen files.');
    return;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri) ?? getWorkspaceFolder();
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('CGen needs an open workspace folder.');
    return;
  }

  try {
    const { files, root, usage } = await generateDsl(workspaceFolder, context.extensionUri, editor.document.getText());
    const projectIndex = await getProjectIndex(context, workspaceFolder);
    projectIndex?.updateFromArtifacts(root);
    projectIndex?.updateSymbolUsage(usage);
    vscode.window.showInformationMessage(`CGen generated ${files.length} file(s).`);
  } catch (error) {
    vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

function isCgenDocument(document: vscode.TextDocument): boolean {
  return document.languageId === 'cgen' && document.uri.fsPath.toLowerCase().endsWith('.cgen');
}

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
  return new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
}

function getFormatPolicy(uri: vscode.Uri): FormatPolicy {
  const config = vscode.workspace.getConfiguration('editor', { uri, languageId: 'cgen' });
  return {
    formatOnSave: config.get<boolean>('formatOnSave', false),
    formatOnPaste: config.get<boolean>('formatOnPaste', false)
  };
}

function getEditorFontConfig(uri: vscode.Uri): EditorFontConfig {
  const config = vscode.workspace.getConfiguration('editor', { uri, languageId: 'cgen' });
  const ligatures = config.get<boolean | string>('fontLigatures', false);
  return {
    family: config.get<string>('fontFamily', 'monospace'),
    size: config.get<number>('fontSize', 13),
    weight: String(config.get<string | number>('fontWeight', 'normal')),
    featureSettings: typeof ligatures === 'string' ? ligatures : ligatures ? 'normal' : '"liga" 0, "calt" 0',
    variantLigatures: ligatures ? 'normal' : 'none'
  };
}

function resolveEditorFontFile(fontFamily: string, fontWeight: string): vscode.Uri | undefined {
  if (process.platform !== 'linux') {
    return undefined;
  }

  const family = parseFontFamilyList(fontFamily).find((name) => !isGenericFontFamily(name));
  if (!family) {
    return undefined;
  }

  const patterns = fontStylePatterns(family, fontWeight);
  for (const pattern of patterns) {
    const result = childProcess.spawnSync('fc-match', ['-f', '%{file}', pattern], {
      encoding: 'utf8'
    });
    const file = result.status === 0 ? result.stdout.trim() : '';
    if (file && fs.existsSync(file)) {
      return vscode.Uri.file(file);
    }
  }

  return undefined;
}

function parseFontFamilyList(value: string): string[] {
  const names: string[] = [];
  let current = '';
  let quote = '';

  for (const char of value) {
    if (quote) {
      if (char === quote) {
        quote = '';
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === ',') {
      if (current.trim()) {
        names.push(current.trim());
      }
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    names.push(current.trim());
  }

  return names;
}

function isGenericFontFamily(name: string): boolean {
  return ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui'].includes(name.toLowerCase());
}

function fontStylePatterns(family: string, weight: string): string[] {
  const numericWeight = parseInt(weight, 10);
  const style =
    numericWeight >= 700 || weight.toLowerCase() === 'bold' ? 'Bold' :
    numericWeight >= 600 ? 'Semibold' :
    numericWeight >= 500 ? 'Medium' :
    undefined;

  return style
    ? [`${family}:style=${style}`, family]
    : [family];
}

async function openScratchFile() {
  const workspaceFolder = getWorkspaceFolder();
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('CGen needs an open workspace folder.');
    return;
  }

  const config = vscode.workspace.getConfiguration('cgen');
  const defaultDsl = config.get<string>('defaultDsl', '');
  const dir = vscode.Uri.joinPath(workspaceFolder.uri, '.cgen');
  const file = vscode.Uri.joinPath(dir, 'main.cgen');

  try {
    await vscode.workspace.fs.createDirectory(dir);
    try {
      await vscode.workspace.fs.stat(file);
    } catch {
      await vscode.workspace.fs.writeFile(file, Buffer.from(defaultDsl, 'utf8'));
    }

    const document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document, vscode.ViewColumn.Active);
  } catch (error) {
    vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

async function initializeProjectIndex(context: vscode.ExtensionContext): Promise<CgenProjectIndex | undefined> {
  const workspaceFolder = getWorkspaceFolder();
  if (!workspaceFolder) {
    return undefined;
  }

  try {
    const index = await CgenProjectIndex.create(context, workspaceFolder);
    let usageTimer: NodeJS.Timeout | undefined;
    index.onSourceChanged = () => {
      if (usageTimer) { clearTimeout(usageTimer); }
      usageTimer = setTimeout(async () => {
        index.onBusyChange?.(true);
        try {
          const { root, usage } = await resolveDslUsage(workspaceFolder, context.extensionUri, currentEditorContent);
          index.updateFromArtifacts(root);
          index.updateSymbolUsage(usage);
          postDiagnosticsMessage?.([]);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          postDiagnosticsMessage?.(parseErrorDiagnostics(msg));
          if (error instanceof DslError) {
            index.updateFromArtifacts(error.root);
          }
        } finally {
          index.onBusyChange?.(false);
        }
      }, 500);
    };
    index.onSourceChanged();
    return index;
  } catch (error) {
    vscode.window.showWarningMessage(`CGen index: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function getProjectIndex(
  context: vscode.ExtensionContext,
  workspaceFolder: vscode.WorkspaceFolder
): Promise<CgenProjectIndex | undefined> {
  const existing = await projectIndexPromise;
  if (existing) {
    return existing;
  }

  projectIndexPromise = CgenProjectIndex.create(context, workspaceFolder).catch((error) => {
    vscode.window.showWarningMessage(`CGen index: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  });
  return projectIndexPromise;
}

function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  value: string,
  editorFont: EditorFontConfig,
  cursor = 0,
  scrollTop = 0
): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'dslEditor.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'dslEditor.css'));
  const nonce = createNonce();
  const initialState = JSON.stringify({ cursor, scrollTop, editorFont });
  const fontFaceCss = editorFont.faceUri
    ? `@font-face{font-family:CGenEditorFont;src:url("${escapeCssUrl(editorFont.faceUri)}");font-weight:${escapeCssValue(editorFont.weight)};font-style:normal;}`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style nonce="${nonce}">${fontFaceCss}</style>
  <link href="${styleUri}" rel="stylesheet">
  <title>CGen</title>
</head>
<body>
  <main class="shell">
    <div class="toolbar">
      <span class="title">CGen<span id="filename"> — Untitled</span></span>
      <span id="breadcrumb"></span>
      <button id="expand" class="icon-btn" type="button" title="Expand editor (Ctrl+Alt+G)">
        <span id="expandIcon" aria-hidden="true">⛶</span>
      </button>
    </div>
    <div id="progressBar" aria-hidden="true"></div>
    <div class="editor" aria-label="CGen DSL editor">
      <div id="stripes" aria-hidden="true"></div>
      <div id="errorLines" aria-hidden="true"></div>
      <div id="activeLine" aria-hidden="true"></div>
      <pre id="lineNumbers" aria-hidden="true"></pre>
      <pre id="highlight" aria-hidden="true"></pre>
      <pre id="suggestion" aria-hidden="true"></pre>
<div id="diagnosticBubble" class="diagnostic-bubble" hidden></div>
      <textarea id="source" wrap="off" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off">${escapeHtml(value)}</textarea>
    </div>
    <div class="footer">
      <button id="load" class="icon-btn" type="button" title="Load from file" aria-label="Load from file">
        <i class="codicon codicon-folder-opened" aria-hidden="true"></i>
      </button>
      <button id="save" class="icon-btn" type="button" title="Save to file" aria-label="Save to file">
        <i class="codicon codicon-save" aria-hidden="true"></i>
      </button>
      <button id="generate" class="icon-btn generate-btn" type="button" title="Generate C files (Ctrl+Enter)" aria-label="Generate C files">
        <span aria-hidden="true">▶</span>
      </button>
    </div>
  </main>
  <script nonce="${nonce}">
    {
      const state = ${escapeScriptJson(initialState)};
      window.__cgenCursor = state.cursor;
      window.__cgenScroll = state.scrollTop;
      const root = document.documentElement;
      root.style.setProperty('--cgen-editor-font-family', state.editorFont.family);
      root.style.setProperty('--cgen-editor-font-size', state.editorFont.size + 'px');
      root.style.setProperty('--cgen-editor-font-weight', state.editorFont.weight);
      root.style.setProperty('--cgen-editor-font-feature-settings', state.editorFont.featureSettings);
      root.style.setProperty('--cgen-editor-font-variant-ligatures', state.editorFont.variantLigatures);
    }
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function escapeScriptJson(json: string): string {
  return json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function escapeCssUrl(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '');
}

function escapeCssValue(value: string): string {
  return value.replace(/[^0-9A-Za-z -]/g, '');
}

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let index = 0; index < 32; index += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function kindToVscodeKind(kind: string): vscode.CompletionItemKind {
  switch (kind) {
    case 'keyword': return vscode.CompletionItemKind.Keyword;
    case 'alias': return vscode.CompletionItemKind.TypeParameter;
    case 'enum': return vscode.CompletionItemKind.Enum;
    case 'struct': return vscode.CompletionItemKind.Struct;
    case 'template': return vscode.CompletionItemKind.Function;
    case 'fn': return vscode.CompletionItemKind.Function;
    case 'field': return vscode.CompletionItemKind.Field;
    case 'param': return vscode.CompletionItemKind.Variable;
    case 'package': return vscode.CompletionItemKind.Module;
    case 'module': return vscode.CompletionItemKind.Module;
    case 'scope': return vscode.CompletionItemKind.Module;
    default: return vscode.CompletionItemKind.Text;
  }
}

function parseErrorDiagnostics(message: string): ParsedDiagnostic[] {
  const results: ParsedDiagnostic[] = [];
  const pattern = /^Line (\d+):\s*(.*)/gm;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(message)) !== null) {
    const line = parseInt(match[1], 10);
    results.push({ line, message: match[2] });
  }

  return results;
}
