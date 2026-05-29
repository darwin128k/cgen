import * as path from 'path';
import * as vscode from 'vscode';
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';

type SectionKind = 'root' | 'package' | 'module' | 'scope';
type SymbolKind = 'alias' | 'enum' | 'template';

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
}

export interface IndexedDsl {
  root: IndexedNode;
  symbols: IndexedSymbol[];
  typeNames: string[];
}

interface SectionRecord {
  kind: SectionKind;
  name: string;
  path: string;
  parentPath: string;
  sourcePath: string;
  line: number;
}

interface SymbolRecord {
  kind: SymbolKind;
  name: string;
  path: string;
  parentPath: string;
  sourcePath: string;
  line: number;
}

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
  private db: Database | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  private readonly dbUri: vscode.Uri;

  private constructor(
    private readonly sql: SqlJsStatic,
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceFolder: vscode.WorkspaceFolder
  ) {
    this.dbUri = vscode.Uri.joinPath(workspaceFolder.uri, '.cgen', 'index.sqlite');
  }

  static async create(context: vscode.ExtensionContext, workspaceFolder: vscode.WorkspaceFolder): Promise<CgenProjectIndex> {
    const sql = await initSqlJs({
      locateFile: (file) => path.join(context.extensionPath, 'node_modules', 'sql.js', 'dist', file)
    });
    const index = new CgenProjectIndex(sql, context, workspaceFolder);
    await index.initialize();
    return index;
  }

  dispose(): void {
    this.watcher?.dispose();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.save().catch(() => undefined);
    this.db?.close();
  }

  async indexVirtualText(text: string): Promise<void> {
    this.ensureDb();
    this.replaceSource('__editor__', text);
  }

  getSnapshot(): IndexedDsl {
    const db = this.ensureDb();
    const root = createNode('root', '', []);
    const symbols: IndexedSymbol[] = [];

    for (const row of queryRows(db, 'SELECT kind, name, path, parent_path FROM sections ORDER BY path')) {
      const pathParts = splitPath(String(row.path));
      if (pathParts.length === 0) {
        continue;
      }

      const parent = findOrCreatePath(root, splitPath(String(row.parent_path)));
      findOrCreateChild(parent, row.kind as SectionKind, String(row.name), pathParts);
    }

    for (const row of queryRows(db, 'SELECT kind, name, path, parent_path FROM symbols ORDER BY path')) {
      const parent = findOrCreatePath(root, splitPath(String(row.parent_path)));
      const symbol = {
        kind: row.kind as SymbolKind,
        name: String(row.name),
        path: splitPath(String(row.path))
      };
      if (!parent.symbols.some((item) => item.kind === symbol.kind && item.path.join('.') === symbol.path.join('.'))) {
        parent.symbols.push(symbol);
      }
      symbols.push(symbol);
    }

    return {
      root,
      symbols,
      typeNames: sortUnique([
        ...builtinTypes,
        ...symbols
          .filter((symbol) => symbol.kind === 'alias' || symbol.kind === 'enum')
          .map((symbol) => symbol.path.join('.'))
      ])
    };
  }

  private async initialize(): Promise<void> {
    const configUri = vscode.Uri.joinPath(this.workspaceFolder.uri, 'cgen.json');
    try {
      await vscode.workspace.fs.stat(configUri);
    } catch {
      this.db = new this.sql.Database();
      this.createSchema();
      return;
    }

    const dir = vscode.Uri.joinPath(this.workspaceFolder.uri, '.cgen');
    await vscode.workspace.fs.createDirectory(dir);
    try {
      await vscode.workspace.fs.delete(this.dbUri);
    } catch {
      // Fresh projects do not have an index yet.
    }

    this.db = new this.sql.Database();
    this.createSchema();
    this.addHistory('startup_reindex', 'clean');
    await this.indexWorkspaceFiles();
    await this.save();
    this.startWatcher();
  }

  private async indexWorkspaceFiles(): Promise<void> {
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(this.workspaceFolder, '**/*.cgen'),
      '**/{node_modules,out,build,dist,releases,.cgen}/**',
      256
    );

    for (const uri of files) {
      await this.indexFile(uri);
    }
  }

  private startWatcher(): void {
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.workspaceFolder, '**/*.cgen')
    );
    this.context.subscriptions.push(this.watcher);
    this.watcher.onDidCreate((uri) => this.indexFile(uri).catch(reportIndexError));
    this.watcher.onDidChange((uri) => this.indexFile(uri).catch(reportIndexError));
    this.watcher.onDidDelete((uri) => {
      this.deleteSource(this.relativePath(uri));
      this.queueSave();
    });
  }

  private async indexFile(uri: vscode.Uri): Promise<void> {
    if (this.relativePath(uri).startsWith('.cgen/')) {
      return;
    }

    const bytes = await vscode.workspace.fs.readFile(uri);
    this.replaceSource(this.relativePath(uri), Buffer.from(bytes).toString('utf8'));
    this.addHistory('index_file', this.relativePath(uri));
    this.queueSave();
  }

  private replaceSource(sourcePath: string, text: string): void {
    const db = this.ensureDb();
    const records = parseDslRecords(text, sourcePath);
    db.run('BEGIN');
    try {
      db.run('DELETE FROM sections WHERE source_path = ?', [sourcePath]);
      db.run('DELETE FROM symbols WHERE source_path = ?', [sourcePath]);
      for (const section of records.sections) {
        db.run(
          'INSERT INTO sections(kind, name, path, parent_path, source_path, line) VALUES (?, ?, ?, ?, ?, ?)',
          [section.kind, section.name, section.path, section.parentPath, section.sourcePath, section.line]
        );
      }
      for (const symbol of records.symbols) {
        db.run(
          'INSERT INTO symbols(kind, name, path, parent_path, source_path, line) VALUES (?, ?, ?, ?, ?, ?)',
          [symbol.kind, symbol.name, symbol.path, symbol.parentPath, symbol.sourcePath, symbol.line]
        );
      }
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    }
  }

  private deleteSource(sourcePath: string): void {
    const db = this.ensureDb();
    db.run('DELETE FROM sections WHERE source_path = ?', [sourcePath]);
    db.run('DELETE FROM symbols WHERE source_path = ?', [sourcePath]);
    this.addHistory('delete_file', sourcePath);
  }

  private createSchema(): void {
    const db = this.ensureDb();
    db.run(`
      CREATE TABLE IF NOT EXISTS sections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        parent_path TEXT NOT NULL,
        source_path TEXT NOT NULL,
        line INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        parent_path TEXT NOT NULL,
        source_path TEXT NOT NULL,
        line INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sections_path ON sections(path);
      CREATE INDEX IF NOT EXISTS idx_sections_parent ON sections(parent_path);
      CREATE INDEX IF NOT EXISTS idx_symbols_path ON symbols(path);
      CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parent_path);
    `);
  }

  private addHistory(event: string, detail: string): void {
    this.ensureDb().run(
      'INSERT INTO history(event, detail, created_at) VALUES (?, ?, ?)',
      [event, detail, new Date().toISOString()]
    );
  }

  private async save(): Promise<void> {
    if (!this.db) {
      return;
    }

    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.workspaceFolder.uri, '.cgen'));
    await vscode.workspace.fs.writeFile(this.dbUri, this.db.export());
  }

  private queueSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.save().catch(reportIndexError);
    }, 250);
  }

  private relativePath(uri: vscode.Uri): string {
    return path.relative(this.workspaceFolder.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
  }

  private ensureDb(): Database {
    if (!this.db) {
      this.db = new this.sql.Database();
      this.createSchema();
    }
    return this.db;
  }
}

