import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { makePublicPath, type SectionKind, type SectionNode } from './parser';
import type { SymbolUsageIndex } from './cgen';

type SymbolKind = 'alias' | 'enum' | 'template' | 'struct' | 'fn';

export interface IndexedNode {
  kind: SectionKind;
  name: string;
  path: string[];
  children: IndexedNode[];
  symbols: IndexedSymbol[];
}

export interface IndexedSymbol {
  kind: SymbolKind;
  name: string;
  path: string[];
  params: string[];
}

export interface IndexedDsl {
  root: IndexedNode;
  symbols: IndexedSymbol[];
  typeNames: string[];
}

export interface SuggestionUsageRecord {
  label: string;
  kind: string;
  acceptedCount: number;
  shownCount: number;
  lastAcceptedAt: string;
}

export interface FileIndexEntry {
  relativePath: string | null;
  hash: string;
  root: SectionNode;
  diagnostics: string[];
}

interface StoredSection {
  kind: string;
  name: string;
  path: string;
  parentPath: string;
}

interface StoredSymbol {
  kind: string;
  name: string;
  path: string;
  parentPath: string;
  params: string;
}

interface FileCacheEntry {
  relativePath: string;
  hash: string;
  sections: StoredSection[];
  symbols: StoredSymbol[];
}

type SuggestionUsageMap = Record<string, SuggestionUsageRecord & { contextKey: string; prefix: string }>;

const ANON_PREFIX = '\0anon\0';

const builtinTypes = [
  'c.bool',
  'c.char',
  'c.double',
  'c.float',
  'c.int',
  'c.llong',
  'c.long',
  'c.ptr.of()',
  'c.schar',
  'c.short',
  'c.size',
  'c.sint',
  'c.slong',
  'c.sllong',
  'c.uchar',
  'c.uint',
  'c.ulong',
  'c.ullong',
  'c.ushort',
  'c.void'
];

