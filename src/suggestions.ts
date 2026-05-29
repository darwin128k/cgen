import { CgenProjectIndex } from './indexer';

export interface SuggestionRequest {
  text: string;
  cursor: number;
}

export interface SuggestionResult {
  insertText: string;
  candidates: string[];
}

type SectionKind = 'root' | 'package' | 'module' | 'scope';
type SymbolKind = 'alias' | 'enum' | 'template' | 'record';

interface DslNode {
  kind: SectionKind;
  name: string;
  path: string[];
  children: DslNode[];
  symbols: DslSymbol[];
}

interface DslSymbol {
  kind: SymbolKind;
  name: string;
  path: string[];
}

interface DslIndex {
  root: DslNode;
  symbols: DslSymbol[];
  typeNames: string[];
}

interface LineRange {
  before: string;
  after: string;
  lineStart: number;
}

interface CurrentTemplate {
  params: string[];
  excludeNames: string[];
}

const builtinTemplates = [
  'c.array',
  'c.const',
  'c.func',
  'c.ptr',
  'c.struct',
  'c.union',
  'c.volatile'
];

const snippets = [
  '@emit(header)',
  '@emit(source)',
  '@emit(both)',
  '@enum(static)',
  '@enum(define)',
  '@enum(extern)',
  'package name:',
  'module name:',
  'scope name:',
  'alias name as c.int',
  'enum name as c.int:',
  'case name',
  'template name:',
  'param name',
  'param ... as values',
  'field name as type',
  'use c.ptr(value)'
];

const declarationSnippets = [
  'alias name as type',
  'enum name as type:',
  'template name:',
  'param name',
  'param ... as values',
  'field name as type'
];

export async function createDslSuggestion(
  projectIndex: CgenProjectIndex,
  request: SuggestionRequest
): Promise<SuggestionResult | undefined> {
  if (request.cursor < 0 || request.cursor > request.text.length) {
    return undefined;
  }

  const lineRange = getCurrentLineRange(request.text, request.cursor);
  if (lineRange.after.trim().length > 0 && lineRange.after.trim() !== ':') {
    return undefined;
  }

  const linePrefix = lineRange.before;
  if (linePrefix.trim().length === 0) {
    return undefined;
  }

  await projectIndex.indexVirtualText(request.text);
  const index = projectIndex.getSnapshot();
  const context = findCurrentContext(request.text.slice(0, lineRange.lineStart));
  const currentTemplate = findCurrentTemplate(request.text.slice(0, lineRange.lineStart));
  const matches = pickSuggestions(linePrefix, context, currentTemplate, index);
  if (!matches.length) {
    return undefined;
  }

  const tailToken = linePrefix.trimStart().match(/(@?[A-Za-z_][A-Za-z0-9_.]*)?$/)?.[0] ?? '';
  return {
    insertText: matches[0].slice(linePrefix.length),
    candidates: matches.map((m) => `${tailToken}${m.slice(linePrefix.length)}`)
  };
}

function getCurrentLineRange(text: string, cursor: number): LineRange {
  const lineStart = text.lastIndexOf('\n', cursor - 1) + 1;
  const lineEnd = text.indexOf('\n', cursor);
  return {
    before: text.slice(lineStart, cursor),
    after: text.slice(cursor, lineEnd === -1 ? text.length : lineEnd),
    lineStart
  };
}

