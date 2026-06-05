import type { TemplateNode } from './parser';
import {
  type TemplateSymbol,
  type UseExpression,
  type LetStatement,
  type ReturnStatement,
  type AssignmentStatement,
  escapeRegex,
} from './cgenTypes';

type TypeResolver = (arg: string, line: number) => string;

export function applyRawBody(
  body: string,
  paramNames: string[],
  args: string[],
  line = 0,
  resolveTypeArg?: TypeResolver
): string {
  const paramMap = new Map(paramNames.map((name, index) => [name, args[index] ?? '']));
  let result = body;
  result = result.replace(/\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s+as\s+type\s*\}/g, (_match, name: string) => {
    const value = paramMap.get(name) ?? '';
    return resolveTypeArg ? resolveTypeArg(value, line) : value;
  });
  for (let i = 0; i < paramNames.length; i++) {
    result = result.replace(new RegExp(`\\$\\{${escapeRegex(paramNames[i])}\\}`, 'g'), args[i] ?? '');
  }
  return result;
}

function parseCExprFormat(source: string, line: number): { format: string; args: string[] } | undefined {
  const args = splitCallArgs(source, line);
  const quoted = args[0]?.match(/^"(.*)"$/);
  if (!quoted) { return undefined; }
  return { format: quoted[1], args: args.slice(1) };
}

export function buildRawCExprBody(source: string, line: number): string {
  const parsed = parseCExprFormat(source, line);
  if (parsed) {
    let index = 0;
    return parsed.format
      .replace(/%t\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => `\${${name} as type}`)
      .replace(/%t/g, () => {
        const arg = parsed.args[index++]?.trim() ?? '';
        return `\${${arg} as type}`;
      });
  }
  const arg = source.trim();
  const quoted = arg.match(/^"(.*)"$/);
  if (quoted) { return quoted[1]; }
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(arg) ? `\${${arg}}` : arg;
}

export function renderRawCExpr(
  source: string,
  line: number,
  resolveTypeArg: TypeResolver
): string {
  const parsed = parseCExprFormat(source, line);
  if (!parsed) { return source.trim().match(/^"(.*)"$/)?.[1] ?? source.trim(); }
  let index = 0;
  return parsed.format
    .replace(/%t\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => resolveTypeArg(name, line))
    .replace(/%t/g, () => resolveTypeArg(parsed.args[index++]?.trim() ?? '', line));
}

export function hasBalancedParens(source: string): boolean {
  let depth = 0;
  for (const char of source) {
    if (char === '(') { depth += 1; }
    else if (char === ')') {
      depth -= 1;
      if (depth < 0) { return false; }
    }
  }
  return depth === 0;
}

