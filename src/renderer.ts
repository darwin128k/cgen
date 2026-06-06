import type { FnNode, FnParam, StructNode, Attribute } from './parser';
import {
  type ModuleArtifact,
  type TypeSymbol,
  type CallableSymbol,
  type DocTag,
  type EnumConstMode,
  type OutputTarget,
  hasAttr,
  makeMacroName,
  makeTypeKey,
  makeTypedefName,
  makeStructTagName,
  makeEnumCaseName,
} from './cgenTypes';
import {
  parseCallExpression,
  parseUseExpression,
  applyCallableSymbol,
  applyRawBody,
  expandCallableArgument,
  expandStructUse,
  parseLetStatement,
  parseReturnStatement,
  parseAssignmentStatement,
  parseFnExprArgument,
  renderFnExpression,
  buildRawCExprBody,
  renderRawCExpr,
} from './expander';
import {
  collectScopeStructs,
  collectScopeFns,
  collectScopeLets,
  collectScopeTypeDeclarations,
  collectScopeParameterizedStructs,
  resolveTypeExpression,
  shouldDefineAlias,
  hasReturnStatement,
  inferReturnedSelfField,
  getStructFields,
  isCompileTimeFn,
} from './symbols';

function renderFieldDeclaration(
  field: import('./parser').FieldNode,
  typeName: string,
  forceMutable = false
): string {
  const prefix = field.mutable || forceMutable ? '' : 'const ';
  return `${prefix}${typeName} ${field.name}`;
}

function readAttributeTexts(attributes: Attribute[], name: 'brief' | 'doc'): string[] {
  return attributes
    .filter((candidate) => candidate.name === name)
    .map((attribute) => {
      if (attribute.args.length !== 1) {
        throw new Error(`Line ${attribute.line}: @${name} requires exactly one quoted string`);
      }
      let text: unknown;
      try { text = JSON.parse(attribute.args[0]); }
      catch { throw new Error(`Line ${attribute.line}: @${name} requires a valid double-quoted string`); }
      if (typeof text !== 'string') { throw new Error(`Line ${attribute.line}: @${name} requires a quoted string`); }
      return text;
    });
}

function readDocTexts(attributes: Attribute[]): string[] {
  return readAttributeTexts(attributes, 'doc');
}

function readBriefTexts(attributes: Attribute[]): string[] {
  return readAttributeTexts(attributes, 'brief');
}

function pushDocBlock(lines: string[], brief: string, text: string, indent: string, tags: DocTag[]): void {
  const searchableText = [brief, text].filter(Boolean).join('\n');
  const missingTags = tags.filter((tag) => {
    const pattern = tag.command === 'param' || tag.command === 'tparam'
      ? new RegExp(`(?:^|\\n)\\s*[@\\\\]${tag.command}\\s+${tag.name ? tag.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : ''}\\b`)
      : /(?:^|\n)\s*[@\\]return\b/;
    return !pattern.test(searchableText);
  });
  lines.push(`${indent}/**`);
  if (brief.length > 0) {
    const briefLines = brief.split(/\r?\n/);
    for (const [index, line] of briefLines.entries()) {
      lines.push(`${indent} * ${index === 0 ? '@brief ' : ''}${line.replace(/\*\//g, '* /')}`);
    }
  }
  if (brief.length > 0 && (text.length > 0 || missingTags.length > 0)) { lines.push(`${indent} *`); }
  if (text.length > 0) {
    for (const line of text.split(/\r?\n/)) {
      lines.push(`${indent} * ${line.replace(/\*\//g, '* /')}`);
    }
  }
  if (text.length > 0 && missingTags.length > 0) { lines.push(`${indent} *`); }
  for (const tag of missingTags) {
    const name = tag.name ? ` ${tag.name}` : '';
    const description = tag.description ? ` ${tag.description}` : '';
    lines.push(`${indent} * @${tag.command}${name}${description}`);
  }
  lines.push(`${indent} */`);
}

