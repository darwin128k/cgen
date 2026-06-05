import { CgenProjectIndex, type SuggestionUsageRecord } from './indexer';
import { makePublicPath } from './parser';
import { contextCandidates } from './completionRules';

export interface SuggestionRequest {
  text: string;
  cursor: number;
}

export interface SuggestionResult {
  insertText: string;
  replaceLeft: number;
  candidates: string[];
  candidateKinds: string[];
  contextKey: string;
  prefix: string;
}

type SectionKind = 'root' | 'package' | 'module' | 'scope';
type SymbolKind = 'alias' | 'enum' | 'struct' | 'fn' | 'let';

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
  fnParams: string[];
  structFields: string[];
  excludeNames: string[];
  insideStruct: boolean;
  insideTemplate: boolean;
  insideFn: boolean;
}

const builtinTemplates = [
  'c.array',
  'c.ptr',
  'c.struct',
  'c.union',
  'c.volatile'
];


export async function createDslSuggestion(
  projectIndex: CgenProjectIndex,
  request: SuggestionRequest
): Promise<SuggestionResult | undefined> {
  if (request.cursor < 0 || request.cursor > request.text.length) {
    return undefined;
  }

  const lineRange = getCurrentLineRange(request.text, request.cursor);
  const afterTrim = lineRange.after.trim();
  if (afterTrim.length > 0 && afterTrim !== ':' && !afterTrim.startsWith(',') && !afterTrim.startsWith(')')) {
    return undefined;
  }

  const linePrefix = lineRange.before;

  const index = projectIndex.getSnapshot();
  const currentIndent = lineRange.before.match(/^\s*/)?.[0].length ?? 0;
  const context = findCurrentContext(request.text.slice(0, lineRange.lineStart), currentIndent);
  const currentTemplate = findCurrentTemplate(
    request.text.slice(0, lineRange.lineStart),
    currentIndent,
    request.text.slice(lineRange.lineStart)
  );
  const contextKey = getSuggestionContextKey(context, currentTemplate, linePrefix, index);
  const prefix = getSuggestionPrefix(linePrefix);
  const usage = projectIndex.getSuggestionUsage(contextKey, prefix);
  const matches = pickSuggestions(linePrefix, context, currentTemplate, index, usage);
  if (!matches.length) {
    return undefined;
  }

  const tailToken = linePrefix.trimStart().match(/(@?[A-Za-z_][A-Za-z0-9_.]*)?$/)?.[0] ?? '';
  const divergeAtDot = linePrefix.endsWith('.') && !matches[0].startsWith(linePrefix);
  const sliceFrom = divergeAtDot ? linePrefix.length - 1 : linePrefix.length;
  const tailForCandidates = divergeAtDot ? tailToken.slice(0, -1) : tailToken;
  const trimDot = (s: string) => s.endsWith('.') ? s.slice(0, -1) : s;
  const resolvedCandidates = matches.map((m) => trimDot(`${tailForCandidates}${m.slice(sliceFrom)}`));
  return {
    insertText: trimDot(matches[0].slice(sliceFrom)),
    replaceLeft: divergeAtDot ? 1 : 0,
    candidates: resolvedCandidates,
    candidateKinds: resolvedCandidates.map((c) => contextKey === 'attribute' ? 'attribute' : resolveKindForCandidate(c, index)),
    contextKey,
    prefix
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

function findCurrentContext(textBeforeLine: string, currentIndent?: number): string[] {
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

  if (currentIndent !== undefined) {
    const targetLevel = Math.floor(currentIndent / 4);
    return stack[Math.min(targetLevel, stack.length - 1)] ?? [];
  }

  return stack[stack.length - 1] ?? [];
}

function findCurrentTemplate(textBeforeLine: string, currentIndent?: number, textFromLine?: string): CurrentTemplate {
  const sectionStack: Array<{ indent: number; path: string[] }> = [{ indent: -1, path: [] }];
  let currentTemplate: { indent: number; name: string; path: string[]; params: string[]; callableParams: string[] } | undefined;
  let currentStruct: { indent: number; fields: string[] } | undefined;
  let currentFn: { indent: number; params: string[] } | undefined;

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
    if (currentStruct && indent <= currentStruct.indent) {
      currentStruct = undefined;
    }
    if (currentFn && indent <= currentFn.indent) {
      currentFn = undefined;
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

    if (/^struct\s+[A-Za-z_][A-Za-z0-9_]*\s*:\s*$/.test(line)) {
      currentStruct = { indent, fields: [] };
      continue;
    }

    if (/^fn\s+[A-Za-z_][A-Za-z0-9_]*\s*:\s*$/.test(line)) {
      currentFn = { indent, params: [] };
      continue;
    }

    if (currentFn) {
      const paramName = line.match(/^param\s+([A-Za-z_][A-Za-z0-9_]*)\s+as\s+/)?.[1]
        ?? line.match(/^param\s+\.\.\.\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/)?.[1];
      if (paramName) {
        currentFn.params.push(paramName);
        continue;
      }
    }

    if (currentStruct) {
      currentStruct.fields.push(...getStructFieldNamesFromLine(line));
    }

    const templateMatch = line.match(/^template\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*$/);
    if (templateMatch) {
      currentTemplate = {
        indent,
        name: templateMatch[1],
        path: [...sectionStack[sectionStack.length - 1].path, templateMatch[1]],
        params: [],
        callableParams: []
      };
      continue;
    }

    if (!currentTemplate) {
      continue;
    }

    const variadicParam = line.match(/^(?:param\s+)?\.\.\.\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/);
    const normalParam = line.match(/^(?:param\s+)?([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+(\S+))?$/);
    const paramName = variadicParam?.[1] ?? normalParam?.[1];
    if (paramName) {
      currentTemplate.params.push(paramName);
      if (normalParam?.[2] === 'template') {
        currentTemplate.callableParams.push(paramName);
      }
    }
  }

  const insideStruct = !!currentStruct && (currentIndent === undefined || currentIndent > currentStruct.indent);
  const insideFn = !!currentFn && (currentIndent === undefined || currentIndent > currentFn.indent);
  const fnParams = insideFn ? currentFn?.params ?? [] : [];
  const structFields = insideStruct && currentStruct
    ? uniqueInOrder([
      ...currentStruct.fields,
      ...collectTrailingStructFields(textFromLine ?? '', currentStruct.indent)
    ])
    : [];

  if (!currentTemplate || (currentIndent !== undefined && currentIndent <= currentTemplate.indent)) {
    return { params: [], callableParams: [], fnParams, structFields, excludeNames: [], insideStruct, insideTemplate: false, insideFn };
  }

  return {
    params: currentTemplate.params,
    callableParams: currentTemplate.callableParams,
    fnParams,
    structFields,
    excludeNames: [currentTemplate.name, makePublicPath(currentTemplate.path).join('.')],
    insideStruct,
    insideTemplate: true,
    insideFn
  };
}

function collectTrailingStructFields(textFromLine: string, structIndent: number): string[] {
  const fields: string[] = [];
  const lines = expandInlineDsl(textFromLine).split(/\r?\n/);

  for (let i = 1; i < lines.length; i += 1) {
    const withoutComment = lines[i].replace(/#.*$/, '').trimEnd();
    if (withoutComment.trim().length === 0) {
      continue;
    }

    const indent = withoutComment.match(/^\s*/)?.[0].length ?? 0;
    if (indent <= structIndent) {
      break;
    }

    fields.push(...getStructFieldNamesFromLine(withoutComment.trim()));
  }

  return fields;
}

function getStructFieldNamesFromLine(line: string): string[] {
  const fieldName = line.match(/^field\s+([A-Za-z_][A-Za-z0-9_]*)\s+as\s+/)?.[1];
  if (fieldName) {
    return [fieldName];
  }

  const useExpr = line.match(/^use\s+(.+)$/)?.[1]?.trim();
  if (!useExpr) {
    return [];
  }

  return inferStructUseFieldNames(useExpr);
}

function inferStructUseFieldNames(useExpr: string): string[] {
  const call = useExpr.match(/^([A-Za-z_][A-Za-z0-9_.]*)\((.*)\)$/);
  if (!call || !call[1].endsWith('.fields')) {
    return [];
  }

  return splitCommaBalanced(call[2])
    .map((arg) => arg.trim().match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/)?.[1] ?? '')
    .filter(Boolean);
}

function splitCommaBalanced(source: string): string[] {
  if (!source.trim()) { return []; }
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth = Math.max(0, depth - 1);
    } else if (char === ',' && depth === 0) {
      parts.push(source.slice(start, i));
      start = i + 1;
    }
  }

  parts.push(source.slice(start));
  return parts;
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
  return symbol.path;
}

function sortUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function uniqueInOrder(values: string[]): string[] {
  return [...new Set(values)];
}

function pickSuggestions(
  linePrefix: string,
  contextPath: string[],
  currentTemplate: CurrentTemplate,
  index: DslIndex,
  usage: SuggestionUsageRecord[]
): string[] {
  const indent = linePrefix.match(/^\s*/)?.[0] ?? '';
  const typed = linePrefix.trimStart();
  const candidates = rankCandidates(
    uniqueInOrder(getCandidates(typed, contextPath, currentTemplate, index)),
    typed,
    typed.startsWith('@') ? [] : usage
  );
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
    .slice(0, 24)
    .map((candidate) => `${indent}${candidate}`);
}

function rankCandidates(candidates: string[], typed: string, usage: SuggestionUsageRecord[]): string[] {
  const usageByLabel = new Map(usage.map((record) => [record.label, record]));
  return candidates
    .map((candidate, index) => {
      const usageRecord = usageByLabel.get(candidate);
      const exactPrefixBoost = candidate.startsWith(typed) ? 80 : 0;
      const usageBoost = usageRecord ? Math.min(60, usageRecord.acceptedCount * 8) : 0;
      const recencyBoost = usageRecord?.lastAcceptedAt ? Math.max(0, 12 - Math.floor((Date.now() - Date.parse(usageRecord.lastAcceptedAt)) / 86_400_000)) : 0;
      return { candidate, score: exactPrefixBoost + usageBoost + recencyBoost - index };
    })
    .sort((left, right) => right.score - left.score)
    .map((item) => item.candidate);
}

function getSuggestionPrefix(linePrefix: string): string {
  return linePrefix.trimStart().match(/@?[A-Za-z_][A-Za-z0-9_.]*$/)?.[0] ?? '';
}

function getSuggestionContextKey(
  contextPath: string[],
  currentTemplate: CurrentTemplate,
  linePrefix: string,
  index: DslIndex
): string {
  const typed = linePrefix.trimStart();
  if (/^@/.test(typed)) return 'attribute';
  if (/^let\s+[A-Za-z_][A-Za-z0-9_]*\s+as\s+.+?=\s*/.test(typed)) return 'let.expression';
  if (/\s+as\s+[A-Za-z_][A-Za-z0-9_.]*$/.test(typed)) return 'type';
  if (/^use\s+/.test(typed)) return isUseArgumentPosition(typed) ? 'use.argument' : 'use.template';
  if (/^return\s+/.test(typed)) return 'return.expression';
  if (/^(package|module|scope|group)\s+/.test(typed)) return 'section.name';
  if (currentTemplate.insideFn) return 'fn.body';
  if (currentTemplate.insideStruct) return 'struct.body';
  if (currentTemplate.insideTemplate) return 'define.body';

  const node = findNode(index.root, contextPath);
  return `declaration.${node?.kind ?? 'root'}`;
}

function getCandidates(typed: string, contextPath: string[], currentTemplate: CurrentTemplate, index: DslIndex): string[] {
  if (/^@/.test(typed)) {
    return [...contextCandidates['attribute']];
  }

  if (currentTemplate.insideFn && /^(alias|enum|struct|template|fn|field|param|case)\b/.test(typed)) {
    return [];
  }

  if (/^alias\s+\S+\s+as\s+/.test(typed)) {
    return completeTail(typed, getTypeCandidates(typed, contextPath, index));
  }

  if (/^enum\s+\S+\s+as\s+/.test(typed)) {
    if (typed.trimEnd().endsWith(':')) return [];
    return completeTail(typed, getTypeCandidates(typed, contextPath, index));
  }

  if (/^field\s+\S+\s+as\s+/.test(typed)) {
    return completeTail(typed, getTypeCandidates(typed, contextPath, index));
  }

  if (/^let\s+\S+\s+as\s+[^=]*=\s*/.test(typed)) {
    return completeTail(typed, getExpressionCandidates(typed, contextPath, currentTemplate, index));
  }

  if (/^let\s+\S+\s+as\s+/.test(typed)) {
    return completeTail(typed, getTypeCandidates(typed, contextPath, index));
  }

  if (/^return\s+/.test(typed)) {
    return completeTail(typed, getExpressionCandidates(typed, contextPath, currentTemplate, index));
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

  if (/^(package|module|scope|group)\s+/.test(typed)) {
    return completeSectionName(typed, contextPath, index);
  }

  if (/^case\s+/.test(typed)) {
    return ['case name'];
  }

  if (/^struct\b/.test(typed)) {
    return getDeclarationSnippetsForContext(contextPath, currentTemplate, index);
  }

  if (/^(alias|enum|template|fn|param|field|let)\b/.test(typed)) {
    return getDeclarationSnippetsForContext(contextPath, currentTemplate, index);
  }

  if (currentTemplate.insideFn) {
    return uniqueInOrder([
      ...getContextSnippets(contextPath, currentTemplate, index),
      ...getExpressionCandidates(typed, contextPath, currentTemplate, index)
    ]);
  }

  return getContextSnippets(contextPath, currentTemplate, index);
}

function getStaticContextKey(contextPath: string[], currentTemplate: CurrentTemplate, index: DslIndex): string {
  if (currentTemplate.insideFn) { return 'fn.body'; }
  if (currentTemplate.insideStruct) { return 'struct.body'; }
  if (currentTemplate.insideTemplate) { return 'define.body'; }
  const node = findNode(index.root, contextPath);
  return `declaration.${node?.kind ?? 'root'}`;
}

function getContextSnippets(contextPath: string[], currentTemplate: CurrentTemplate, index: DslIndex): string[] {
  return [...(contextCandidates[getStaticContextKey(contextPath, currentTemplate, index)] ?? [])];
}

function getDeclarationSnippetsForContext(contextPath: string[], currentTemplate: CurrentTemplate, index: DslIndex): string[] {
  return getContextSnippets(contextPath, currentTemplate, index);
}

function getTypeCandidatePool(contextPath: string[], index: DslIndex): string[] {
  const currentPkg = contextPath[0];
  const projectTypes = index.typeNames.filter((t) => !t.startsWith('c.'));
  const builtins = index.typeNames.filter((t) => t.startsWith('c.'));
  const currentPkgTypes = currentPkg ? projectTypes.filter((t) => t.startsWith(`${currentPkg}.`)) : [];
  const otherPkgTypes = currentPkg ? projectTypes.filter((t) => !t.startsWith(`${currentPkg}.`)) : projectTypes;
  return [
    ...currentPkgTypes,
    ...otherPkgTypes,
    ...builtins
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
  return getDottedCandidates(getTailToken(typed), contextPath, index, getTypeCandidatePool(contextPath, index));
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

function getExpressionCandidates(
  typed: string,
  contextPath: string[],
  currentTemplate: CurrentTemplate,
  index: DslIndex
): string[] {
  const token = getTailToken(typed);
  if (token.includes('.')) {
    return uniqueInOrder([
      ...getDottedSelfCandidates(token, currentTemplate),
      ...getDottedTemplateUseCandidates(token, index, currentTemplate),
      ...getDottedFnUseCandidates(token, index)
    ]);
  }

  return uniqueInOrder([
    ...getLocalExpressionCandidates(currentTemplate),
    ...getRootUseNamespaces(contextPath, index),
    ...getFnUseCandidates(index)
  ]);
}

function getUseArgumentCandidates(
  typed: string,
  contextPath: string[],
  currentTemplate: CurrentTemplate,
  index: DslIndex
): string[] {
  const token = getTailToken(typed);
  if (token.includes('.')) {
    return uniqueInOrder([
      ...getDottedSelfCandidates(token, currentTemplate),
      ...getTemplateUseCandidates(typed, contextPath, currentTemplate, index),
      ...getTypeCandidates(typed, contextPath, index)
    ]);
  }

  return sortUnique([
    ...getLocalExpressionCandidates(currentTemplate),
    ...currentTemplate.params.filter((p) => !currentTemplate.callableParams.includes(p)),
    ...currentTemplate.callableParams.map((p) => `${p}()`),
    ...getTemplateUseCandidates(typed, contextPath, currentTemplate, index)
  ]);
}

function getTailToken(typed: string): string {
  return typed.match(/[A-Za-z_][A-Za-z0-9_.]*$/)?.[0] ?? '';
}

function getLocalExpressionCandidates(currentTemplate: CurrentTemplate): string[] {
  return uniqueInOrder([
    ...currentTemplate.fnParams,
    ...(currentTemplate.insideStruct && currentTemplate.insideFn ? ['self'] : [])
  ]);
}

function getDottedSelfCandidates(token: string, currentTemplate: CurrentTemplate): string[] {
  if (!currentTemplate.insideStruct || !currentTemplate.insideFn || !token.startsWith('self.')) {
    return [];
  }

  return currentTemplate.structFields
    .map((field) => `self.${field}`)
    .filter((candidate) => candidate.startsWith(token));
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

function getDottedFnUseCandidates(token: string, index: DslIndex): string[] {
  const parentPath = token.split('.').slice(0, -1).filter(Boolean);
  const parentPrefix = parentPath.join('.');
  const directFunctions = getFnUseCandidates(index).filter((name) => name.startsWith(token));
  const node = findNode(index.root, parentPath);

  if (!node) {
    return directFunctions;
  }

  return uniqueInOrder([
    ...node.symbols
      .filter((symbol) => symbol.kind === 'fn')
      .map((symbol) => formatFnUseCandidate(symbol))
      .filter((name) => name.startsWith(`${parentPrefix}.`)),
    ...directFunctions
  ]);
}

function isUseCallable(symbol: DslSymbol): boolean {
  return symbol.kind === 'fn' || (symbol.kind === 'struct' && symbol.params.length > 0);
}

function nodeHasUseCallables(node: DslNode): boolean {
  if (node.symbols.some(isUseCallable)) { return true; }
  return node.children.some(nodeHasUseCallables);
}

function getNodeTemplateUseMembers(node: DslNode, prefix: string, currentTemplate: CurrentTemplate): string[] {
  const childCandidates = node.children.flatMap((child) => {
    const childPath = `${prefix}${child.name}`;
    const collapsible = child.symbols.find(
      (s) => isUseCallable(s) && makePublicSymbolPath(s).join('.') === childPath
    );
    if (collapsible) {
      if (currentTemplate.excludeNames.includes(childPath)) { return []; }
      const args = collapsible.params.length > 0 ? collapsible.params.join(', ') : '';
      return [`${childPath}(${args})`];
    }
    return nodeHasUseCallables(child) ? [`${childPath}.`] : [];
  });

  const directTemplates = node.symbols
    .filter(isUseCallable)
    .map((symbol) => {
      const name = makePublicSymbolPath(symbol).join('.');
      if (currentTemplate.excludeNames.includes(name)) { return null; }
      const args = symbol.params.length > 0 ? symbol.params.join(', ') : '';
      return `${name}(${args})`;
    })
    .filter((name): name is string => name !== null);

  return uniqueInOrder([...childCandidates, ...directTemplates]);
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
    if (node.kind !== 'root' && nodeHasUseCallables(node)) {
      result.push(`${node.path.join('.')}.`);
    }

    for (const symbol of node.symbols) {
      if (!isUseCallable(symbol)) {
        continue;
      }

      const name = makePublicSymbolPath(symbol).join('.');
      if (!currentTemplate.excludeNames.includes(name)) {
        const args = symbol.params.length > 0 ? symbol.params.join(', ') : '';
        result.push(`${name}(${args})`);
      }
    }
  });

  const all = uniqueInOrder([
    ...result,
    ...builtinTemplates.map((name) => `${name}()`)
  ]);
  const callPrefixes = new Set(all.filter((s) => s.includes('(')).map((s) => s.slice(0, s.indexOf('('))));
  return all.filter((s) => !s.endsWith('.') || !callPrefixes.has(s.slice(0, -1)));
}

function getFnUseCandidates(index: DslIndex): string[] {
  return index.symbols
    .filter((symbol) => symbol.kind === 'fn')
    .map(formatFnUseCandidate);
}

function formatFnUseCandidate(symbol: DslSymbol): string {
  const args = symbol.params.length > 0 ? symbol.params.join(', ') : '';
  return `${makePublicSymbolPath(symbol).join('.')}(${args})`;
}

function getDottedCandidates(token: string, contextPath: string[], index: DslIndex, fallback: string[]): string[] {
  if (token.includes('.')) {
    const parentPath = token.split('.').slice(0, -1).filter(Boolean);
    const node = findNode(index.root, parentPath);
    if (node) {
      const parentPrefix = parentPath.join('.');
      const childCandidates = sortUnique(node.children.map((child) => child.name))
        .map((name) => `${parentPrefix}.${name}`);
      const symbolCandidates = sortUnique(
        node.symbols
          .map((s) => s.kind === 'fn' ? formatFnUseCandidate(s) : s.path.join('.'))
      );
      const typeNames = sortUnique([...childCandidates, ...symbolCandidates]);
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

function resolveKindForCandidate(candidate: string, index: DslIndex): string {
  if (/^@/.test(candidate)) return 'keyword';
  const sectionKind = candidate.match(/^(package|module|scope|group)\b/)?.[1];
  if (sectionKind) return sectionKind === 'group' ? 'module' : sectionKind;
  if (/^alias\b/.test(candidate)) return 'alias';
  if (/^enum\b/.test(candidate)) return 'enum';
  if (/^struct\b/.test(candidate)) return 'struct';
  if (/^template\b/.test(candidate)) return 'template';
  if (/^fn\b/.test(candidate)) return 'fn';
  if (/^field\b/.test(candidate)) return 'field';
  if (/^param\b/.test(candidate)) return 'param';
  if (/^self\./.test(candidate)) return 'field';
  if (candidate === 'self') return 'param';
  if (/^(use|case|name|\.\.\.)/.test(candidate)) return 'keyword';

  const pathStr = candidate.endsWith('.') ? candidate.slice(0, -1) : candidate;
  const callablePath = pathStr.includes('(') ? pathStr.slice(0, pathStr.indexOf('(')) : pathStr;
  const pathParts = pathStr.split('.').filter(Boolean);

  const symbol = index.symbols.find((s) => s.path.join('.') === callablePath || s.path.join('.') === pathStr);
  if (symbol) return symbol.kind;

  if (candidate.includes('(')) return 'template';

  const node = findNode(index.root, pathParts);
  if (node) return node.kind;

  return '';
}