export function splitCallArgs(source: string, line: number): string[] {
  if (source.trim() === '') { return []; }
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') { depth += 1; }
    else if (char === ')') {
      depth -= 1;
      if (depth < 0) { throw new Error(`Line ${line}: unbalanced parentheses in template call`); }
    } else if (char === ',' && depth === 0) {
      args.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (depth !== 0) { throw new Error(`Line ${line}: unbalanced parentheses in template call`); }
  args.push(source.slice(start).trim());
  return args;
}

export function parseCallExpression(expression: string, line: number): UseExpression | undefined {
  const match = expression.match(/^([A-Za-z_][A-Za-z0-9_.]*)\((.*)\)$/);
  if (!match || !hasBalancedParens(match[2])) { return undefined; }
  return { callee: match[1], args: splitCallArgs(match[2], line) };
}

export function parseUseExpression(body: string, line: number): UseExpression {
  if (!body.startsWith('use ')) {
    throw new Error(`Line ${line}: template body must be \`use X(...)\``);
  }
  const expression = parseCallExpression(body.slice(4).trim(), line);
  if (!expression) {
    throw new Error(`Line ${line}: template body must be \`use X(...)\``);
  }
  return expression;
}

export function applyTemplateSymbol(
  templateKey: string,
  args: string[],
  line: number,
  templateSymbols: Map<string, TemplateSymbol>,
  resolveTypeArg?: TypeResolver
): string {
  const symbol = templateSymbols.get(templateKey);
  if (!symbol) { throw new Error(`Line ${line}: unknown template "${templateKey}"`); }
  if (symbol.rawBody !== undefined) {
    return applyRawBody(symbol.rawBody, symbol.rawParams ?? [], args, line, resolveTypeArg);
  }
  return `${symbol.macroName}(${args.join(', ')})`;
}

export function expandTemplateArgument(
  arg: string,
  line: number,
  templateSymbols: Map<string, TemplateSymbol>,
  callableParams: Set<string>,
  resolveTypeArg?: TypeResolver
): string {
  const expression = parseCallExpression(arg, line);
  if (!expression) {
    const symbol = templateSymbols.get(arg);
    return symbol ? symbol.macroName : arg;
  }
  const args = expression.args.map((nestedArg) => expandTemplateArgument(nestedArg, line, templateSymbols, callableParams, resolveTypeArg));
  if (callableParams.has(expression.callee)) { return `${expression.callee}(${args.join(', ')})`; }
  return applyTemplateSymbol(expression.callee, args, line, templateSymbols, resolveTypeArg);
}

export function expandTemplateBody(template: TemplateNode, templateSymbols: Map<string, TemplateSymbol>): string {
  if (!template.body) {
    throw new Error(`Line ${template.line}: template "${template.name}" has no body`);
  }
  if (template.bodyRaw) {
    const variadicParam = template.params.find((p) => p.variadic);
    let result = template.body;
    if (variadicParam) {
      result = result.replace(new RegExp(`\\$\\{${escapeRegex(variadicParam.name)}\\}`, 'g'), '__VA_ARGS__');
    }
    return result;
  }
  const expression = parseUseExpression(template.body, template.bodyLine);
  const callableParams = new Set(template.params.filter((p) => p.callable).map((p) => p.name));
  const variadicParam = template.params.find((p) => p.variadic);
  const args = expression.args.map((arg) => expandTemplateArgument(arg, template.bodyLine, templateSymbols, callableParams));
  let result = applyTemplateSymbol(expression.callee, args, template.bodyLine, templateSymbols);
  if (variadicParam) {
    result = result.replace(new RegExp(`\\$\\{${escapeRegex(variadicParam.name)}\\}`, 'g'), '__VA_ARGS__');
  }
  return result;
}

export function expandArgWithSubst(
  arg: string,
  line: number,
  templateSymbols: Map<string, TemplateSymbol>,
  paramMap: Map<string, string>,
  callableParamMap: Map<string, string>
): string {
  const expression = parseCallExpression(arg, line);
  if (expression) {
    const callee = callableParamMap.get(expression.callee) ?? expression.callee;
    const expandedArgs = expression.args.map((a) => expandArgWithSubst(a, line, templateSymbols, paramMap, callableParamMap));
    const symbol = templateSymbols.get(callee);
    if (symbol) {
      return symbol.rawBody !== undefined
        ? applyRawBody(symbol.rawBody, symbol.rawParams ?? [], expandedArgs)
        : `${symbol.macroName}(${expandedArgs.join(', ')})`;
    }
    return `${callee}(${expandedArgs.join(', ')})`;
  }
  if (paramMap.has(arg)) { return paramMap.get(arg)!; }
  const symbol = templateSymbols.get(arg);
  return symbol ? symbol.macroName : arg;
}

export function applyBodyTemplateInline(
  calleeTemplate: TemplateNode,
  args: string[],
  line: number,
  templateSymbols: Map<string, TemplateSymbol>
): string {
  const paramMap = new Map<string, string>();
  const callableParamMap = new Map<string, string>();
  calleeTemplate.params.forEach((p, i) => {
    if (p.variadic) { paramMap.set(p.name, args.slice(i).join(', ')); }
    else if (i < args.length) {
      paramMap.set(p.name, args[i]);
      if (p.callable) { callableParamMap.set(p.name, args[i]); }
    }
  });
  if (calleeTemplate.bodyRaw) {
    const paramNames = calleeTemplate.params.map((p) => p.name);
    const paramArgs = paramNames.map((name) => paramMap.get(name) ?? name);
    return applyRawBody(calleeTemplate.body, paramNames, paramArgs);
  }
  const expression = parseUseExpression(calleeTemplate.body, calleeTemplate.bodyLine);
  const expandedArgs = expression.args.map((arg) =>
    expandArgWithSubst(arg, calleeTemplate.bodyLine, templateSymbols, paramMap, callableParamMap)
  );
  return applyTemplateSymbol(expression.callee, expandedArgs, calleeTemplate.bodyLine, templateSymbols);
}

export function expandTemplateBodyInline(
  template: TemplateNode,
  templateSymbols: Map<string, TemplateSymbol>,
  bodyTemplates: Map<string, TemplateNode>
): string {
  if (template.bodyRaw) {
    const variadicParam = template.params.find((p) => p.variadic);
    let result = template.body;
    if (variadicParam) {
      result = result.replace(new RegExp(`\\$\\{${escapeRegex(variadicParam.name)}\\}`, 'g'), '__VA_ARGS__');
    }
    return result;
  }
  const expression = parseUseExpression(template.body, template.bodyLine);
  const callableParams = new Set(template.params.filter((p) => p.callable).map((p) => p.name));
  const variadicParam = template.params.find((p) => p.variadic);
  let args = expression.args.map((arg) => expandTemplateArgument(arg, template.bodyLine, templateSymbols, callableParams));
  if (variadicParam) {
    args = args.map((a) => a.replace(new RegExp(`\\$\\{${escapeRegex(variadicParam.name)}\\}`, 'g'), '__VA_ARGS__'));
  }
  const calleeTemplate = bodyTemplates.get(expression.callee);
  if (calleeTemplate) { return applyBodyTemplateInline(calleeTemplate, args, template.bodyLine, templateSymbols); }
  return applyTemplateSymbol(expression.callee, args, template.bodyLine, templateSymbols);
}

export function expandStructUse(
  useExpr: string | undefined,
  line: number,
  paramTemplates: Map<string, TemplateNode>,
  paramStructs: Map<string, import('./parser').StructNode> = new Map()
): import('./parser').TemplateField[] {
  if (!useExpr) { return []; }
  const call = parseCallExpression(useExpr, line);
  if (!call) { return []; }
  const template = paramTemplates.get(call.callee);
  if (!template) {
    const struct = paramStructs.get(call.callee);
    if (!struct) { return []; }
    const paramMap = new Map<string, string>();
    struct.params.forEach((param, i) => {
      if (i < call.args.length) { paramMap.set(param.name, call.args[i].trim()); }
    });
    return struct.fields.map((field) => ({
      name: field.name,
      target: paramMap.get(field.target) ?? field.target,
      mutable: field.mutable || struct.attributes.some((attr) => attr.name === 'mutable'),
      attributes: field.attributes,
      line: field.line
    }));
  }
  const paramMap = new Map<string, string>();
  template.params.forEach((param, i) => {
    if (i < call.args.length) { paramMap.set(param.name, call.args[i].trim()); }
  });
  return template.fields.map((field) => ({
    name: field.name,
    target: paramMap.get(field.target) ?? field.target,
    mutable: field.mutable || template.mutable,
    attributes: field.attributes,
    line: field.line
  }));
}

export function parseLetStatement(line: string): LetStatement | undefined {
  const match = line.match(/^let\s+([A-Za-z_][A-Za-z0-9_]*)\s+as\s+(.+?)\s*=\s*(.+)$/);
  if (!match) { return undefined; }
  return { name: match[1], type: match[2].trim(), expr: match[3].trim() };
}

export function parseReturnStatement(line: string): ReturnStatement | undefined {
  const match = line.match(/^return\s+(.+)$/);
  if (!match) { return undefined; }
  const typed = splitTrailingAsType(match[1]);
  return typed ? { expr: typed.expr, type: typed.type } : { expr: match[1].trim() };
}

export function splitTrailingAsType(source: string): { expr: string; type: string } | undefined {
  let depth = 0;
  let quote = '';
  let escaped = false;
  let separator = -1;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote) {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) { quote = ''; }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(') { depth += 1; continue; }
    if (char === ')') { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0 && source.slice(index, index + 4) === ' as ') {
      separator = index;
    }
  }
  if (separator < 0) { return undefined; }
  const expr = source.slice(0, separator).trim();
  const type = source.slice(separator + 4).trim();
  return expr && type ? { expr, type } : undefined;
}

export function parseAssignmentStatement(line: string): AssignmentStatement | undefined {
  const match = line.match(/^((?:self\.)?[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
  return match ? { target: match[1], expr: match[2].trim() } : undefined;
}

export function parseFnExprArgument(arg: string): string {
  return arg.match(/^"(.*)"$/)?.[1] ?? arg;
}

export function renderFnExpression(expr: string, methodSelfPointer: boolean): string {
  if (!methodSelfPointer) { return expr; }
  return expr.replace(/\bself\./g, 'self->');
}
