import type { SectionNode, TemplateNode, AliasNode, EnumNode, FnNode, StructNode, FnParam } from './parser';
import {
  type ModuleArtifact,
  type TypeSymbol,
  type TemplateSymbol,
  type ScopedTypeDeclaration,
  type TypeDeclaration,
  hasAttr,
  getIncludeArg,
  parseExprOf,
  makeTypeKey,
  makeTypedefName,
  makeMacroName,
} from './cgenTypes';
import {
  parseCallExpression,
  applyRawBody,
  expandStructUse,
  buildRawCExprBody,
} from './expander';

export function collectScopeTemplates(
  section: SectionNode,
  extraParts: string[]
): Array<{ template: TemplateNode; symbolParts: string[]; typeParts: string[] }> {
  const result = section.templates.map((template) => ({ template, symbolParts: extraParts, typeParts: extraParts }));
  for (const child of section.children) {
    if (child.kind === 'scope') {
      result.push(...collectScopeTemplates(child, [...extraParts, child.name]));
    }
  }
  return result;
}

export function collectScopeStructs(
  section: SectionNode,
  extraParts: string[]
): Array<{ struct: import('./parser').StructNode; symbolParts: string[]; typeParts: string[] }> {
  const result = section.structs.map((struct) => ({ struct, symbolParts: extraParts, typeParts: extraParts }));
  for (const child of section.children) {
    if (child.kind === 'scope') {
      result.push(...collectScopeStructs(child, [...extraParts, child.name]));
    }
  }
  return result;
}

export function collectScopeFns(
  section: SectionNode,
  extraParts: string[]
): Array<{ fn: import('./parser').FnNode; symbolParts: string[] }> {
  const result = section.fns.map((fn) => ({ fn, symbolParts: extraParts }));
  for (const child of section.children) {
    if (child.kind === 'scope') {
      result.push(...collectScopeFns(child, [...extraParts, child.name]));
    }
  }
  return result;
}

export function collectScopeLets(
  section: SectionNode,
  extraParts: string[]
): Array<{ letNode: import('./parser').LetNode; symbolParts: string[] }> {
  const result = section.lets.map((letNode) => ({ letNode, symbolParts: extraParts }));
  for (const child of section.children) {
    if (child.kind === 'scope') {
      result.push(...collectScopeLets(child, [...extraParts, child.name]));
    }
  }
  return result;
}

export function collectScopeRecordTemplates(
  section: SectionNode,
  extraParts: string[]
): Array<{ template: TemplateNode; symbolParts: string[]; typeParts: string[] }> {
  return collectScopeTemplates(section, extraParts).filter(
    ({ template }) => template.fields.length > 0 && template.params.length === 0
  );
}

export function collectScopeParameterizedStructs(
  section: SectionNode,
  extraParts: string[]
): Array<{ struct: StructNode; symbolParts: string[]; typeParts: string[] }> {
  return collectScopeStructs(section, extraParts).filter(({ struct }) => struct.params.length > 0);
}

export function isAnyParam(param: FnParam): boolean {
  return param.type === 'any';
}

export function isTemplateLikeFn(fn: FnNode): boolean {
  return hasAttr(fn.attributes, 'define')
    || hasAttr(fn.attributes, 'intrinsic')
    || fn.params.some(isAnyParam)
    || fn.returnType === 'any';
}

function getTypeDeclarations(section: SectionNode): TypeDeclaration[] {
  return [...section.aliases, ...section.enums].sort((left, right) => left.line - right.line);
}

export function collectScopeTypeDeclarations(section: SectionNode, extraParts: string[]): ScopedTypeDeclaration[] {
  const result = getTypeDeclarations(section).map((declaration) => ({
    declaration,
    symbolParts: extraParts,
    typeParts: extraParts
  }));
  for (const child of section.children) {
    if (child.kind === 'scope') {
      result.push(...collectScopeTypeDeclarations(child, [...extraParts, child.name]));
    }
  }
  return result.sort((left, right) => left.declaration.line - right.declaration.line);
}

export function buildParamTemplateMap(modules: ModuleArtifact[]): Map<string, TemplateNode> {
  const map = new Map<string, TemplateNode>();
  for (const module of modules) {
    for (const { template, typeParts } of collectScopeTemplates(module.section, [])) {
      if (template.params.length > 0 && template.fields.length > 0) {
        const key = makeTypeKey([...module.typeParts, ...typeParts], template.name);
        map.set(key, template);
      }
    }
  }
  return map;
}