function pushDoc(lines: string[], attributes: Attribute[], indent = '', tags: DocTag[] = []): void {
  const brief = readBriefTexts(attributes).join('\n');
  const texts = readDocTexts(attributes);
  if (brief.length > 0 || texts.length > 0) { pushDocBlock(lines, brief, texts.join('\n'), indent, tags); }
}

function pushFnDoc(
  lines: string[],
  fn: FnNode,
  returnType: string,
  includeSelf: boolean
): void {
  const brief = readBriefTexts(fn.attributes).join('\n');
  const text = readDocTexts(fn.attributes).join('\n');
  const tags: DocTag[] = [
    ...(includeSelf ? [{ command: 'param' as const, name: 'self' }] : []),
    ...fn.params.map((param) => ({
      command: 'param' as const,
      name: param.name,
      description: readDocTexts(param.attributes).join(' ').replace(/\s+/g, ' ').trim()
    })),
    ...(returnType === 'void' ? [] : [{
      command: 'return' as const,
      description: readDocTexts(fn.returnAttributes).join(' ').replace(/\s+/g, ' ').trim()
    }])
  ];
  if (brief.length > 0 || text.length > 0 || tags.some((tag) => tag.description)) {
    pushDocBlock(lines, brief, text, '', tags);
  }
}

function pushParameterizedStructDoc(lines: string[], struct: StructNode): void {
  const brief = readBriefTexts(struct.attributes).join('\n');
  const text = readDocTexts(struct.attributes).join('\n');
  const tags: DocTag[] = struct.params.map((param) => ({
    command: 'tparam' as const,
    name: param.name,
    description: readDocTexts(param.attributes).join(' ').replace(/\s+/g, ' ').trim()
  }));
  if (brief.length > 0 || text.length > 0 || tags.some((tag) => tag.description)) {
    pushDocBlock(lines, brief, text, '', tags);
  }
}

export function validateFnVisibility(fn: FnNode): void {
  for (const attribute of fn.attributes.filter((candidate) => ['public', 'private', 'inline'].includes(candidate.name))) {
    if (attribute.args.length > 0) {
      throw new Error(`Line ${attribute.line}: @${attribute.name} does not accept arguments`);
    }
  }
  const isPrivate = hasAttr(fn.attributes, 'private');
  const isInline = hasAttr(fn.attributes, 'inline');
  if (hasAttr(fn.attributes, 'public') && isPrivate) {
    throw new Error(`Line ${fn.line}: fn cannot be both @public and @private`);
  }
  if (isPrivate && isInline) {
    throw new Error(`Line ${fn.line}: fn cannot be both @private and @inline`);
  }
  if ((isPrivate || isInline) && fn.body.length === 0) {
    throw new Error(`Line ${fn.line}: @${isPrivate ? 'private' : 'inline'} fn requires a body`);
  }
  if (hasAttr(fn.attributes, 'static') || hasAttr(fn.attributes, 'extern')) {
    throw new Error(`Line ${fn.line}: use @private or @inline instead of @static/@extern on fn`);
  }
}

function getFnSpecifiers(fn: FnNode): string {
  validateFnVisibility(fn);
  if (hasAttr(fn.attributes, 'private')) { return 'static'; }
  if (hasAttr(fn.attributes, 'inline')) { return 'static inline'; }
  return '';
}

export function getFnOutputTarget(fn: FnNode): OutputTarget {
  validateFnVisibility(fn);
  if (hasAttr(fn.attributes, 'private')) { return 'source'; }
  if (hasAttr(fn.attributes, 'inline')) { return 'header'; }
  return fn.body.length > 0 ? 'both' : 'header';
}

function resolveFnReturnType(
  fn: FnNode,
  symbols: Map<string, TypeSymbol>,
  callableSymbols: Map<string, CallableSymbol>
): string {
  if (fn.returnType === 'none') { return 'void'; }
  if (fn.returnType !== 'any') { return resolveTypeExpression(fn.returnType, fn.line, symbols, callableSymbols); }
  throw new Error(
    fn.returnTypeInferred
      ? `Line ${fn.line}: cannot infer return type for non-method function`
      : `Line ${fn.line}: any return type is only supported for struct methods`
  );
}