export class CgenProjectIndex {
  private fileCache = new Map<string, FileCacheEntry>();
  private suggestionUsage = new Map<string, SuggestionUsageRecord & { contextKey: string; prefix: string }>();
  private symbolUsageData = new Map<string, Array<{ moduleId: string; count: number }>>();
  private symbolUsedInData = new Map<string, Array<{ symbolKey: string; count: number }>>();
  private watcher: vscode.FileSystemWatcher | undefined;
  private suggestionSaveTimer: NodeJS.Timeout | undefined;
  private symbolUsageSaveTimer: NodeJS.Timeout | undefined;
  private readonly cacheDir: vscode.Uri;
  onBusyChange?: (active: boolean) => void;
  onSourceChanged?: () => void;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceFolder: vscode.WorkspaceFolder
  ) {
    this.cacheDir = vscode.Uri.joinPath(workspaceFolder.uri, '.cgen', 'cache');
  }

  static async create(context: vscode.ExtensionContext, workspaceFolder: vscode.WorkspaceFolder): Promise<CgenProjectIndex> {
    const index = new CgenProjectIndex(context, workspaceFolder);
    await index.initialize();
    return index;
  }

  dispose(): void {
    this.watcher?.dispose();
    if (this.suggestionSaveTimer) { clearTimeout(this.suggestionSaveTimer); }
    if (this.symbolUsageSaveTimer) { clearTimeout(this.symbolUsageSaveTimer); }
  }

  getSnapshot(): IndexedDsl {
    const root = createNode('root', '', []);
    const symbols: IndexedSymbol[] = [];

    for (const entry of this.fileCache.values()) {
      for (const section of entry.sections) {
        const pathParts = splitPath(section.path);
        if (pathParts.length === 0) { continue; }
        const parent = findOrCreatePath(root, splitPath(section.parentPath));
        findOrCreateChild(parent, section.kind as SectionKind, section.name, pathParts);
      }
      for (const sym of entry.symbols) {
        const parent = findOrCreatePath(root, splitPath(sym.parentPath));
        const symbol: IndexedSymbol = {
          kind: sym.kind as SymbolKind,
          name: sym.name,
          path: splitPath(sym.path),
          params: sym.params.split(',').filter(Boolean)
        };
        if (!parent.symbols.some((s) => s.kind === symbol.kind && s.path.join('.') === symbol.path.join('.'))) {
          parent.symbols.push(symbol);
        }
        symbols.push(symbol);
      }
    }

    return {
      root,
      symbols,
      typeNames: sortUnique([
        ...builtinTypes,
        ...symbols
          .filter((s) => s.kind === 'alias' || s.kind === 'enum' || s.kind === 'struct')
          .map((s) => s.path.join('.'))
      ])
    };
  }

  getSuggestionUsage(contextKey: string, prefix: string): SuggestionUsageRecord[] {
    return [...this.suggestionUsage.values()]
      .filter((r) => r.contextKey === contextKey && (r.prefix === prefix || r.prefix === ''))
      .sort((a, b) => b.acceptedCount - a.acceptedCount || b.lastAcceptedAt.localeCompare(a.lastAcceptedAt))
      .slice(0, 80);
  }

  recordSuggestionAccepted(contextKey: string, prefix: string, label: string, kind: string): void {
    const key = `${contextKey}\0${prefix}\0${label}\0${kind}`;
    const existing = this.suggestionUsage.get(key);
    if (existing) {
      existing.acceptedCount++;
      existing.lastAcceptedAt = new Date().toISOString();
    } else {
      this.suggestionUsage.set(key, { label, kind, contextKey, prefix, acceptedCount: 1, shownCount: 0, lastAcceptedAt: new Date().toISOString() });
    }
    this.scheduleSave('suggestions');
  }

  updateFromFiles(files: FileIndexEntry[]): void {
    for (const key of [...this.fileCache.keys()]) {
      if (key.startsWith(ANON_PREFIX)) { this.fileCache.delete(key); }
    }

    const currentKeys = new Set<string>();
    for (const file of files) {
      const cacheKey = file.relativePath ?? `${ANON_PREFIX}${file.hash}`;
      currentKeys.add(cacheKey);

      const existing = this.fileCache.get(cacheKey);
      if (existing?.hash === file.hash) { continue; }

      const entry: FileCacheEntry = { relativePath: file.relativePath!, hash: file.hash, ...extractFromRoot(file.root) };
      this.fileCache.set(cacheKey, entry);

      if (file.relativePath) {
        this.saveCacheFile(entry).catch(reportIndexError);
      }
    }

    for (const key of [...this.fileCache.keys()]) {
      if (!key.startsWith(ANON_PREFIX) && !currentKeys.has(key)) {
        this.fileCache.delete(key);
        this.deleteCacheFile(key).catch(() => undefined);
      }
    }
  }

  updateSymbolUsage(usage: SymbolUsageIndex): void {
    this.symbolUsageData.clear();
    this.symbolUsedInData.clear();
    for (const [symbolKey, refs] of usage.usedBy) {
      const refList = refs.map((r) => ({ moduleId: r.moduleId, count: r.count }));
      this.symbolUsageData.set(symbolKey, refList);
      for (const { moduleId, count } of refList) {
        const arr = this.symbolUsedInData.get(moduleId) ?? [];
        arr.push({ symbolKey, count });
        this.symbolUsedInData.set(moduleId, arr);
      }
    }
    this.scheduleSave('symbolUsage');
  }

  getSymbolUsedBy(symbolKey: string): Array<{ moduleId: string; count: number }> {
    return this.symbolUsageData.get(symbolKey) ?? [];
  }

  getModuleSymbolRefs(moduleId: string): Array<{ symbolKey: string; count: number }> {
    return this.symbolUsedInData.get(moduleId) ?? [];
  }

  private async initialize(): Promise<void> {
    const configUri = vscode.Uri.joinPath(this.workspaceFolder.uri, 'cgen.json');
    try {
      await vscode.workspace.fs.stat(configUri);
    } catch {
      return;
    }
    await this.loadCaches();
    this.startWatcher();
  }

  private async loadCaches(): Promise<void> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.cacheDir);
      await Promise.all(
        entries
          .filter(([name, type]) =>
            type === vscode.FileType.File &&
            name !== 'suggestions.index' &&
            name !== 'symbols.index' &&
            name.endsWith('.index')
          )
          .map(async ([name]) => {
            try {
              const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.cacheDir, name));
              const data = JSON.parse(Buffer.from(bytes).toString('utf8')) as FileCacheEntry;
              if (data.relativePath) { this.fileCache.set(data.relativePath, data); }
            } catch { /* ignore corrupt cache */ }
          })
      );
    } catch { /* cache dir doesn't exist yet */ }

    await Promise.all([this.loadSuggestionUsage(), this.loadSymbolUsage()]);
  }

  private async loadSuggestionUsage(): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.cacheDir, 'suggestions.index'));
      const data = JSON.parse(Buffer.from(bytes).toString('utf8')) as SuggestionUsageMap;
      for (const [key, record] of Object.entries(data)) {
        this.suggestionUsage.set(key, record);
      }
    } catch { /* no file yet */ }
  }

  private async loadSymbolUsage(): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.cacheDir, 'symbols.index'));
      const data = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, Array<{ moduleId: string; count: number }>>;
      for (const [symbolKey, refs] of Object.entries(data)) {
        this.symbolUsageData.set(symbolKey, refs);
        for (const { moduleId, count } of refs) {
          const arr = this.symbolUsedInData.get(moduleId) ?? [];
          arr.push({ symbolKey, count });
          this.symbolUsedInData.set(moduleId, arr);
        }
      }
    } catch { /* no file yet */ }
  }

  private startWatcher(): void {
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.workspaceFolder, '**/*.cgen')
    );
    this.context.subscriptions.push(this.watcher);
    this.watcher.onDidCreate(() => this.onSourceChanged?.());
    this.watcher.onDidChange(() => this.onSourceChanged?.());
    this.watcher.onDidDelete(() => this.onSourceChanged?.());
  }

  private async saveCacheFile(entry: FileCacheEntry): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.cacheDir);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(this.cacheDir, cacheKeyToFileName(entry.relativePath)),
      Buffer.from(JSON.stringify(entry), 'utf8')
    );
  }

  private async deleteCacheFile(cacheKey: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.cacheDir, cacheKeyToFileName(cacheKey)));
    } catch { /* already gone */ }
  }

  private scheduleSave(type: 'suggestions' | 'symbolUsage'): void {
    if (type === 'suggestions') {
      if (this.suggestionSaveTimer) { clearTimeout(this.suggestionSaveTimer); }
      this.suggestionSaveTimer = setTimeout(() => { this.saveSuggestions().catch(reportIndexError); }, 250);
    } else {
      if (this.symbolUsageSaveTimer) { clearTimeout(this.symbolUsageSaveTimer); }
      this.symbolUsageSaveTimer = setTimeout(() => { this.saveSymbolUsage().catch(reportIndexError); }, 250);
    }
  }

  private async saveSuggestions(): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.cacheDir);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(this.cacheDir, 'suggestions.index'),
      Buffer.from(JSON.stringify(Object.fromEntries(this.suggestionUsage)), 'utf8')
    );
  }

  private async saveSymbolUsage(): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.cacheDir);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(this.cacheDir, 'symbols.index'),
      Buffer.from(JSON.stringify(Object.fromEntries(this.symbolUsageData)), 'utf8')
    );
  }
}