function parseDslRecords(text: string, sourcePath: string): { sections: SectionRecord[]; symbols: SymbolRecord[] } {
  const sections: SectionRecord[] = [];
  const symbols: SymbolRecord[] = [];
  const stack: Array<{ indent: number; path: string[] }> = [{ indent: -1, path: [] }];

  for (const { line: rawLine, lineNumber } of expandInlineDsl(text)) {
    const withoutComment = rawLine.replace(/#.*$/, '').trimEnd();
    if (withoutComment.trim().length === 0) {
      continue;
    }

    const indent = withoutComment.match(/^\s*/)?.[0].length ?? 0;
    const line = withoutComment.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const parentPath = stack[stack.length - 1].path;
    const sectionMatch = line.match(/^(package|module|scope)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/);
    if (sectionMatch) {
      const pathParts = [...parentPath, sectionMatch[2]];
      sections.push({
        kind: sectionMatch[1] as SectionKind,
        name: sectionMatch[2],
        path: pathParts.join('.'),
        parentPath: parentPath.join('.'),
        sourcePath,
        line: lineNumber
      });
      stack.push({ indent, path: pathParts });
      continue;
    }

    const symbolMatch = line.match(/^(alias|enum|template)\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
    if (symbolMatch) {
      const pathParts = [...parentPath, symbolMatch[2]];
      symbols.push({
        kind: symbolMatch[1] as SymbolKind,
        name: symbolMatch[2],
        path: makePublicPath(pathParts).join('.'),
        parentPath: parentPath.join('.'),
        sourcePath,
        line: lineNumber
      });
    }
  }

  return { sections, symbols };
}

function expandInlineDsl(source: string): Array<{ line: string; lineNumber: number }> {
  const lines: Array<{ line: string; lineNumber: number }> = [];
  source.split(/\r?\n/).forEach((rawLine, rawIndex) => {
    const lineNumber = rawIndex + 1;
    const baseIndent = rawLine.match(/^\s*/)?.[0] ?? '';
    const trimmed = rawLine.trim();
    if (!trimmed || !/^(package|module|scope)\b/.test(trimmed)) {
      lines.push({ line: rawLine, lineNumber });
      return;
    }

    const parts = trimmed.split(/\s*:\s*/).filter(Boolean);
    if (parts.length <= 1) {
      lines.push({ line: rawLine, lineNumber });
      return;
    }

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const isSection = /^(package|module|scope)\s+[A-Za-z_][A-Za-z0-9_]*$/.test(part);
      const indent = `${baseIndent}${'    '.repeat(index)}`;
      lines.push({ line: `${indent}${part}${isSection ? ':' : ''}`, lineNumber });
    }
  });

  return lines;
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
  if (existing) {
    return existing;
  }

  const child = createNode(kind, name, nodePath);
  parent.children.push(child);
  return child;
}

function queryRows(db: Database, sql: string): Record<string, unknown>[] {
  const result = db.exec(sql)[0];
  if (!result) {
    return [];
  }

  return result.values.map((values) => Object.fromEntries(result.columns.map((column, index) => [column, values[index]])));
}

function splitPath(value: string): string[] {
  return value ? value.split('.').filter(Boolean) : [];
}

function makePublicPath(pathParts: string[]): string[] {
  const parts = [...pathParts];
  if (parts.length >= 2 && parts[parts.length - 1] === parts[parts.length - 2]) {
    parts.pop();
  }

  return parts;
}

function sortUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function reportIndexError(error: unknown): void {
  vscode.window.showWarningMessage(`CGen index: ${error instanceof Error ? error.message : String(error)}`);
}