function renderFnParam(
  param: FnParam,
  symbols: Map<string, TypeSymbol>,
  callableSymbols: Map<string, CallableSymbol>
): string {
  const typeName = resolveTypeExpression(param.type, param.line, symbols, callableSymbols);
  const prefix = param.mutable ? '' : 'const ';
  return `${prefix}${typeName} ${param.name}`;
}

function renderMacroParamList(params: FnParam[]): string {
  return params.map((p) => p.variadic ? '...' : p.name).join(', ');
}

function renderDefineFnBody(
  fn: FnNode,
  symbols: Map<string, TypeSymbol>,
  callableSymbols: Map<string, CallableSymbol>
): string {
  if (fn.body.length !== 1) {
    throw new Error(`Line ${fn.line}: compile-time fn must have exactly one return or use statement`);
  }
  const line = fn.body[0];
  const exprOf = line.match(/^return\s+c\.expr\((.*)\)(?:\s+as\s+.+)?$/)
    ?? line.match(/^use\s+c\.expr\((.*)\)$/);
  if (exprOf) {
    const body = buildRawCExprBody(exprOf[1].trim(), fn.line);
    return expandDefineFnVariadics(fn, applyRawBody(body, fn.params.map((p) => p.name), fn.params.map((p) => p.name)));
  }
  const returnStatement = parseReturnStatement(line);
  if (returnStatement) {
    return expandDefineFnVariadics(fn, expandTypedTemplateArgument(returnStatement.expr, fn.line, symbols, callableSymbols));
  }
  if (/^use\s+/.test(line)) {
    const expression = parseUseExpression(line, fn.line);
    const args = expression.args.map((arg) => expandTypedTemplateArgument(arg, fn.line, symbols, callableSymbols));
    const body = applyCallableSymbol(expression.callee, args, fn.line, callableSymbols, (arg, lineNumber) => renderTypeInterpolation(arg, lineNumber, symbols, callableSymbols));
    return expandDefineFnVariadics(fn, body);
  }
  throw new Error(`Line ${fn.line}: compile-time fn must have a return or use statement`);
}

function expandDefineFnVariadics(fn: FnNode, body: string): string {
  let result = body;
  for (const param of fn.params.filter((candidate) => candidate.variadic)) {
    const escaped = param.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result
      .replace(new RegExp(`\\$\\{${escaped}\\}`, 'g'), '__VA_ARGS__')
      .replace(new RegExp(`\\b${escaped}\\b`, 'g'), '__VA_ARGS__');
  }
  return result;
}

function expandTypedTemplateArgument(
  arg: string,
  line: number,
  symbols: Map<string, TypeSymbol>,
  callableSymbols: Map<string, CallableSymbol>
): string {
  return expandCallableArgument(
    arg,
    line,
    callableSymbols,
    (typeArg, lineNumber) => renderTypeInterpolation(typeArg, lineNumber, symbols, callableSymbols)
  );
}

function renderTypeInterpolation(
  arg: string,
  line: number,
  symbols: Map<string, TypeSymbol>,
  callableSymbols: Map<string, CallableSymbol>
): string {
  try {
    return resolveTypeExpression(arg, line, symbols, callableSymbols);
  } catch {
    return arg;
  }
}

function resolveMacroArg(
  arg: string,
  line: number,
  symbols: Map<string, TypeSymbol>,
  callableSymbols: Map<string, CallableSymbol>
): string {
  try {
    return resolveTypeExpression(arg, line, symbols, callableSymbols);
  } catch {
    return expandCallableArgument(arg, line, callableSymbols, (typeArg, lineNumber) => renderTypeInterpolation(typeArg, lineNumber, symbols, callableSymbols));
  }
}

function makeFnSignature(
  fn: FnNode,
  fnCName: string,
  symbols: Map<string, TypeSymbol>,
  callableSymbols: Map<string, CallableSymbol>,
  leadingParams: string[] = []
): string {
  const specifiers = getFnSpecifiers(fn);
  const prefix = specifiers ? `${specifiers} ` : '';
  const returnC = resolveFnReturnType(fn, symbols, callableSymbols);
  const params = [
    ...leadingParams,
    ...fn.params.map((p) => p.variadic ? '...' : renderFnParam(p, symbols, callableSymbols))
  ];
  const paramsC = params.length > 0 ? params.join(', ') : 'void';
  return `${prefix}${returnC} ${fnCName}(${paramsC})`;
}

