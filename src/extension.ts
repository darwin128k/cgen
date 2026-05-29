import * as path from 'path';
import * as vscode from 'vscode';
import { generateDsl } from './cgen';
import { CgenProjectIndex } from './indexer';
import { createDslSuggestion } from './suggestions';

let saveEditorFn: (() => Promise<void>) | undefined;
let projectIndexPromise: Promise<CgenProjectIndex | undefined> | undefined;

export function activate(context: vscode.ExtensionContext) {
  projectIndexPromise = initializeProjectIndex(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('cgen.openDslEditor', () => openDslEditor(context)),
    vscode.commands.registerCommand('cgen.saveEditor', () => saveEditorFn?.()),
    vscode.commands.registerCommand('cgen.openScratchFile', openScratchFile),
    vscode.commands.registerCommand('cgen.generateFromFile', () => generateFromCurrentFile(context))
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

  const panel = vscode.window.createWebviewPanel(
    'cgen.dslEditor',
    'CGen',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true
    }
  );

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

  panel.webview.html = getWebviewHtml(panel.webview, context.extensionUri, initialValue, initialCursor, initialScroll);
  if (currentFilePath) {
    panel.title = `CGen — ${path.basename(currentFilePath)}`;
  }

  let currentContent = initialValue;

  async function saveToFile() {
    if (currentFilePath) {
      await vscode.workspace.fs.writeFile(vscode.Uri.file(currentFilePath), Buffer.from(currentContent, 'utf8'));
    } else {
      const uri = await vscode.window.showSaveDialog({
        filters: { 'CGen DSL': ['cgen'] },
        defaultUri: vscode.Uri.joinPath(workspaceFolder!.uri, 'main.cgen')
      });
      if (uri) {
        currentFilePath = uri.fsPath;
        await vscode.workspace.fs.writeFile(uri, Buffer.from(currentContent, 'utf8'));
        const name = path.basename(uri.fsPath);
        panel.title = `CGen — ${name}`;
        await panel.webview.postMessage({ type: 'title', text: name });
        await saveSession(0, 0);
      }
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
  panel.onDidDispose(() => { saveEditorFn = undefined; });

  panel.webview.onDidReceiveMessage(async (message: { type: string; text?: string; cursor?: number; scrollTop?: number; id?: number }) => {
    if (message.type === 'expand') {
      await vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup');
      return;
    }

    if (message.type === 'change' && typeof message.text === 'string') {
      currentContent = message.text;
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceFolder.uri, '.cgen'));
      await vscode.workspace.fs.writeFile(scratchUri, Buffer.from(message.text, 'utf8'));
      if (typeof message.cursor === 'number') {
        await saveSession(message.cursor, message.scrollTop ?? 0);
      }
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
        candidates: suggestion?.candidates ?? []
      });
      return;
    }

    if (message.type === 'save') {
      if (typeof message.text === 'string') { currentContent = message.text; }
      await saveToFile();
      return;
    }

    if (message.type === 'load') {
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
        await saveSession(0, 0);
      }
      return;
    }

    if (message.type !== 'generate' || typeof message.text !== 'string') {
      return;
    }

    try {
      const files = await generateDsl(workspaceFolder, context.extensionUri, message.text);
      await panel.webview.postMessage({ type: 'error', lines: [] });
      vscode.window.showInformationMessage(`CGen generated ${files.length} file(s).`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await panel.webview.postMessage({ type: 'error', lines: parseErrorLineNumbers(msg) });
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
    const files = await generateDsl(workspaceFolder, context.extensionUri, editor.document.getText());
    vscode.window.showInformationMessage(`CGen generated ${files.length} file(s).`);
  } catch (error) {
    vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

function isCgenDocument(document: vscode.TextDocument): boolean {
  return document.languageId === 'cgen' && document.uri.fsPath.toLowerCase().endsWith('.cgen');
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
    return await CgenProjectIndex.create(context, workspaceFolder);
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

function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, value: string, cursor = 0, scrollTop = 0): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'dslEditor.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'dslEditor.css'));
  const nonce = createNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
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
    <div class="editor" aria-label="CGen DSL editor">
      <div id="stripes" aria-hidden="true"></div>
      <div id="errorLines" aria-hidden="true"></div>
      <div id="activeLine" aria-hidden="true"></div>
      <pre id="lineNumbers" aria-hidden="true"></pre>
      <pre id="highlight" aria-hidden="true"></pre>
      <pre id="suggestion" aria-hidden="true"></pre>
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
  <script nonce="${nonce}">window.__cgenCursor=${cursor};window.__cgenScroll=${scrollTop};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
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

function parseErrorLineNumbers(message: string): number[] {
  const lines = new Set<number>();
  const pattern = /^Line (\d+):/gm;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(message)) !== null) {
    lines.add(parseInt(match[1], 10));
  }

  return [...lines];
}
