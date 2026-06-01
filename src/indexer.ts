import * as path from 'path';
import * as vscode from 'vscode';
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import { parseDsl, makePublicPath, type SectionKind, type SectionNode } from './parser';

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
  params: string;
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

    for (const row of queryRows(db, 'SELECT kind, name, path, parent_path, params FROM symbols ORDER BY path')) {
      const parent = findOrCreatePath(root, splitPath(String(row.parent_path)));
      const symbol = {
        kind: row.kind as SymbolKind,
        name: String(row.name),
        path: splitPath(String(row.path)),
        params: String(row.params || '').split(',').filter(Boolean)
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
          .filter((symbol) => symbol.kind === 'alias' || symbol.kind === 'enum' || symbol.kind === 'struct')
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
    await this.indexBuiltinPackages();
    await this.indexWorkspaceFiles();
    await this.save();
    this.startWatcher();
  }

  private async indexBuiltinPackages(): Promise<void> {
    const packagesUri = vscode.Uri.joinPath(this.context.extensionUri, 'packages');
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(packagesUri);
    } catch {
      return;
    }

    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.endsWith('.cgen')) {
        continue;
      }
      const fileUri = vscode.Uri.joinPath(packagesUri, name);
      const bytes = await vscode.workspace.fs.readFile(fileUri);
      this.replaceSource(`__builtin__/${name}`, Buffer.from(bytes).toString('utf8'));
    }
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
    const records = extractRecords(text, sourcePath);
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
          'INSERT INTO symbols(kind, name, path, parent_path, source_path, line, params) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [symbol.kind, symbol.name, symbol.path, symbol.parentPath, symbol.sourcePath, symbol.line, symbol.params]
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
        line INTEGER NOT NULL,
        params TEXT NOT NULL DEFAULT ''
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

function extractRecords(text: string, sourcePath: string): { sections: SectionRecord[]; symbols: SymbolRecord[] } {
  const sections: SectionRecord[] = [];
  const symbols: SymbolRecord[] = [];

  const { root } = parseDsl(text);

  function walkSection(node: SectionNode, pathParts: string[]): void {
    if (node.kind !== 'root') {
      const publicPath = makePublicPath(pathParts);
      const publicParentPath = makePublicPath(pathParts.slice(0, -1));
      if (publicPath.join('.') !== publicParentPath.join('.')) {
        sections.push({
          kind: node.kind,
          name: node.name,
          path: publicPath.join('.'),
          parentPath: publicParentPath.join('.'),
          sourcePath,
          line: node.line
        });
      }
    }

    const symbolParentPath = makePublicPath(pathParts).join('.');

    for (const alias of node.aliases) {
      symbols.push({
        kind: 'alias',
        name: alias.name,
        path: makePublicPath([...pathParts, alias.name]).join('.'),
        parentPath: symbolParentPath,
        sourcePath,
        line: alias.line,
        params: ''
      });
    }

    for (const enumNode of node.enums) {
      symbols.push({
        kind: 'enum',
        name: enumNode.name,
        path: makePublicPath([...pathParts, enumNode.name]).join('.'),
        parentPath: symbolParentPath,
        sourcePath,
        line: enumNode.line,
        params: ''
      });
    }

    for (const template of node.templates) {
      symbols.push({
        kind: 'template',
        name: template.name,
        path: makePublicPath([...pathParts, template.name]).join('.'),
        parentPath: symbolParentPath,
        sourcePath,
        line: template.line,
        params: template.params.map((p) => p.name).join(',')
      });
    }

    for (const struct of node.structs) {
      const structPath = makePublicPath([...pathParts, struct.name]);
      symbols.push({
        kind: 'struct',
        name: struct.name,
        path: structPath.join('.'),
        parentPath: symbolParentPath,
        sourcePath,
        line: struct.line,
        params: ''
      });

      for (const fn of struct.fns) {
        symbols.push({
          kind: 'fn',
          name: fn.name,
          path: [...structPath, fn.name].join('.'),
          parentPath: structPath.join('.'),
          sourcePath,
          line: fn.line,
          params: fn.params.map((p) => p.name).join(',')
        });
      }
    }

    for (const fn of node.fns) {
      symbols.push({
        kind: 'fn',
        name: fn.name,
        path: makePublicPath([...pathParts, fn.name]).join('.'),
        parentPath: symbolParentPath,
        sourcePath,
        line: fn.line,
        params: fn.params.map((p) => p.name).join(',')
      });
    }

    for (const child of node.children) {
      walkSection(child, [...pathParts, child.name]);
    }
  }

  walkSection(root, []);
  return { sections, symbols };
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

function sortUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function reportIndexError(error: unknown): void {
  vscode.window.showWarningMessage(`CGen index: ${error instanceof Error ? error.message : String(error)}`);
}