function resolveStructMethodReturnType(
  fn: FnNode,
  struct: StructNode,
  paramStructs: Map<string, StructNode>,
  symbols: Map<string, TypeSymbol>,
  callableSymbols: Map<string, CallableSymbol>
): string {
  if (fn.returnType === 'none') { return 'void'; }
  if (fn.returnType !== 'any') { return resolveTypeExpression(fn.returnType, fn.line, symbols, callableSymbols); }
  const fieldName = inferReturnedSelfField(fn);
  if (!hasReturnStatement(fn)) { return 'void'; }
  if (!fieldName) { throw new Error(`Line ${fn.bodyLine || fn.line}: cannot infer any return type`); }
  const field = getStructFields(struct, paramStructs).find((candidate) => candidate.name === fieldName);
  if (!field) {
    throw new Error(`Line ${fn.bodyLine || fn.line}: cannot infer any return type, unknown field "self.${fieldName}"`);
  }
  return resolveTypeExpression(field.target, field.line, symbols, callableSymbols);
}

function makeStructMethodSignature(
  fn: FnNode,
  fnCName: string,
  symbols: Map<string, TypeSymbol>,
  callableSymbols: Map<string, CallableSymbol>,
  selfTypeName: string,
  struct: StructNode,
  paramStructs: Map<string, StructNode>
): string {
  const specifiers = getFnSpecifiers(fn);
  const prefix = specifiers ? `${specifiers} ` : '';
  const returnC = resolveStructMethodReturnType(fn, struct, paramStructs, symbols, callableSymbols);
  const selfPrefix = fn.selfMutable ? '' : 'const ';
  const params = [`${selfPrefix}${selfTypeName} *self`, ...fn.params.map((p) => p.variadic ? '...' : renderFnParam(p, symbols, callableSymbols))];
  return `${prefix}${returnC} ${fnCName}(${params.join(', ')})`;
}

function makeFnCName(module: ModuleArtifact, symbolParts: string[], fnName: string): string {
  const nameParts = [...module.symbolParts, ...symbolParts];
  if (nameParts[nameParts.length - 1] !== fnName) { nameParts.push(fnName); }
  return nameParts.join('_');
}

function makeLetCName(module: ModuleArtifact, symbolParts: string[], letName: string): string {
  const nameParts = [...module.symbolParts, ...symbolParts];
  if (nameParts[nameParts.length - 1] !== letName) { nameParts.push(letName); }
  return nameParts.join('_');
}

function makeStructMethodCName(module: ModuleArtifact, symbolParts: string[], structName: string, fnName: string): string {
  const nameParts = [...module.symbolParts, ...symbolParts];
  if (nameParts[nameParts.length - 1] !== structName) { nameParts.push(structName); }
  if (nameParts[nameParts.length - 1] !== fnName) { nameParts.push(fnName); }
  return nameParts.join('_');
}

function validateModuleLet(letNode: import('./parser').LetNode): void {
  for (const attribute of letNode.attributes.filter((candidate) => ['public', 'private', 'inline'].includes(candidate.name))) {
    if (attribute.args.length > 0) {
      throw new Error(`Line ${attribute.line}: @${attribute.name} does not accept arguments`);
    }
  }
  if (hasAttr(letNode.attributes, 'public') && hasAttr(letNode.attributes, 'private')) {
    throw new Error(`Line ${letNode.line}: let cannot be both @public and @private`);
  }
  if (hasAttr(letNode.attributes, 'inline')) {
    throw new Error(`Line ${letNode.line}: @inline is only supported on fn`);
  }
}

function getLetOutputTarget(letNode: import('./parser').LetNode): OutputTarget {
  validateModuleLet(letNode);
  return hasAttr(letNode.attributes, 'private') ? 'source' : 'both';
}