export function buildParamStructMap(modules: ModuleArtifact[]): Map<string, StructNode> {
  const map = new Map<string, StructNode>();
  for (const module of modules) {
    for (const { struct, typeParts } of collectScopeParameterizedStructs(module.section, [])) {
      const key = makeTypeKey([...module.typeParts, ...typeParts], struct.name);
      map.set(key, struct);
    }
  }
  return map;
}

export function buildBodyTemplateMap(modules: ModuleArtifact[]): Map<string, TemplateNode> {
  const map = new Map<string, TemplateNode>();
  for (const module of modules) {
    for (const { template, typeParts } of collectScopeTemplates(module.section, [])) {
      if (template.body) {
        const key = makeTypeKey([...module.typeParts, ...typeParts], template.name);
        map.set(key, template);
      }
    }
  }
  return map;
}

export function buildTemplateSymbols(modules: ModuleArtifact[]): Map<string, TemplateSymbol> {
  const symbols = new Map<string, TemplateSymbol>();
  for (const module of modules) {
    for (const { fn, symbolParts } of collectScopeFns(module.section, [])) {
      if (!isTemplateLikeFn(fn)) { continue; }
      const allTypeParts = [...module.typeParts, ...symbolParts];
      if (allTypeParts[allTypeParts.length - 1] !== fn.name) { allTypeParts.push(fn.name); }
      const key = allTypeParts.join('.');
      const allSymbolParts = [...module.symbolParts, ...symbolParts];
      const macroName = makeMacroName(allSymbolParts, fn.name);
      const existing = symbols.get(key);
      if (existing) {
        throw new Error(`Line ${fn.line}: callable "${key}" is already defined in ${existing.includePath}`);
      }
      const rawBody = getRawFnBody(fn);
      symbols.set(key, {
        key,
        macroName,
        moduleId: module.id,
        includePath: module.includePath,
        externHeader: getIncludeArg(fn.attributes) ?? undefined,
        intrinsicOnly: hasAttr(fn.attributes, 'intrinsic'),
        defineOnly: hasAttr(fn.attributes, 'define') || hasAttr(fn.attributes, 'intrinsic') || fn.params.some(isAnyParam),
        ...(rawBody ? {
          rawBody,
          rawParams: fn.params.map((p) => p.name)
        } : {})
      });
    }

    for (const { struct, typeParts } of collectScopeParameterizedStructs(module.section, [])) {
      const allTypeParts = [...module.typeParts, ...typeParts];
      if (allTypeParts[allTypeParts.length - 1] !== struct.name) { allTypeParts.push(struct.name); }
      const key = allTypeParts.join('.');
      const allSymbolParts = [...module.symbolParts, ...typeParts];
      const macroName = makeMacroName(allSymbolParts, struct.name);
      const existing = symbols.get(key);
      if (existing) {
        throw new Error(`Line ${struct.line}: callable "${key}" is already defined in ${existing.includePath}`);
      }
      symbols.set(key, {
        key,
        macroName,
        moduleId: module.id,
        includePath: module.includePath,
        externHeader: getIncludeArg(struct.attributes) ?? undefined,
        intrinsicOnly: hasAttr(struct.attributes, 'intrinsic'),
        defineOnly: true,
        rawParams: struct.params.map((p) => p.name)
      });
    }

    for (const { template, typeParts } of collectScopeTemplates(module.section, [])) {
      const allTypeParts = [...module.typeParts, ...typeParts];
      if (allTypeParts[allTypeParts.length - 1] !== template.name) { allTypeParts.push(template.name); }
      const key = allTypeParts.join('.');
      const allSymbolParts = [...module.symbolParts, ...typeParts];
      const macroName = makeMacroName(allSymbolParts, template.name);
      const existing = symbols.get(key);
      if (existing) {
        throw new Error(`Line ${template.line}: template "${key}" is already defined in ${existing.includePath}`);
      }
      if (template.fields.length > 0 && template.params.length === 0) { continue; }
      symbols.set(key, {
        key,
        macroName,
        moduleId: module.id,
        includePath: module.includePath,
        externHeader: getIncludeArg(template.attributes) ?? undefined,
        intrinsicOnly: hasAttr(template.attributes, 'intrinsic'),
        defineOnly: hasAttr(template.attributes, 'define'),
        ...(template.bodyRaw && template.body ? { rawBody: template.body, rawParams: template.params.map((p) => p.name) } : {})
      });
    }
  }
  return symbols;
}