function findCurrentContext(textBeforeLine: string): string[] {
  const stack: string[][] = [[]];

  for (const rawLine of expandInlineDsl(textBeforeLine).split(/\r?\n/)) {
    const withoutComment = rawLine.replace(/#.*$/, '').trimEnd();
    if (withoutComment.trim().length === 0) {
      continue;
    }

    const indent = withoutComment.match(/^\s*/)?.[0].length ?? 0;
    const line = withoutComment.trim();
    const sectionMatch = line.match(/^(package|module|scope)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/);
    if (!sectionMatch) {
      continue;
    }

    const level = Math.floor(indent / 4) + 1;
    stack.length = Math.max(1, level);
    stack[level] = [...(stack[level - 1] ?? []), sectionMatch[2]];
  }

  return stack[stack.length - 1] ?? [];
}

function findCurrentTemplate(textBeforeLine: string): CurrentTemplate {
  const sectionStack: Array<{ indent: number; path: string[] }> = [{ indent: -1, path: [] }];
  let currentTemplate: { indent: number; name: string; path: string[]; params: string[] } | undefined;

  for (const rawLine of expandInlineDsl(textBeforeLine).split(/\r?\n/)) {
    const withoutComment = rawLine.replace(/#.*$/, '').trimEnd();
    if (withoutComment.trim().length === 0) {
      continue;
    }

    const indent = withoutComment.match(/^\s*/)?.[0].length ?? 0;
    const line = withoutComment.trim();
    if (currentTemplate && indent <= currentTemplate.indent) {
      currentTemplate = undefined;
    }

    while (sectionStack.length > 1 && indent <= sectionStack[sectionStack.length - 1].indent) {
      sectionStack.pop();
    }

    const sectionMatch = line.match(/^(package|module|scope)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/);
    if (sectionMatch) {
      const parentPath = sectionStack[sectionStack.length - 1].path;
      sectionStack.push({ indent, path: [...parentPath, sectionMatch[2]] });
      continue;
    }

    const templateMatch = line.match(/^template\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*$/);
    if (templateMatch) {
      currentTemplate = {
        indent,
        name: templateMatch[1],
        path: [...sectionStack[sectionStack.length - 1].path, templateMatch[1]],
        params: []
      };
      continue;
    }

    if (!currentTemplate) {
      continue;
    }

    const variadicParam = line.match(/^param\s+\.\.\.\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/);
    const normalParam = line.match(/^param\s+([A-Za-z_][A-Za-z0-9_]*)$/);
    const paramName = variadicParam?.[1] ?? normalParam?.[1];
    if (paramName) {
      currentTemplate.params.push(paramName);
    }
  }

  if (!currentTemplate) {
    return { params: [], excludeNames: [] };
  }

  return {
    params: currentTemplate.params,
    excludeNames: [currentTemplate.name, makePublicPath(currentTemplate.path).join('.')]
  };
}

function expandInlineDsl(source: string): string {
  const lines: string[] = [];

  for (const rawLine of source.split(/\r?\n/)) {
    const baseIndent = rawLine.match(/^\s*/)?.[0] ?? '';
    const trimmed = rawLine.trim();
    if (!trimmed || !/^(package|module|scope)\b/.test(trimmed)) {
      lines.push(rawLine);
      continue;
    }

    const parts = trimmed.split(/\s*:\s*/).filter(Boolean);
    if (parts.length <= 1) {
      lines.push(rawLine);
      continue;
    }

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const isSection = /^(package|module|scope)\s+[A-Za-z_][A-Za-z0-9_]*$/.test(part);
      const indent = `${baseIndent}${'    '.repeat(index)}`;
      lines.push(`${indent}${part}${isSection ? ':' : ''}`);
    }
  }

  return lines.join('\n');
}

function walk(node: DslNode, visit: (node: DslNode) => void): void {
  visit(node);
  for (const child of node.children) {
    walk(child, visit);
  }
}

function makePublicSymbolPath(symbol: DslSymbol): string[] {
  return makePublicPath(symbol.path);
}

function makePublicPath(path: string[]): string[] {
  const parts = [...path];
  if (parts.length >= 2 && parts[parts.length - 1] === parts[parts.length - 2]) {
    parts.pop();
  }

  return parts;
}

function sortUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function uniqueInOrder(values: string[]): string[] {
  return [...new Set(values)];
}

function pickSuggestions(linePrefix: string, contextPath: string[], currentTemplate: CurrentTemplate, index: DslIndex): string[] {
  const indent = linePrefix.match(/^\s*/)?.[0] ?? '';
  const typed = linePrefix.trimStart();
  const candidates = getCandidates(typed, contextPath, currentTemplate, index);
  return candidates
    .filter((candidate) => candidate.startsWith(typed) && candidate.length > typed.length)
    .slice(0, 5)
    .map((candidate) => `${indent}${candidate}`);
}

function getCandidates(typed: string, contextPath: string[], currentTemplate: CurrentTemplate, index: DslIndex): string[] {
  if (/^@/.test(typed)) {
    return snippets.filter((snippet) => snippet.startsWith('@'));
  }

  if (/^alias\s+\S+\s+as\s+/.test(typed)) {
    return completeTail(typed, getTypeCandidates(typed, contextPath, index));
  }

  if (/^enum\s+\S+\s+as\s+/.test(typed)) {
    return completeTail(typed, getTypeCandidates(typed, contextPath, index));
  }

  if (/^field\s+\S+\s+as\s+/.test(typed)) {
    return completeTail(typed, getTypeCandidates(typed, contextPath, index));
  }

  if (/^use\s+/.test(typed)) {
    if (isCompleteUseExpression(typed)) {
      return [];
    }

    if (isUseArgumentPosition(typed)) {
      return completeTail(typed, getUseArgumentCandidates(typed, contextPath, currentTemplate, index));
    }

    return completeTail(typed, getTemplateUseCandidates(typed, contextPath, currentTemplate, index));
  }

  if (/^(package|module|scope)\s+/.test(typed)) {
    return completeSectionName(typed, contextPath, index);
  }

  if (/^case\s+/.test(typed)) {
    return snippets.filter((snippet) => snippet.startsWith('case '));
  }

  if (/^(alias|enum|template|param|field)\b/.test(typed)) {
    return declarationSnippets;
  }

  return [
    ...getContextObjectCandidates(contextPath, index),
    ...snippets
  ];
}

function getContextObjectCandidates(contextPath: string[], index: DslIndex): string[] {
  const context = findNode(index.root, contextPath) ?? index.root;
  return [
    ...context.children
      .filter((child) => child.kind !== 'root')
      .map((child) => `${child.kind} ${child.name}:`)
  ];
}

function isCompleteUseExpression(typed: string): boolean {
  const body = typed.replace(/^use\s+/, '').trim();
  if (!body.endsWith(')')) {
    return false;
  }

  let depth = 0;
  for (const char of body) {
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
    }
  }

  return depth === 0 && /^[A-Za-z_][A-Za-z0-9_.]*\(.*\)$/.test(body);
}