function renderLetTypePrefix(letNode: import('./parser').LetNode): string {
  return letNode.mutable ? '' : 'const ';
}

function renderLetDefinition(
  letNode: import('./parser').LetNode,
  cName: string,
  symbols: Map<string, TypeSymbol>,
  callableSymbols: Map<string, CallableSymbol>,
  isPrivate: boolean
): string {
  const storage = isPrivate ? 'static ' : '';
  const typeName = resolveTypeExpression(letNode.type, letNode.line, symbols, callableSymbols);
  const expanded = expandTypedTemplateArgument(letNode.expr, letNode.line, symbols, callableSymbols);
  return `${storage}${renderLetTypePrefix(letNode)}${typeName} ${cName} = ${expanded};`;
}

function renderLetDeclaration(
  letNode: import('./parser').LetNode,
  cName: string,
  symbols: Map<string, TypeSymbol>,
  callableSymbols: Map<string, CallableSymbol>
): string {
  const typeName = resolveTypeExpression(letNode.type, letNode.line, symbols, callableSymbols);
  return `extern ${renderLetTypePrefix(letNode)}${typeName} ${cName};`;
}

function renderFnBody(
  fn: FnNode,
  symbols: Map<string, TypeSymbol>,
  callableSymbols: Map<string, CallableSymbol>,
  methodSelfPointer = false
): string[] {
  return fn.body.map((line) => renderFnBodyLine(line, fn.line, symbols, callableSymbols, methodSelfPointer));
}

function renderFnBodyLine(
  line: string,
  fnLine: number,
  symbols: Map<string, TypeSymbol>,
  callableSymbols: Map<string, CallableSymbol>,
  methodSelfPointer: boolean
): string {
  const letStatement = parseLetStatement(line);
  if (letStatement) {
    const typeName = resolveTypeExpression(letStatement.type, fnLine, symbols, callableSymbols);
    const expr = renderFnExpression(letStatement.expr, methodSelfPointer);
    const expanded = expandTypedTemplateArgument(expr, fnLine, symbols, callableSymbols);
    return `  ${typeName} ${letStatement.name} = ${expanded};`;
  }
  const exprOfMatch = line.match(/^use\s+c\.expr\((.*)\)$/);
  if (exprOfMatch) {
    return `  ${renderRawCExpr(exprOfMatch[1].trim(), fnLine, (arg, lineNumber) => renderTypeInterpolation(arg, lineNumber, symbols, callableSymbols))}`;
  }
  const returnStatement = parseReturnStatement(line);
  if (returnStatement) {
    const expr = renderFnExpression(returnStatement.expr, methodSelfPointer);
    const expanded = expandTypedTemplateArgument(expr, fnLine, symbols, callableSymbols);
    return `  return ${expanded};`;
  }
  const assignment = parseAssignmentStatement(line);
  if (assignment) {
    if (assignment.target.startsWith('self.') && !methodSelfPointer) {
      throw new Error(`Line ${fnLine}: self assignment is only supported in struct methods`);
    }
    const target = renderFnExpression(assignment.target, methodSelfPointer);
    const expr = renderFnExpression(assignment.expr, methodSelfPointer);
    const expanded = expandTypedTemplateArgument(expr, fnLine, symbols, callableSymbols);
    return `  ${target} = ${expanded};`;
  }
  if (/^use\s+/.test(line)) {
    const expression = parseUseExpression(renderFnExpression(line, methodSelfPointer), fnLine);
    const args = expression.args.map((arg) => expandTypedTemplateArgument(arg, fnLine, symbols, callableSymbols));
    const expanded = applyCallableSymbol(expression.callee, args, fnLine, callableSymbols, (typeArg, lineNumber) => resolveTypeExpression(typeArg, lineNumber, symbols, callableSymbols));
    return `  ${expanded};`;
  }
  throw new Error(`Line ${fnLine}: function bodies only support declarations, assignments, returns, and use expressions`);
}

function shouldOutputHeaderCase(mode: EnumConstMode, target: OutputTarget): boolean {
  if (mode === 'define' || mode === 'static') { return true; }
  return target === 'header' || target === 'both';
}