function cacheKeyToFileName(relativePath: string): string {
  const parts = relativePath.replace(/\\/g, '/').split('/');
  const module = parts[parts.length - 1].replace(/\.cgen$/, '');
  const pkg = parts.slice(0, -1).filter((p) => !p.startsWith('.')).join('.');
  return pkg ? `${pkg}.${module}.index` : `${module}.index`;
}

function extractFromRoot(root: SectionNode): { sections: StoredSection[]; symbols: StoredSymbol[] } {
  const sections: StoredSection[] = [];
  const symbols: StoredSymbol[] = [];

  const walk = (node: SectionNode, pathParts: string[]): void => {
    if (node.kind !== 'root') {
      const publicPath = makePublicPath(pathParts);
      const publicParentPath = makePublicPath(pathParts.slice(0, -1));
      if (publicPath.join('.') !== publicParentPath.join('.')) {
        sections.push({ kind: node.kind, name: node.name, path: publicPath.join('.'), parentPath: publicParentPath.join('.') });
      }
    }

    const symbolParentPath = makePublicPath(pathParts).join('.');

    for (const alias of node.aliases) {
      symbols.push({ kind: 'alias', name: alias.name, path: makePublicPath([...pathParts, alias.name]).join('.'), parentPath: symbolParentPath, params: '' });
    }
    for (const enumNode of node.enums) {
      symbols.push({ kind: 'enum', name: enumNode.name, path: makePublicPath([...pathParts, enumNode.name]).join('.'), parentPath: symbolParentPath, params: '' });
    }
    for (const template of node.templates) {
      symbols.push({ kind: 'template', name: template.name, path: makePublicPath([...pathParts, template.name]).join('.'), parentPath: symbolParentPath, params: template.params.map((p) => p.name).join(',') });
    }
    for (const struct of node.structs) {
      const structPath = makePublicPath([...pathParts, struct.name]);
      symbols.push({ kind: 'struct', name: struct.name, path: structPath.join('.'), parentPath: symbolParentPath, params: '' });
      for (const fn of struct.fns) {
        symbols.push({ kind: 'fn', name: fn.name, path: [...structPath, fn.name].join('.'), parentPath: structPath.join('.'), params: fn.params.map((p) => p.name).join(',') });
      }
    }
    for (const fn of node.fns) {
      symbols.push({ kind: 'fn', name: fn.name, path: makePublicPath([...pathParts, fn.name]).join('.'), parentPath: symbolParentPath, params: fn.params.map((p) => p.name).join(',') });
    }

    for (const child of node.children) {
      walk(child, [...pathParts, child.name]);
    }
  };

  walk(root, []);
  return { sections, symbols };
}

export function hashSource(source: string): string {
  return crypto.createHash('sha256').update(source).digest('hex');
}

function createNode(kind: SectionKind, name: string, nodePath: string[]): IndexedNode {
  return { kind, name, path: nodePath, children: [], symbols: [] };
}

function findOrCreatePath(root: IndexedNode, nodePath: string[]): IndexedNode {
  let current = root;
  const pathParts: string[] = [];
  for (const part of nodePath) {
    pathParts.push(part);
    current = findOrCreateChild(current, 'module', part, [...pathParts]);
  }
  return current;
}

function findOrCreateChild(parent: IndexedNode, kind: SectionKind, name: string, nodePath: string[]): IndexedNode {
  const existing = parent.children.find((child) => child.name === name);
  if (existing) { return existing; }
  const child = createNode(kind, name, nodePath);
  parent.children.push(child);
  return child;
}

function splitPath(value: string): string[] {
  return value ? value.split('.').filter(Boolean) : [];
}

function sortUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function reportIndexError(error: unknown): void {
  vscode.window.showWarningMessage(`CGen index: ${error instanceof Error ? error.message : String(error)}`);
}
