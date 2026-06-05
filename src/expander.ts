import {
  type CallableSymbol,
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
  for (let i = 0; i < paramNames.length; i++) {
    const arg = args[i] ?? '';
    let value = arg;
    if (resolveTypeArg) {
      try { value = resolveTypeArg(arg, line); }
      catch { value = arg; }
    }
    result = result.replace(new RegExp(`\\$\\{${escapeRegex(paramNames[i])}\\}`, 'g'), value);
  }
  return result;
}

export function buildRawCExprBody(source: string, line: number): string {
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
  return buildRawCExprBody(source, line);
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
      if (depth < 0) { throw new Error(`Line ${line}: unbalanced parentheses in callable call`); }
    } else if (char === ',' && depth === 0) {
      args.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (depth !== 0) { throw new Error(`Line ${line}: unbalanced parentheses in callable call`); }
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
    throw new Error(`Line ${line}: use body must be \`use X(...)\``);
  }
  const expression = parseCallExpression(body.slice(4).trim(), line);
  if (!expression) {
    throw new Error(`Line ${line}: use body must be \`use X(...)\``);
  }
  return expression;
}

export function applyCallableSymbol(
  callableKey: string,
  args: string[],
  line: number,
  callableSymbols: Map<string, CallableSymbol>,
  resolveTypeArg?: TypeResolver
): string {
  const symbol = callableSymbols.get(callableKey);
  if (!symbol) { throw new Error(`Line ${line}: unknown callable "${callableKey}"`); }
  if (symbol.rawBody !== undefined) {
    return applyRawBody(symbol.rawBody, symbol.rawParams ?? [], args, line, resolveTypeArg);
  }
  return `${symbol.macroName}(${args.join(', ')})`;
}

export function expandCallableArgument(
  arg: string,
  line: number,
  callableSymbols: Map<string, CallableSymbol>,
  resolveTypeArg?: TypeResolver
): string {
  const expression = parseCallExpression(arg, line);
  if (!expression) {
    const symbol = callableSymbols.get(arg);
    return symbol ? symbol.macroName : arg;
  }
  const args = expression.args.map((nestedArg) => expandCallableArgument(nestedArg, line, callableSymbols, resolveTypeArg));
  return applyCallableSymbol(expression.callee, args, line, callableSymbols, resolveTypeArg);
}

export function expandArgWithSubst(
  arg: string,
  line: number,
  callableSymbols: Map<string, CallableSymbol>,
  paramMap: Map<string, string>,
  callableParamMap: Map<string, string>
): string {
  const expression = parseCallExpression(arg, line);
  if (expression) {
    const callee = callableParamMap.get(expression.callee) ?? expression.callee;
    const expandedArgs = expression.args.map((a) => expandArgWithSubst(a, line, callableSymbols, paramMap, callableParamMap));
    const symbol = callableSymbols.get(callee);
    if (symbol) {
      return symbol.rawBody !== undefined
        ? applyRawBody(symbol.rawBody, symbol.rawParams ?? [], expandedArgs)
        : `${symbol.macroName}(${expandedArgs.join(', ')})`;
    }
    return `${callee}(${expandedArgs.join(', ')})`;
  }
  if (paramMap.has(arg)) { return paramMap.get(arg)!; }
  const symbol = callableSymbols.get(arg);
  return symbol ? symbol.macroName : arg;
}

export function expandStructUse(
  useExpr: string | undefined,
  line: number,
  paramStructs: Map<string, import('./parser').StructNode> = new Map()
): import('./parser').FieldNode[] {
  if (!useExpr) { return []; }
  const call = parseCallExpression(useExpr, line);
  if (!call) { return []; }
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
