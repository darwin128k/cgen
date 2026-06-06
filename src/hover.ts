import * as vscode from 'vscode';
import type { CgenProjectIndex } from './indexer';
import type { SectionNode, AliasNode, EnumNode, StructNode, FnNode, LetNode, FnParam, Attribute } from './parser';

type FoundNode =
  | { kind: 'alias'; node: AliasNode }
  | { kind: 'enum'; node: EnumNode }
  | { kind: 'struct'; node: StructNode }
  | { kind: 'fn'; node: FnNode; parent?: StructNode }
  | { kind: 'let'; node: LetNode };

export interface HoverData {
  code: string;
  doc?: string;
  qualifiedPath: string;
  file?: string;
}

export function getHoverData(
  projectIndex: CgenProjectIndex,
  text: string,
  cursor: number
): HoverData | undefined {
  const identifier = getIdentifierAtOffset(text, cursor);
  if (!identifier) { return undefined; }

  const index = projectIndex.getSnapshot();
  let symbol = index.symbols.find((s) => s.path.join('.') === identifier);
  if (!symbol) {
    const name = identifier.split('.').pop()!;
    symbol = index.symbols.find((s) => s.name === name);
  }
  if (!symbol) { return undefined; }

  const symbolPath = symbol.path.join('.');
  const def = projectIndex.findSymbolDefinition(symbolPath);
  const qualifiedPath = symbolPath;
  const file = def?.relativePath ?? undefined;

  if (!def) {
    return { ...formatBasicData(symbol), qualifiedPath };
  }

  const found = walkToSymbol(def.root, symbol.path);
  return found
    ? { ...formatNodeData(found), qualifiedPath, file }
    : { ...formatBasicData(symbol), qualifiedPath, file };
}

export function createHoverInfo(
  projectIndex: CgenProjectIndex,
  document: vscode.TextDocument,
  position: vscode.Position
): vscode.Hover | undefined {
  const cursor = document.offsetAt(position);
  const data = getHoverData(projectIndex, document.getText(), cursor);
  if (!data) { return undefined; }

  const md = new vscode.MarkdownString();
  const fileLabel = data.file ? `  \`${data.file}\`` : '';
  md.appendMarkdown(`**${data.qualifiedPath}**${fileLabel}\n\n`);
  md.appendCodeblock(data.code, 'cgen');
  if (data.doc) { md.appendMarkdown(`\n\n${data.doc}`); }
  return new vscode.Hover(md);
}

function getIdentifierAtOffset(text: string, cursor: number): string | undefined {
  const lineStart = text.lastIndexOf('\n', cursor - 1) + 1;
  const lineEndRaw = text.indexOf('\n', cursor);
  const line = text.slice(lineStart, lineEndRaw === -1 ? text.length : lineEndRaw);
  const char = cursor - lineStart;

  const withoutComment = line.replace(/#.*$/, '');
  if (char > withoutComment.length) { return undefined; }

  const pattern = /[A-Za-z_][A-Za-z0-9_.]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(withoutComment)) !== null) {
    const end = match.index + match[0].length;
    if (match.index <= char && char <= end) {
      return match[0].replace(/\.+$/, '');
    }
  }
  return undefined;
}

function walkToSymbol(root: SectionNode, path: string[]): FoundNode | undefined {
  let current: SectionNode = root;
  let i = 0;

  while (i < path.length) {
    const child = current.children.find((c) => c.name === path[i]);
    if (child) { current = child; i++; continue; }
    break;
  }

  const remaining = path.slice(i);
  if (remaining.length === 1) {
    const name = remaining[0];
    const alias = current.aliases.find((a) => a.name === name);
    if (alias) { return { kind: 'alias', node: alias }; }
    const en = current.enums.find((e) => e.name === name);
    if (en) { return { kind: 'enum', node: en }; }
    const st = current.structs.find((s) => s.name === name);
    if (st) { return { kind: 'struct', node: st }; }
    const fn = current.fns.find((f) => f.name === name);
    if (fn) { return { kind: 'fn', node: fn }; }
    const lt = current.lets.find((l) => l.name === name);
    if (lt) { return { kind: 'let', node: lt }; }
  } else if (remaining.length === 2) {
    const st = current.structs.find((s) => s.name === remaining[0]);
    if (st) {
      const fn = st.fns.find((f) => f.name === remaining[1]);
      if (fn) { return { kind: 'fn', node: fn, parent: st }; }
    }
  }
  return undefined;
}

function getDoc(attributes: Attribute[]): string | undefined {
  const attr = attributes.find((a) => a.name === 'doc' || a.name === 'brief');
  return attr?.args[0];
}

function formatParam(p: FnParam): string {
  if (p.variadic) { return `... as ${p.name}`; }
  return p.type === 'any' ? p.name : `${p.name} as ${p.type}`;
}

type PartialHoverData = { code: string; doc?: string };

function formatNodeData(found: FoundNode): PartialHoverData {
  switch (found.kind) {
    case 'alias':
      return {
        code: `alias ${found.node.name} as ${found.node.target}`,
        doc: getDoc(found.node.attributes)
      };
    case 'enum': {
      const lines = [`enum ${found.node.name} as ${found.node.target}:`];
      for (const m of found.node.members) {
        lines.push(`    case ${m.name}${m.value !== undefined ? ` = ${m.value}` : ''}`);
      }
      return { code: lines.join('\n'), doc: getDoc(found.node.attributes) };
    }
    case 'struct': {
      const typeParams = found.node.params.length > 0
        ? `(${found.node.params.map((p) => p.name).join(', ')})`
        : '';
      const lines = [`struct ${found.node.name}${typeParams}:`];
      for (const f of found.node.fields) {
        lines.push(`    field ${f.name} as ${f.target}`);
      }
      return { code: lines.join('\n'), doc: getDoc(found.node.attributes) };
    }
    case 'fn': {
      const params = found.node.params.map(formatParam).join(', ');
      const ret = found.node.returnType && found.node.returnType !== 'none' && found.node.returnType !== 'auto'
        ? ` -> ${found.node.returnType}`
        : '';
      const scope = found.parent ? ` [${found.parent.name}]` : '';
      return {
        code: `fn ${found.node.name}(${params})${ret}${scope}`,
        doc: getDoc(found.node.attributes)
      };
    }
    case 'let':
      return {
        code: `let ${found.node.name} as ${found.node.type}`,
        doc: getDoc(found.node.attributes)
      };
  }
}

function formatBasicData(symbol: { kind: string; name: string; params: string[] }): PartialHoverData {
  switch (symbol.kind) {
    case 'struct': {
      const p = symbol.params.length > 0 ? `(${symbol.params.join(', ')})` : '';
      return { code: `struct ${symbol.name}${p}` };
    }
    case 'fn': {
      const p = symbol.params.length > 0 ? symbol.params.join(', ') : '';
      return { code: `fn ${symbol.name}(${p})` };
    }
    default:
      return { code: `${symbol.kind} ${symbol.name}` };
  }
}