function getRawFnBody(fn: FnNode): string | undefined {
  if (fn.body.length !== 1) { return undefined; }
  const line = fn.body[0];
  const exprOf = line.match(/^return\s+c\.expr\((.*)\)(?:\s+as\s+.+)?$/)
    ?? line.match(/^use\s+c\.expr\((.*)\)$/);
  if (!exprOf) { return undefined; }
  return buildRawCExprBody(exprOf[1].trim(), fn.line);
}

export function buildTypeSymbols(modules: ModuleArtifact[], templateSymbols: Map<string, TemplateSymbol>): Map<string, TypeSymbol> {
  const symbols = new Map<string, TypeSymbol>();

  for (const module of modules) {
    for (const { declaration, symbolParts, typeParts } of collectScopeTypeDeclarations(module.section, [])) {
      const key = makeTypeKey([...module.typeParts, ...typeParts], declaration.name);
      const cName = makeTypedefName([...module.symbolParts, ...symbolParts], declaration.name);
      const existing = symbols.get(key);
      if (existing) {
        throw new Error(`Line ${declaration.line}: type "${key}" is already defined in ${existing.includePath}`);
      }
      symbols.set(key, {
        key,
        cName,
        moduleId: module.id,
        includePath: module.includePath,
        externHeader: getIncludeArg(declaration.attributes) ?? undefined,
        kind: declaration.kind,
        target: declaration.target,
        line: declaration.line,
        defineOnly: declaration.kind === 'alias' && declaration.attributes.some((a) => a.name === 'alias' && a.args[0] === 'define'),
        intrinsicAlias: declaration.kind === 'alias' && hasAttr(declaration.attributes, 'intrinsic'),
      });
    }

    for (const { template, symbolParts, typeParts } of collectScopeRecordTemplates(module.section, [])) {
      const key = makeTypeKey([...module.typeParts, ...typeParts], template.name);
      const cName = makeTypedefName([...module.symbolParts, ...symbolParts], template.name);
      const existing = symbols.get(key);
      if (existing) {
        throw new Error(`Line ${template.line}: type "${key}" is already defined in ${existing.includePath}`);
      }
      symbols.set(key, {
        key, cName, moduleId: module.id, includePath: module.includePath,
        kind: 'template', line: template.line, defineOnly: false, intrinsicAlias: false,
      });
    }

    for (const { struct, symbolParts, typeParts } of collectScopeStructs(module.section, [])) {
      if (struct.params.length > 0) { continue; }
      const key = makeTypeKey([...module.typeParts, ...typeParts], struct.name);
      const cName = makeTypedefName([...module.symbolParts, ...symbolParts], struct.name);
      const existing = symbols.get(key);
      if (existing) {
        throw new Error(`Line ${struct.line}: type "${key}" is already defined in ${existing.includePath}`);
      }
      symbols.set(key, {
        key, cName, moduleId: module.id, includePath: module.includePath,
        kind: 'struct', line: struct.line, defineOnly: false, intrinsicAlias: false,
      });
    }
  }

  for (const symbol of symbols.values()) {
    if (symbol.defineOnly) { continue; }
    symbol.defineOnly = resolveTypeSymbolDefineOnly(symbol, symbols, templateSymbols, new Set());
  }

  return symbols;
}

function getRawTypeInterpolationParams(rawBody: string | undefined): Set<string> {
  const result = new Set<string>();
  if (!rawBody) { return result; }
  for (const match of rawBody.matchAll(/\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s+as\s+type\s*\}/g)) {
    result.add(match[1]);
  }
  return result;
}

function expandTypeTemplateExpression(
  expression: import('./cgenTypes').UseExpression,
  template: TemplateSymbol,
  line: number,
  symbols: Map<string, TypeSymbol>,
  templateSymbols: Map<string, TemplateSymbol>
): string {
  const typeParams = getRawTypeInterpolationParams(template.rawBody);
  for (const [index, paramName] of (template.rawParams ?? []).entries()) {
    if (typeParams.has(paramName) && expression.args[index] === undefined) {
      throw new Error(`Line ${line}: type template "${expression.callee}" expects argument "${paramName}"`);
    }
  }
  return applyRawBody(
    template.rawBody!,
    template.rawParams ?? [],
    expression.args,
    line,
    (arg, lineNumber) => resolveTypeExpression(arg, lineNumber, symbols, templateSymbols)
  );
}