function renderEnumCaseForHeader(
  symbolParts: string[],
  declaration: import('./parser').EnumNode,
  member: import('./parser').EnumMemberNode,
  index: number,
  cName: string,
  mode: EnumConstMode
): string {
  const memberName = makeEnumCaseName(symbolParts, declaration.name, member.name);
  const rawValue = member.value ?? String(index);
  if (mode === 'define') { return `#define ${memberName} ((${cName})${rawValue})`; }
  if (mode === 'extern') { return `extern const ${cName} ${memberName};`; }
  return `static const ${cName} ${memberName} = ${rawValue};`;
}

function getEnumConstMode(declaration: import('./parser').EnumNode): EnumConstMode {
  if (hasAttr(declaration.attributes, 'define')) { return 'define'; }
  if (hasAttr(declaration.attributes, 'extern') || hasAttr(declaration.attributes, 'public')) { return 'extern'; }
  return 'static';
}

function getEnumOutputTarget(declaration: import('./parser').EnumNode): OutputTarget {
  for (const attribute of declaration.attributes.filter((candidate) => ['public', 'private', 'inline'].includes(candidate.name))) {
    if (attribute.args.length > 0) {
      throw new Error(`Line ${attribute.line}: @${attribute.name} does not accept arguments`);
    }
    if (attribute.name !== 'public') {
      throw new Error(`Line ${attribute.line}: @${attribute.name} is only supported on fn`);
    }
  }
  if (hasAttr(declaration.attributes, 'intrinsic')) {
    throw new Error(`Line ${declaration.line}: @intrinsic is only supported on alias and compile-time fn declarations`);
  }
  return hasAttr(declaration.attributes, 'public') ? 'both' : 'header';
}

