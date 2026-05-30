import { CgenProjectIndex } from './indexer';
import { knownTemplateBuiltins } from './clib';

export interface SuggestionRequest {
  text: string;
  cursor: number;
}

export interface SuggestionResult {
  insertText: string;
  candidates: string[];
}

type SectionKind = 'root' | 'package' | 'module' | 'scope' | 'extern';
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
  params: string[];
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
  callableParams: string[];
  excludeNames: string[];
}

const builtinTemplates = [
  'c.array',
  'c.const',
  'c.fn',
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
  '@fn(static)',
  '@fn(extern)',
  '@fn(inline)',
  '@fn(static, inline)',
  'package name:',
  'module name:',
  'scope name:',
  'alias name -> c.int',
  'enum name -> c.int:',
  'case name',
  'template name:',
  'template name():',
  'fn name() -> type:',
  'param name',
  'param ... -> values',
  'field name -> type',
  'use c.ptr(value)'
];

const declarationSnippets = [
  'alias name -> type',
  'enum name -> type:',
  'template name:',
  'template name():',
  'fn name() -> type:',
  'param name',
  'param name -> any',
  'param name -> template',
  'param ... -> values',
  'field name -> type'
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
  let currentTemplate: { indent: number; name: string; path: string[]; params: string[]; callableParams: string[] } | undefined;

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

    const templateMatch = line.match(/^template\s+([A-Za-z_][A-Za-z0-9_]*)(?:\(([^)]*)\))?\s*:\s*$/);
    if (templateMatch) {
      const params: string[] = [];
      const callableParams: string[] = [];
      if (templateMatch[2]) {
        for (const part of templateMatch[2].split(',')) {
          const trimmed = part.trim();
          const variadicM = trimmed.match(/^param\s+\.\.\.(?:\s+as\s+|\s+->\s*)([A-Za-z_][A-Za-z0-9_]*)$/);
          const normalM = trimmed.match(/^param\s+([A-Za-z_][A-Za-z0-9_]*)(?:(?:\s+as\s+|\s+->\s*)(\S+))?$/);
          const paramName = variadicM?.[1] ?? normalM?.[1];
          if (paramName) {
            params.push(paramName);
            if (normalM?.[2] === 'template') { callableParams.push(paramName); }
          }
        }
      }
      currentTemplate = {
        indent,
        name: templateMatch[1],
        path: [...sectionStack[sectionStack.length - 1].path, templateMatch[1]],
        params,
        callableParams
      };
      continue;
    }

    if (!currentTemplate) {
      continue;
    }

    const variadicParam = line.match(/^param\s+\.\.\.(?:\s+as\s+|\s+->\s*)([A-Za-z_][A-Za-z0-9_]*)$/);
    const normalParam = line.match(/^param\s+([A-Za-z_][A-Za-z0-9_]*)((?:\s+as\s+|\s+->\s*)(\S+))?$/);
    const paramName = variadicParam?.[1] ?? normalParam?.[1];
    if (paramName) {
      currentTemplate.params.push(paramName);
      if (normalParam?.[3] === 'template') {
        currentTemplate.callableParams.push(paramName);
      }
    }
  }

  if (!currentTemplate) {
    return { params: [], callableParams: [], excludeNames: [] };
  }

  return {
    params: currentTemplate.params,
    callableParams: currentTemplate.callableParams,
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
    .filter((candidate) => {
      if (candidate.startsWith(typed) && candidate.length > typed.length) { return true; }
      if (typed.endsWith('.')) {
        const withoutDot = typed.slice(0, -1);
        const tail = candidate.slice(withoutDot.length);
        return candidate.startsWith(withoutDot) && tail.length > 0 && !tail.startsWith('.');
      }
      return false;
    })
    .slice(0, 5)
    .map((candidate) => `${indent}${candidate}`);
}