export function resolveTypeExpression(
  target: string,
  line: number,
  symbols: Map<string, TypeSymbol>,
  templateSymbols: Map<string, TemplateSymbol>
): string {
  if (target === 'none') { return 'void'; }
  const expr = parseExprOf(target);
  if (expr !== undefined) { return expr; }

  const expression = parseCallExpression(target, line);
  if (expression) {
    const template = templateSymbols.get(expression.callee);
    if (template?.rawBody !== undefined) {
      return expandTypeTemplateExpression(expression, template, line, symbols, templateSymbols);
    }
    throw new Error(`Line ${line}: unknown type template "${expression.callee}"`);
  }

  const symbol = symbols.get(target);
  if (!symbol) { throw new Error(`Line ${line}: unknown type "${target}"`); }
  if (symbol.intrinsicAlias && symbol.target) {
    return resolveTypeExpression(symbol.target, line, symbols, templateSymbols);
  }
  return symbol.cName;
}

export function getTypeExpressionSymbols(
  target: string,
  line: number,
  symbols: Map<string, TypeSymbol>,
  templateSymbols: Map<string, TemplateSymbol>
): TypeSymbol[] {
  if (target === 'none') { return []; }
  if (parseExprOf(target) !== undefined) { return []; }

  const expression = parseCallExpression(target, line);
  if (expression) {
    const template = templateSymbols.get(expression.callee);
    if (template?.rawBody !== undefined) {
      const result: TypeSymbol[] = [];
      const typeParams = getRawTypeInterpolationParams(template.rawBody);
      for (let index = 0; index < expression.args.length; index += 1) {
        if (typeParams.has(template.rawParams?.[index] ?? '')) {
          result.push(...getTypeExpressionSymbols(expression.args[index], line, symbols, templateSymbols));
        }
      }
      return result;
    }
    throw new Error(`Line ${line}: unknown type template "${expression.callee}"`);
  }

  const symbol = symbols.get(target);
  if (!symbol) { throw new Error(`Line ${line}: unknown type "${target}"`); }
  return [symbol];
}

export function hasReturnStatement(fn: import('./parser').FnNode): boolean {
  return fn.body.some((line) => /^return(?:\s+|$)/.test(line));
}

export function inferReturnedSelfField(fn: import('./parser').FnNode): string | undefined {
  const returns = fn.body.filter((line) => /^return\s+/.test(line));
  if (returns.length !== 1) { return undefined; }
  return returns[0].match(/^return\s+self\.([A-Za-z_][A-Za-z0-9_]*)$/)?.[1];
}

export function getStructFields(
  struct: import('./parser').StructNode,
  paramTemplates: Map<string, TemplateNode>,
  paramStructs: Map<string, StructNode> = new Map()
): import('./parser').TemplateField[] {
  const fields = [...struct.fields];
  for (const use of (struct.uses ?? [])) {
    fields.push(...expandStructUse(use.expr, struct.line, paramTemplates, paramStructs));
  }
  return fields;
}

export function shouldDefineAlias(
  target: string,
  line: number,
  symbols: Map<string, TypeSymbol>,
  templateSymbols: Map<string, TemplateSymbol>
): boolean {
  return isDefineOnlyTypeExpression(target, line, symbols, templateSymbols, new Set());
}

function resolveTypeSymbolDefineOnly(
  symbol: TypeSymbol,
  symbols: Map<string, TypeSymbol>,
  templateSymbols: Map<string, TemplateSymbol>,
  seen: Set<string>
): boolean {
  if (symbol.kind === 'enum' || symbol.kind === 'template' || symbol.kind === 'struct') { return false; }
  if (seen.has(symbol.key)) { throw new Error(`Line ${symbol.line}: cyclic type alias "${symbol.key}"`); }
  seen.add(symbol.key);
  const result = isDefineOnlyTypeExpression(symbol.target!, symbol.line, symbols, templateSymbols, seen);
  seen.delete(symbol.key);
  return result;
}

function isDefineOnlyTypeExpression(
  target: string,
  line: number,
  symbols: Map<string, TypeSymbol>,
  templateSymbols: Map<string, TemplateSymbol>,
  seen: Set<string>
): boolean {
  if (parseExprOf(target) !== undefined) { return false; }
  const expression = parseCallExpression(target, line);
  if (expression) {
    const template = templateSymbols.get(expression.callee);
    if (template?.rawBody !== undefined) { return template.defineOnly; }
    throw new Error(`Line ${line}: unknown type template "${expression.callee}"`);
  }
  const symbol = symbols.get(target);
  if (!symbol) { throw new Error(`Line ${line}: unknown type "${target}"`); }
  return symbol.defineOnly || resolveTypeSymbolDefineOnly(symbol, symbols, templateSymbols, seen);
}