export function renderHeader(
  module: ModuleArtifact,
  includes: string[],
  symbols: Map<string, TypeSymbol>,
  callableSymbols: Map<string, CallableSymbol>,
  paramStructs: Map<string, StructNode>
): string {
  const lines: string[] = [];
  pushDoc(lines, module.section.attributes);
  lines.push(`#ifndef ${module.guard}`, `#define ${module.guard}`, '');

  for (const header of [...module.externHeaders].sort()) { lines.push(`#include <${header}>`); }
  for (const includePath of includes) { lines.push(`#include <${includePath}>`); }
  if (module.externHeaders.size > 0 || includes.length > 0) { lines.push(''); }

  for (const { declaration, symbolParts } of collectScopeTypeDeclarations(module.section, [])) {
    const allSymbolParts = [...module.symbolParts, ...symbolParts];
    if (declaration.kind === 'alias') {
      if (hasAttr(declaration.attributes, 'intrinsic')) { continue; }
      pushDoc(lines, declaration.attributes);
      const type = resolveTypeExpression(declaration.target, declaration.line, symbols, callableSymbols);
      const cName = makeTypedefName(allSymbolParts, declaration.name);
      const aliasKey = makeTypeKey([...module.typeParts, ...symbolParts], declaration.name);
      const defineOnly = symbols.get(aliasKey)?.defineOnly ?? shouldDefineAlias(declaration.target, declaration.line, symbols, callableSymbols);
      lines.push(defineOnly ? `#define ${cName} ${type}` : `typedef ${type} ${cName};`);
      continue;
    }
    const type = resolveTypeExpression(declaration.target, declaration.line, symbols, callableSymbols);
    const cName = makeTypedefName(allSymbolParts, declaration.name);
    pushDoc(lines, declaration.attributes);
    lines.push(`typedef ${type} ${cName};`);
    if (declaration.members.length > 0) { lines.push(''); }
    declaration.members.forEach((member, index) => {
      const mode = getEnumConstMode(declaration);
      const target = getEnumOutputTarget(declaration);
      if (shouldOutputHeaderCase(mode, target)) {
        pushDoc(lines, member.attributes);
        lines.push(renderEnumCaseForHeader(allSymbolParts, declaration, member, index, cName, mode));
      }
    });
  }

  for (const { struct, symbolParts } of collectScopeParameterizedStructs(module.section, [])) {
    const allSymbolParts = [...module.symbolParts, ...symbolParts];
    const paramNames = new Set(struct.params.map((p) => p.name));
    const paramList = renderMacroParamList(struct.params);
    const mutableFields = hasAttr(struct.attributes, 'mutable');
    const fieldDefs = struct.fields.map((field, index) => {
      const typeName = paramNames.has(field.target)
        ? field.target
        : resolveTypeExpression(field.target, field.line, symbols, callableSymbols);
      const semi = index < struct.fields.length - 1 ? ';' : '';
      return `${renderFieldDeclaration(field, typeName, mutableFields)}${semi}`;
    }).join(' ');
    pushParameterizedStructDoc(lines, struct);
    lines.push(`#define ${makeMacroName(allSymbolParts, struct.name)}(${paramList}) ${fieldDefs}`);
  }

  for (const { fn, symbolParts } of collectScopeFns(module.section, [])) {
    if (!isCompileTimeFn(fn) || hasAttr(fn.attributes, 'intrinsic')) { continue; }
    const allSymbolParts = [...module.symbolParts, ...symbolParts];
    pushDoc(lines, fn.attributes);
    lines.push(`#define ${makeMacroName(allSymbolParts, fn.name)}(${renderMacroParamList(fn.params)}) ${renderDefineFnBody(fn, symbols, callableSymbols)}`);
  }

  for (const { struct, symbolParts } of collectScopeStructs(module.section, [])) {
    if (struct.params.length > 0) { continue; }
    const allSymbolParts = [...module.symbolParts, ...symbolParts];
    const tagName = makeStructTagName(allSymbolParts, struct.name);
    const typedefName = makeTypedefName(allSymbolParts, struct.name);
    pushDoc(lines, struct.attributes);
    lines.push(`typedef struct ${tagName} {`);
    for (const field of struct.fields) {
      const typeName = resolveTypeExpression(field.target, field.line, symbols, callableSymbols);
      pushDoc(lines, field.attributes, '  ');
      lines.push(`  ${renderFieldDeclaration(field, typeName)};`);
    }
    for (const use of (struct.uses ?? [])) {
      if (use.inline) {
        for (const field of expandStructUse(use.expr, struct.line, paramStructs)) {
          const typeName = resolveTypeExpression(field.target, field.line, symbols, callableSymbols);
          pushDoc(lines, field.attributes, '  ');
          lines.push(`  ${renderFieldDeclaration(field, typeName)};`);
        }
        continue;
      }
      const call = parseCallExpression(use.expr, struct.line);
      if (!call) { continue; }
      const tmpl = callableSymbols.get(call.callee);
      if (!tmpl) { continue; }
      const resolvedArgs = call.args.map((arg) => resolveMacroArg(arg, struct.line, symbols, callableSymbols));
      lines.push(`  ${tmpl.macroName}(${resolvedArgs.join(', ')});`);
    }
    lines.push(`} ${typedefName};`);
    for (const fn of struct.fns) {
      const target = getFnOutputTarget(fn);
      if (target === 'source') { continue; }
      const fnCName = makeStructMethodCName(module, symbolParts, struct.name, fn.name);
      const signature = makeStructMethodSignature(fn, fnCName, symbols, callableSymbols, typedefName, struct, paramStructs);
      pushFnDoc(lines, fn, resolveStructMethodReturnType(fn, struct, paramStructs, symbols, callableSymbols), true);
      if (hasAttr(fn.attributes, 'inline')) {
        lines.push(`${signature} {`);
        lines.push(...renderFnBody(fn, symbols, callableSymbols, true));
        lines.push('}');
      } else {
        lines.push(`${signature};`);
      }
    }
  }

  for (const { letNode, symbolParts } of collectScopeLets(module.section, [])) {
    if (getLetOutputTarget(letNode) === 'source') { continue; }
    const cName = makeLetCName(module, symbolParts, letNode.name);
    pushDoc(lines, letNode.attributes);
    lines.push(renderLetDeclaration(letNode, cName, symbols, callableSymbols));
  }

  for (const { fn, symbolParts: extraParts } of collectScopeFns(module.section, [])) {
    if (isCompileTimeFn(fn)) { continue; }
    const target = getFnOutputTarget(fn);
    if (target === 'source') { continue; }
    const fnCName = makeFnCName(module, extraParts, fn.name);
    const signature = makeFnSignature(fn, fnCName, symbols, callableSymbols);
    pushFnDoc(lines, fn, resolveFnReturnType(fn, symbols, callableSymbols), false);
    if (hasAttr(fn.attributes, 'inline')) {
      lines.push(`${signature} {`);
      lines.push(...renderFnBody(fn, symbols, callableSymbols));
      lines.push('}');
    } else {
      lines.push(`${signature};`);
    }
  }

  lines.push('', `#endif // ${module.guard}`, '');
  return lines.join('\n');
}