function getCandidates(typed: string, contextPath: string[], currentTemplate: CurrentTemplate, index: DslIndex): string[] {
  if (/^@/.test(typed)) {
    return snippets.filter((snippet) => snippet.startsWith('@'));
  }

  if (/^alias\s+\S+(?:\s+as\s+|\s+->\s*)/.test(typed)) {
    return completeTail(typed, getTypeCandidates(typed, contextPath, index));
  }

  if (/^enum\s+\S+(?:\s+as\s+|\s+->\s*)/.test(typed)) {
    if (typed.trimEnd().endsWith(':')) return [];
    return completeTail(typed, getTypeCandidates(typed, contextPath, index));
  }

  if (/^field\s+\S+(?:\s+as\s+|\s+->\s*)/.test(typed)) {
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

  if (/^(package|module|scope|extern)\s+/.test(typed)) {
    return completeSectionName(typed, contextPath, index);
  }

  if (/^case\s+/.test(typed)) {
    return snippets.filter((snippet) => snippet.startsWith('case '));
  }

  if (/^template\s+[A-Za-z_][A-Za-z0-9_]*\(/.test(typed)) {
    return getInlineParamCandidates(typed);
  }

  if (/^fn\s+[A-Za-z_][A-Za-z0-9_]*\([^)]*\)\s*(?:as\s+|->\s*)/.test(typed)) {
    return completeTail(typed, getTypeCandidates(typed, contextPath, index));
  }

  if (/^fn\s+[A-Za-z_][A-Za-z0-9_]*\(/.test(typed)) {
    return getInlineParamCandidates(typed);
  }

  if (/^(alias|enum|template|fn|param|field)\b/.test(typed)) {
    return declarationSnippets;
  }

  return [
    ...getContextObjectCandidates(contextPath, index),
    ...snippets
  ];
}

function getInlineParamCandidates(typed: string): string[] {
  const separatorIdx = Math.max(typed.lastIndexOf('('), typed.lastIndexOf(','));
  const currentFragment = typed.slice(separatorIdx + 1).trimStart();
  const head = typed.slice(0, typed.length - currentFragment.length);

  const asMatch = currentFragment.match(/^param\s+\S+(?:\s+as\s+|\s+->\s*)(\S*)$/);
  if (asMatch) {
    const typeFragment = asMatch[1];
    const typeHead = typed.slice(0, typed.length - typeFragment.length);
    return ['any', 'template']
      .filter((t) => t.startsWith(typeFragment))
      .map((t) => `${typeHead}${t}`);
  }

  return [
    'param ... -> values',
    'param name -> template',
    'param name -> any',
    'param name'
  ]
    .filter((s) => s.startsWith(currentFragment))
    .map((s) => `${head}${s}`);
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
  const currentPkg = contextPath[0];
  const projectTypes = index.typeNames.filter((t) => !t.startsWith('c.'));
  const builtins = index.typeNames.filter((t) => t.startsWith('c.'));
  const currentPkgTypes = currentPkg ? projectTypes.filter((t) => t.startsWith(`${currentPkg}.`)) : [];
  const otherPkgTypes = currentPkg ? projectTypes.filter((t) => !t.startsWith(`${currentPkg}.`)) : projectTypes;
  return getDottedCandidates(getTailToken(typed), contextPath, index, [
    ...currentPkgTypes,
    ...otherPkgTypes,
    ...builtins
  ]);
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
    ...currentTemplate.params.filter((p) => !currentTemplate.callableParams.includes(p)),
    ...currentTemplate.callableParams.map((p) => `${p}()`),
    ...getTemplateUseCandidates(typed, contextPath, currentTemplate, index)
  ]);
}

function getTailToken(typed: string): string {
  return typed.match(/[A-Za-z_][A-Za-z0-9_.]*$/)?.[0] ?? '';
}

function getDottedTemplateUseCandidates(token: string, index: DslIndex, currentTemplate: CurrentTemplate): string[] {
  const parentPath = token.split('.').slice(0, -1).filter(Boolean);
  const node = findNode(index.root, parentPath);
  const builtinMatches = getAllUsePaths(index, currentTemplate).filter((name) => name.startsWith(token));

  if (!node) {
    return builtinMatches;
  }

  return uniqueInOrder([
    ...getNodeTemplateUseMembers(node, `${parentPath.join('.')}.`, currentTemplate),
    ...builtinMatches
  ]);
}

function getNodeTemplateUseMembers(node: DslNode, prefix: string, currentTemplate: CurrentTemplate): string[] {
  return uniqueInOrder([
    ...node.children.map((child) => `${prefix}${child.name}.`),
    ...node.symbols
      .filter((symbol) => symbol.kind === 'template')
      .map((symbol) => {
        const name = makePublicSymbolPath(symbol).join('.');
        if (currentTemplate.excludeNames.includes(name)) { return null; }
        const args = symbol.params.length > 0 ? symbol.params.join(', ') : '';
        return `${name}(${args})`;
      })
      .filter((name): name is string => name !== null)
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
    ...currentRoot,
    ...externalRoots,
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
        const args = symbol.params.length > 0 ? symbol.params.join(', ') : '';
        result.push(`${name}(${args})`);
      }
    }
  });

  return uniqueInOrder([
    ...result,
    ...builtinTemplates.map((name) => `${name}()`),
    ...[...knownTemplateBuiltins].map((name) => `${name}()`)
  ]);
}

function getDottedCandidates(token: string, contextPath: string[], index: DslIndex, fallback: string[]): string[] {
  if (token.includes('.')) {
    const parentPath = token.split('.').slice(0, -1).filter(Boolean);
    const node = findNode(index.root, parentPath);
    if (node) {
      const parentPrefix = parentPath.join('.');
      const typeNames = sortUnique([
        ...node.children.map((child) => child.name),
        ...node.symbols.filter((s) => s.kind !== 'template').map((s) => s.name)
      ]).map((name) => `${parentPrefix}.${name}`);
      const fallbackMatches = fallback.filter((f) => f.startsWith(token));
      return uniqueInOrder([...typeNames, ...fallbackMatches]);
    }
  }

  const context = findNode(index.root, contextPath);
  return uniqueInOrder([
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