function isUseArgumentPosition(typed: string): boolean {
  const body = typed.replace(/^use\s+/, '');
  let depth = 0;

  for (const char of body) {
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth = Math.max(0, depth - 1);
    }
  }

  return depth > 0;
}

function completeTail(typed: string, tails: string[]): string[] {
  const head = typed.replace(/[A-Za-z_][A-Za-z0-9_.]*$/, '');
  return tails.map((tail) => `${head}${tail}`);
}

function getTypeCandidates(typed: string, contextPath: string[], index: DslIndex): string[] {
  return getDottedCandidates(getTailToken(typed), contextPath, index, index.typeNames);
}

function getTemplateUseCandidates(
  typed: string,
  contextPath: string[],
  currentTemplate: CurrentTemplate,
  index: DslIndex
): string[] {
  const token = getTailToken(typed);
  if (token.includes('.')) {
    return getDottedTemplateUseCandidates(token, index, currentTemplate);
  }

  return getRootUseNamespaces(contextPath, index);
}

function getUseArgumentCandidates(
  typed: string,
  contextPath: string[],
  currentTemplate: CurrentTemplate,
  index: DslIndex
): string[] {
  const token = getTailToken(typed);
  if (token.includes('.')) {
    return getTemplateUseCandidates(typed, contextPath, currentTemplate, index);
  }

  return sortUnique([
    ...currentTemplate.params,
    ...getTemplateUseCandidates(typed, contextPath, currentTemplate, index)
  ]);
}

