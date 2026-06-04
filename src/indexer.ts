import * as path from 'path';
import * as vscode from 'vscode';
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
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
  onBusyChange?: (active: boolean) => void;
  onSourceChanged?: () => void;

  private constructor(
    private readonly sql: SqlJsStatic,
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceFolder: vscode.WorkspaceFolder
  ) {
    this.dbUri = vscode.Uri.joinPath(workspaceFolder.uri, '.cgen', 'index.sqlite');
  }

  static async create(context: vscode.ExtensionContext, workspaceFolder: vscode.WorkspaceFolder): Promise<CgenProjectIndex> {
    const sql = await initSqlJs({
      locateFile: (file) => path.join(context.extensionPath, 'out', 'sqljs', file)
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

  getSuggestionUsage(contextKey: string, prefix: string): SuggestionUsageRecord[] {
    const db = this.ensureDb();
    return queryRows(
      db,
      `SELECT label, kind, accepted_count, shown_count, last_accepted_at
       FROM suggestion_usage
       WHERE context_key = ? AND (prefix = ? OR prefix = '')
       ORDER BY accepted_count DESC, last_accepted_at DESC
       LIMIT 80`,
      [contextKey, prefix]
    ).map((row) => ({
      label: String(row.label),
      kind: String(row.kind),
      acceptedCount: Number(row.accepted_count || 0),
      shownCount: Number(row.shown_count || 0),
      lastAcceptedAt: String(row.last_accepted_at || '')
    }));
  }

  recordSuggestionAccepted(contextKey: string, prefix: string, label: string, kind: string): void {
    const db = this.ensureDb();
    db.run(
      `INSERT INTO suggestion_usage(label, kind, context_key, prefix, accepted_count, shown_count, last_accepted_at)
       VALUES (?, ?, ?, ?, 1, 0, ?)
       ON CONFLICT(label, kind, context_key, prefix) DO UPDATE SET
         accepted_count = accepted_count + 1,
         last_accepted_at = excluded.last_accepted_at`,
      [label, kind, contextKey, prefix, new Date().toISOString()]
    );
    this.queueSave();
  }

  updateFromArtifacts(root: SectionNode): void {
    const db = this.ensureDb();
    db.run('BEGIN');
    try {
      db.run('DELETE FROM sections');
      db.run('DELETE FROM symbols');

      const walkSection = (node: SectionNode, pathParts: string[]): void => {
        if (node.kind !== 'root') {
          const publicPath = makePublicPath(pathParts);
          const publicParentPath = makePublicPath(pathParts.slice(0, -1));
          if (publicPath.join('.') !== publicParentPath.join('.')) {
            db.run(
              'INSERT INTO sections(kind, name, path, parent_path) VALUES (?, ?, ?, ?)',
              [node.kind, node.name, publicPath.join('.'), publicParentPath.join('.')]
            );
          }
        }

        const symbolParentPath = makePublicPath(pathParts).join('.');

        for (const alias of node.aliases) {
          db.run(
            'INSERT INTO symbols(kind, name, path, parent_path, params) VALUES (?, ?, ?, ?, ?)',
            ['alias', alias.name, makePublicPath([...pathParts, alias.name]).join('.'), symbolParentPath, '']
          );
        }

        for (const enumNode of node.enums) {
          db.run(
            'INSERT INTO symbols(kind, name, path, parent_path, params) VALUES (?, ?, ?, ?, ?)',
            ['enum', enumNode.name, makePublicPath([...pathParts, enumNode.name]).join('.'), symbolParentPath, '']
          );
        }

        for (const template of node.templates) {
          db.run(
            'INSERT INTO symbols(kind, name, path, parent_path, params) VALUES (?, ?, ?, ?, ?)',
            ['template', template.name, makePublicPath([...pathParts, template.name]).join('.'), symbolParentPath, template.params.map((p) => p.name).join(',')]
          );
        }

        for (const struct of node.structs) {
          const structPath = makePublicPath([...pathParts, struct.name]);
          db.run(
            'INSERT INTO symbols(kind, name, path, parent_path, params) VALUES (?, ?, ?, ?, ?)',
            ['struct', struct.name, structPath.join('.'), symbolParentPath, '']
          );
          for (const fn of struct.fns) {
            db.run(
              'INSERT INTO symbols(kind, name, path, parent_path, params) VALUES (?, ?, ?, ?, ?)',
              ['fn', fn.name, [...structPath, fn.name].join('.'), structPath.join('.'), fn.params.map((p) => p.name).join(',')]
            );
          }
        }

        for (const fn of node.fns) {
          db.run(
            'INSERT INTO symbols(kind, name, path, parent_path, params) VALUES (?, ?, ?, ?, ?)',
            ['fn', fn.name, makePublicPath([...pathParts, fn.name]).join('.'), symbolParentPath, fn.params.map((p) => p.name).join(',')]
          );
        }

        for (const child of node.children) {
          walkSection(child, [...pathParts, child.name]);
        }
      };

      walkSection(root, []);
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    }
    this.queueSave();
  }

  updateSymbolUsage(usage: SymbolUsageIndex): void {
    const db = this.ensureDb();
    db.run('BEGIN');
    try {
      db.run('DELETE FROM symbol_usage');
      for (const [symbolKey, refs] of usage.usedBy) {
        for (const { moduleId, count } of refs) {
          db.run(
            'INSERT INTO symbol_usage(symbol_key, used_by_module, use_count) VALUES (?, ?, ?)',
            [symbolKey, moduleId, count]
          );
        }
      }
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    }
    this.queueSave();
  }

  getSymbolUsedBy(symbolKey: string): Array<{ moduleId: string; count: number }> {
    const db = this.ensureDb();
    return queryRows(
      db,
      'SELECT used_by_module, use_count FROM symbol_usage WHERE symbol_key = ? ORDER BY use_count DESC',
      [symbolKey]
    ).map((row) => ({ moduleId: String(row.used_by_module), count: Number(row.use_count) }));
  }

  getModuleSymbolRefs(moduleId: string): Array<{ symbolKey: string; count: number }> {
    const db = this.ensureDb();
    return queryRows(
      db,
      'SELECT symbol_key, use_count FROM symbol_usage WHERE used_by_module = ? ORDER BY use_count DESC',
      [moduleId]
    ).map((row) => ({ symbolKey: String(row.symbol_key), count: Number(row.use_count) }));
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

    try {
      const bytes = await vscode.workspace.fs.readFile(this.dbUri);
      this.db = new this.sql.Database(bytes);
    } catch {
      this.db = new this.sql.Database();
    }

    // Drop derived tables so schema changes take effect; suggestion_usage is preserved.
    const db = this.db;
    db.run('DROP TABLE IF EXISTS sections');
    db.run('DROP TABLE IF EXISTS symbols');
    db.run('DROP TABLE IF EXISTS symbol_usage');
    db.run('DROP INDEX IF EXISTS idx_sections_path');
    db.run('DROP INDEX IF EXISTS idx_sections_parent');
    db.run('DROP INDEX IF EXISTS idx_symbols_path');
    db.run('DROP INDEX IF EXISTS idx_symbols_parent');
    db.run('DROP INDEX IF EXISTS idx_symbol_usage_key');
    db.run('DROP INDEX IF EXISTS idx_symbol_usage_module');

    this.createSchema();
    this.startWatcher();
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

  private createSchema(): void {
    const db = this.ensureDb();
    db.run(`
      CREATE TABLE IF NOT EXISTS sections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        parent_path TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        parent_path TEXT NOT NULL,
        params TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS suggestion_usage (
        label TEXT NOT NULL,
        kind TEXT NOT NULL,
        context_key TEXT NOT NULL,
        prefix TEXT NOT NULL DEFAULT '',
        accepted_count INTEGER NOT NULL DEFAULT 0,
        shown_count INTEGER NOT NULL DEFAULT 0,
        last_accepted_at TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(label, kind, context_key, prefix)
      );
      CREATE TABLE IF NOT EXISTS symbol_usage (
        symbol_key TEXT NOT NULL,
        used_by_module TEXT NOT NULL,
        use_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(symbol_key, used_by_module)
      );
      CREATE INDEX IF NOT EXISTS idx_sections_path ON sections(path);
      CREATE INDEX IF NOT EXISTS idx_sections_parent ON sections(parent_path);
      CREATE INDEX IF NOT EXISTS idx_symbols_path ON symbols(path);
      CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parent_path);
      CREATE INDEX IF NOT EXISTS idx_suggestion_usage_context ON suggestion_usage(context_key, prefix);
      CREATE INDEX IF NOT EXISTS idx_symbol_usage_key ON symbol_usage(symbol_key);
      CREATE INDEX IF NOT EXISTS idx_symbol_usage_module ON symbol_usage(used_by_module);
    `);
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

  private ensureDb(): Database {
    if (!this.db) {
      this.db = new this.sql.Database();
      this.createSchema();
    }
    return this.db;
  }
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

function queryRows(db: Database, sql: string, params: unknown[] = []): Record<string, unknown>[] {
  if (params.length > 0) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params);
      const rows: Record<string, unknown>[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

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