export function renderSource(
  module: ModuleArtifact,
  symbols: Map<string, TypeSymbol>,
  callableSymbols: Map<string, CallableSymbol>,
  paramStructs: Map<string, StructNode>
): string | undefined {
  const lines = [`#include <${module.includePath}>`, ''];
  let hasDefinitions = false;

  for (const { declaration, symbolParts } of collectScopeTypeDeclarations(module.section, [])) {
    if (declaration.kind !== 'enum') { continue; }
    const mode = getEnumConstMode(declaration);
    const target = getEnumOutputTarget(declaration);
    if (mode !== 'extern' || (target !== 'source' && target !== 'both')) { continue; }
    const allSymbolParts = [...module.symbolParts, ...symbolParts];
    const cName = makeTypedefName(allSymbolParts, declaration.name);
    for (const [index, member] of declaration.members.entries()) {
      const memberName = makeEnumCaseName(allSymbolParts, declaration.name, member.name);
      const rawValue = member.value ?? String(index);
      lines.push(`const ${cName} ${memberName} = ${rawValue};`);
      hasDefinitions = true;
    }
  }

  for (const { letNode, symbolParts } of collectScopeLets(module.section, [])) {
    const target = getLetOutputTarget(letNode);
    if (target !== 'source' && target !== 'both') { continue; }
    const cName = makeLetCName(module, symbolParts, letNode.name);
    if (target === 'source') { pushDoc(lines, letNode.attributes); }
    lines.push(renderLetDefinition(letNode, cName, symbols, callableSymbols, target === 'source'));
    hasDefinitions = true;
  }

  for (const { fn, symbolParts: extraParts } of collectScopeFns(module.section, [])) {
    if (isCompileTimeFn(fn)) { continue; }
    const target = getFnOutputTarget(fn);
    if (target !== 'source' && target !== 'both') { continue; }
    const fnCName = makeFnCName(module, extraParts, fn.name);
    if (target === 'source') { pushFnDoc(lines, fn, resolveFnReturnType(fn, symbols, callableSymbols), false); }
    lines.push(`${makeFnSignature(fn, fnCName, symbols, callableSymbols)} {`);
    lines.push(...renderFnBody(fn, symbols, callableSymbols));
    lines.push('}');
    hasDefinitions = true;
  }

  for (const { struct, symbolParts } of collectScopeStructs(module.section, [])) {
    if (struct.params.length > 0) { continue; }
    const allSymbolParts = [...module.symbolParts, ...symbolParts];
    const typedefName = makeTypedefName(allSymbolParts, struct.name);
    for (const fn of struct.fns) {
      const target = getFnOutputTarget(fn);
      if (target !== 'source' && target !== 'both') { continue; }
      const fnCName = makeStructMethodCName(module, symbolParts, struct.name, fn.name);
      if (target === 'source') {
        pushFnDoc(lines, fn, resolveStructMethodReturnType(fn, struct, paramStructs, symbols, callableSymbols), true);
      }
      lines.push(`${makeStructMethodSignature(fn, fnCName, symbols, callableSymbols, typedefName, struct, paramStructs)} {`);
      lines.push(...renderFnBody(fn, symbols, callableSymbols, true));
      lines.push('}');
      hasDefinitions = true;
    }
  }

  if (!hasDefinitions) { return undefined; }
  lines.push('');
  return lines.join('\n');
}