function getTailToken(typed: string): string {
  return typed.match(/[A-Za-z_][A-Za-z0-9_.]*$/)?.[0] ?? '';
}

function getDottedTemplateUseCandidates(token: string, index: DslIndex, currentTemplate: CurrentTemplate): string[] {
  const parentPath = token.split('.').slice(0, -1).filter(Boolean);
  const node = findNode(index.root, parentPath);
  if (!node) {
    return getAllUsePaths(index, currentTemplate).filter((name) => name.startsWith(token));
  }

  return getNodeTemplateUseMembers(node, `${parentPath.join('.')}.`, currentTemplate);
}

function getNodeTemplateUseMembers(node: DslNode, prefix: string, currentTemplate: CurrentTemplate): string[] {
  return uniqueInOrder([
    ...node.children.map((child) => `${prefix}${child.name}.`),
    ...node.symbols
      .filter((symbol) => symbol.kind === 'template')
      .map((symbol) => `${prefix}${symbol.name}`)
      .filter((name) => !currentTemplate.excludeNames.includes(name))
      .map((name) => `${name}()`)
  ]);
}

function getRootUseNamespaces(contextPath: string[], index: DslIndex): string[] {
  const currentPackage = contextPath[0];
  const projectRoots = index.root.children
    .filter((child) => child.kind !== 'root')
    .map((child) => `${child.name}.`);
  const externalRoots = projectRoots.filter((name) => name.replace(/\.$/, '') !== currentPackage);
  const currentRoot = currentPackage && projectRoots.includes(`${currentPackage}.`) ? [`${currentPackage}.`] : [];

  return uniqueInOrder([
    ...externalRoots,
    ...currentRoot,
    'c.'
  ]);
}

function getAllUsePaths(index: DslIndex, currentTemplate: CurrentTemplate): string[] {
  const result: string[] = [];
  walk(index.root, (node) => {
    if (node.kind !== 'root') {
      result.push(`${node.path.join('.')}.`);
    }

    for (const symbol of node.symbols) {
      if (symbol.kind !== 'template') {
        continue;
      }

      const name = makePublicSymbolPath(symbol).join('.');
      if (!currentTemplate.excludeNames.includes(name)) {
        result.push(`${name}()`);
      }
    }
  });

  return uniqueInOrder([
    ...result,
    ...builtinTemplates.map((name) => `${name}()`)
  ]);
}

function getDottedCandidates(token: string, contextPath: string[], index: DslIndex, fallback: string[]): string[] {
  if (token.includes('.')) {
    const parentPath = token.split('.').slice(0, -1).filter(Boolean);
    const node = findNode(index.root, parentPath);
    if (node) {
      const parentPrefix = parentPath.join('.');
      return getNodeMemberNames(node).map((name) => `${parentPrefix}.${name}`);
    }
  }

  const context = findNode(index.root, contextPath);
  return sortUnique([
    ...(context ? getNodeMemberNames(context) : []),
    ...fallback
  ]);
}

function getNodeMemberNames(node: DslNode): string[] {
  return sortUnique([
    ...node.children.map((child) => child.name),
    ...node.symbols.map((symbol) => symbol.name)
  ]);
}

function completeSectionName(typed: string, contextPath: string[], index: DslIndex): string[] {
  const keyword = typed.split(/\s+/, 1)[0] as SectionKind;
  const context = findNode(index.root, contextPath) ?? index.root;
  return context.children
    .filter((child) => child.kind === keyword)
    .map((child) => `${keyword} ${child.name}:`);
}

function findNode(root: DslNode, path: string[]): DslNode | undefined {
  let current: DslNode | undefined = root;
  for (const part of path) {
    current = current?.children.find((child) => child.name === part);
    if (!current) {
      return undefined;
    }
  }

  return current;
}
