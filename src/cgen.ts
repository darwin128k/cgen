import * as cp from 'child_process';
import * as path from 'path';
import * as util from 'util';
import * as vscode from 'vscode';
import { hashSource, type FileIndexEntry } from './indexer';
import {
  type SectionKind,
  type Attribute,
  type FnParam,
  type FnNode,
  type SectionNode,
  type TemplateParam,
  type TemplateField,
  type TemplateNode,
  type StructNode,
  type AliasNode,
  type EnumNode,
  type EnumMemberNode,
  type ParsedDsl,
  parseDsl,
  expandInlineDsl,
  createSection,
} from './parser';
import { formatCgen } from './formatter';

const execFile = util.promisify(cp.execFile);

export interface CgenConfig {
  build: {
    include: string;
    source: string;
  };
}

type EnumConstMode = 'static' | 'define' | 'extern';
type OutputTarget = 'header' | 'source' | 'both';

interface ModuleContext {
  pathParts: string[];
  guardParts: string[];
  symbolParts: string[];
  typeParts: string[];
}

interface ModuleArtifact {
  id: string;
  section: SectionNode;
  context: ModuleContext;
  guard: string;
  headerPathParts: string[];
  includePath: string;
  symbolPrefix: string;
  symbolParts: string[];
  typeParts: string[];
  dependencies: Set<string>;
  externHeaders: Set<string>;
  symbolRefs: Map<string, number>;
}

export interface SymbolUsageIndex {
  usedBy: Map<string, Array<{ moduleId: string; count: number }>>;
  totalCount: Map<string, number>;
}

export class DslError extends Error {
  constructor(message: string, public readonly root: SectionNode, public readonly perFileData: FileIndexEntry[] = []) {
    super(message);
  }
}

interface TypeSymbol {
  key: string;
  cName: string;
  moduleId: string;
  includePath: string;
  kind: 'alias' | 'enum' | 'template' | 'struct';
  target?: string;
  line: number;
  defineOnly: boolean;
}

interface TemplateSymbol {
  key: string;
  macroName: string;
  moduleId: string;
  includePath: string;
  inlineOnly: boolean;
  defineOnly: boolean;
  rawBody?: string;
  rawParams?: string[];
}

interface UseExpression {
  callee: string;
  args: string[];
}

interface LetStatement {
  name: string;
  type: string;
  expr: string;
}

type TypeDeclaration = AliasNode | EnumNode;

interface ScopedTypeDeclaration {
  declaration: TypeDeclaration;
  symbolParts: string[];
  typeParts: string[];
}


export async function loadConfig(workspaceFolder: vscode.WorkspaceFolder): Promise<CgenConfig> {
  const configUri = vscode.Uri.joinPath(workspaceFolder.uri, 'cgen.json');
  let raw: Uint8Array;

  try {
    raw = await vscode.workspace.fs.readFile(configUri);
  } catch {
    throw new Error(`Cannot find cgen.json in ${workspaceFolder.uri.fsPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw).toString('utf8'));
  } catch (error) {
    throw new Error(`Cannot parse cgen.json: ${String(error)}`);
  }

  const config = parsed as Partial<CgenConfig>;
  if (!config.build?.include || !config.build?.source) {
    throw new Error('cgen.json must contain build.include and build.source');
  }

  return {
    build: {
      include: config.build.include,
      source: config.build.source
    }
  };
}

interface DslArtifacts {
  root: SectionNode;
  modules: ModuleArtifact[];
  symbols: Map<string, TypeSymbol>;
  templateSymbols: Map<string, TemplateSymbol>;
  paramTemplates: Map<string, TemplateNode>;
  bodyTemplates: Map<string, TemplateNode>;
  usage: SymbolUsageIndex;
  perFileData: FileIndexEntry[];
}

async function buildDslArtifacts(workspaceFolder: vscode.WorkspaceFolder, extensionUri: vscode.Uri, source: string): Promise<DslArtifacts> {
  const allSources = await collectAllDslSources(workspaceFolder, extensionUri, source);
  const parsedList = allSources.map((s) => parseDsl(s.source));
  const merged = mergeDsls(parsedList);

  const perFileData: FileIndexEntry[] = allSources.map((s, i) => ({
    relativePath: s.relativePath,
    hash: hashSource(s.source),
    root: parsedList[i].root
  }));

  try {
    if (merged.diagnostics.length > 0) {
      throw new Error(merged.diagnostics.join('\n'));
    }

    const modules = collectModules(merged.root);
    const templateSymbols = buildTemplateSymbols(modules);
    const symbols = buildTypeSymbols(modules, templateSymbols);
    const paramTemplates = buildParamTemplateMap(modules);
    const bodyTemplates = buildBodyTemplateMap(modules);

    resolveModuleDependencies(modules, symbols, templateSymbols, paramTemplates);
    const usage = buildSymbolUsageIndex(modules);

    for (const module of modules) {
      if (module.headerPathParts.length === 0) { continue; }
      renderHeader(module, [], symbols, templateSymbols, paramTemplates, bodyTemplates);
      renderSource(module, symbols, templateSymbols, paramTemplates);
    }

    return { root: merged.root, modules, symbols, templateSymbols, paramTemplates, bodyTemplates, usage, perFileData };
  } catch (e) {
    throw new DslError(e instanceof Error ? e.message : String(e), merged.root, perFileData);
  }
}

export async function resolveDslUsage(workspaceFolder: vscode.WorkspaceFolder, extensionUri: vscode.Uri, source: string): Promise<{ root: SectionNode; usage: SymbolUsageIndex; perFileData: FileIndexEntry[] }> {
  const { root, usage, perFileData } = await buildDslArtifacts(workspaceFolder, extensionUri, source);
  return { root, usage, perFileData };
}

export async function generateDsl(workspaceFolder: vscode.WorkspaceFolder, extensionUri: vscode.Uri, source: string): Promise<{ files: string[]; root: SectionNode; usage: SymbolUsageIndex; perFileData: FileIndexEntry[] }> {
  const config = await loadConfig(workspaceFolder);
  const { root, modules, symbols, templateSymbols, paramTemplates, bodyTemplates, usage, perFileData } = await buildDslArtifacts(workspaceFolder, extensionUri, source);

  const generated: string[] = [];
  const includeRoot = resolveWorkspacePath(workspaceFolder, config.build.include);
  const sourceRoot = resolveWorkspacePath(workspaceFolder, config.build.source);

  for (const module of modules) {
    if (module.headerPathParts.length === 0) { continue; }
    const headerPath = path.join(includeRoot, ...module.headerPathParts);
    const includes = reduceTransitiveDependencies(module, modules)
      .map((moduleId) => modules.find((candidate) => candidate.id === moduleId))
      .filter((candidate): candidate is ModuleArtifact => candidate !== undefined)
      .map((candidate) => candidate.includePath)
      .filter((p) => p.length > 0)
      .sort();
    const text = renderHeader(module, includes, symbols, templateSymbols, paramTemplates, bodyTemplates);

    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(headerPath)));
    await vscode.workspace.fs.writeFile(vscode.Uri.file(headerPath), Buffer.from(text, 'utf8'));
    generated.push(headerPath);

    const sourceText = renderSource(module, symbols, templateSymbols, paramTemplates);
    if (sourceText) {
      const sourcePath = path.join(sourceRoot, ...module.context.pathParts, `${module.section.name}.c`);
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(sourcePath)));
      await vscode.workspace.fs.writeFile(vscode.Uri.file(sourcePath), Buffer.from(sourceText, 'utf8'));
      generated.push(sourcePath);
    }
  }

  await runClangFormat(workspaceFolder, generated);
  return { files: generated, root, usage, perFileData };
}

async function collectAllDslSources(workspaceFolder: vscode.WorkspaceFolder, extensionUri: vscode.Uri, primarySource: string): Promise<Array<{ relativePath: string | null; source: string }>> {
  const primaryFormatted = formatCgen(primarySource);
  const sources: Array<{ relativePath: string | null; source: string }> = [];
  const seen = new Set<string>();

  const packagesUri = vscode.Uri.joinPath(extensionUri, 'packages');
  try {
    const entries = await vscode.workspace.fs.readDirectory(packagesUri);
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.endsWith('.cgen')) {
        continue;
      }
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(packagesUri, name));
      const builtinSource = formatCgen(Buffer.from(bytes).toString('utf8'));
      if (!seen.has(builtinSource)) {
        seen.add(builtinSource);
        sources.push({ relativePath: null, source: builtinSource });
      }
    }
  } catch {
    // No bundled packages found.
  }

  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(workspaceFolder, '**/*.cgen'),
    '**/{node_modules,out,build,dist,releases}/**',
    256
  );

  for (const uri of files) {
    const relativePath = path.relative(workspaceFolder.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
    const bytes = await vscode.workspace.fs.readFile(uri);
    const fileSource = formatCgen(Buffer.from(bytes).toString('utf8'));
    if (!seen.has(fileSource)) {
      seen.add(fileSource);
      sources.push({ relativePath, source: fileSource });
    }
  }

  // Add primary source only if it differs from what's already on disk (unsaved changes)
  if (primaryFormatted && !seen.has(primaryFormatted)) {
    sources.push({ relativePath: null, source: primaryFormatted });
  }

  return sources;
}

function mergeDsls(parsedList: ParsedDsl[]): ParsedDsl {
  const root = createSection('root', '', 0);
  const diagnostics: string[] = [];

  for (const parsed of parsedList) {
    for (const child of parsed.root.children) {
      root.children.push(child);
    }
    for (const diagnostic of parsed.diagnostics) {
      diagnostics.push(diagnostic);
    }
  }

  return { root, diagnostics };
}

async function runClangFormat(workspaceFolder: vscode.WorkspaceFolder, files: string[]): Promise<void> {
  const clangFormatUri = vscode.Uri.joinPath(workspaceFolder.uri, '.clang-format');
  let raw: Uint8Array;

  try {
    raw = await vscode.workspace.fs.readFile(clangFormatUri);
  } catch {
    return;
  }

  const style = yamlToInlineStyle(Buffer.from(raw).toString('utf8'));

  try {
    await execFile('clang-format', [`--style=${style}`, '-i', ...files]);
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr?.trim() || (error instanceof Error ? error.message : String(error));
    vscode.window.showWarningMessage(`clang-format: ${detail}`);
  }
}

function yamlToInlineStyle(yaml: string): string {
  const entries = yaml
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line.length > 0 && line !== '---' && line !== '...');
  return `{${entries.join(', ')}}`;
}

function expandTemplateBody(template: TemplateNode, templateSymbols: Map<string, TemplateSymbol>): string {
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

function parseUseExpression(body: string, line: number): UseExpression {
  if (!body.startsWith('use ')) {
    throw new Error(`Line ${line}: template body must be \`use X(...)\``);
  }

  const expression = parseCallExpression(body.slice(4).trim(), line);
  if (!expression) {
    throw new Error(`Line ${line}: template body must be \`use X(...)\``);
  }

  return expression;
}

function parseCallExpression(expression: string, line: number): UseExpression | undefined {
  const match = expression.match(/^([A-Za-z_][A-Za-z0-9_.]*)\((.*)\)$/);
  if (!match || !hasBalancedParens(match[2])) {
    return undefined;
  }

  return {
    callee: match[1],
    args: splitCallArgs(match[2], line)
  };
}

function expandTemplateArgument(arg: string, line: number, templateSymbols: Map<string, TemplateSymbol>, callableParams: Set<string>): string {
  const expression = parseCallExpression(arg, line);
  if (!expression) {
    const symbol = templateSymbols.get(arg);
    return symbol ? symbol.macroName : arg;
  }

  const args = expression.args.map((nestedArg) => expandTemplateArgument(nestedArg, line, templateSymbols, callableParams));

  if (callableParams.has(expression.callee)) {
    return `${expression.callee}(${args.join(', ')})`;
  }

  return applyTemplateSymbol(expression.callee, args, line, templateSymbols);
}

function splitCallArgs(source: string, line: number): string[] {
  if (source.trim() === '') {
    return [];
  }

  const args: string[] = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth < 0) {
        throw new Error(`Line ${line}: unbalanced parentheses in template call`);
      }
    } else if (char === ',' && depth === 0) {
      args.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }

  if (depth !== 0) {
    throw new Error(`Line ${line}: unbalanced parentheses in template call`);
  }

  args.push(source.slice(start).trim());
  return args;
}

function hasBalancedParens(source: string): boolean {
  let depth = 0;

  for (const char of source) {
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
    }
  }

  return depth === 0;
}

function applyTemplateSymbol(templateKey: string, args: string[], line: number, templateSymbols: Map<string, TemplateSymbol>): string {
  const symbol = templateSymbols.get(templateKey);
  if (!symbol) {
    throw new Error(`Line ${line}: unknown template "${templateKey}"`);
  }

  if (symbol.rawBody !== undefined) {
    return applyRawBody(symbol.rawBody, symbol.rawParams ?? [], args);
  }

  return `${symbol.macroName}(${args.join(', ')})`;
}


function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyRawBody(body: string, paramNames: string[], args: string[]): string {
  let result = body;
  for (let i = 0; i < paramNames.length; i++) {
    result = result.replace(new RegExp(`\\$\\{${escapeRegex(paramNames[i])}\\}`, 'g'), args[i] ?? '');
  }
  return result;
}

function makeMacroName(symbolParts: string[], name: string): string {
  const parts = [...symbolParts];
  if (parts[parts.length - 1] !== name) {
    parts.push(name);
  }

  return parts.filter(Boolean).join('_');
}

function collectModules(root: SectionNode): ModuleArtifact[] {
  const modules: ModuleArtifact[] = [];

  for (const child of root.children) {
    if (child.kind !== 'scope') { continue; }
    const ctx: ModuleContext = {
      pathParts: [],
      guardParts: [child.name],
      symbolParts: [child.name],
      typeParts: [child.name]
    };
    modules.push({
      id: `__scope__/${child.name}`,
      section: child,
      context: ctx,
      guard: makeGuard([child.name]),
      headerPathParts: [],
      includePath: '',
      symbolPrefix: child.name,
      symbolParts: [child.name],
      typeParts: [child.name],
      dependencies: new Set<string>(),
      externHeaders: new Set<string>(),
      symbolRefs: new Map<string, number>()
    });
  }

  walkSections(root, {
    pathParts: [],
    guardParts: [],
    symbolParts: [],
    typeParts: []
  }, (section, context) => {
    const headerPathParts = [...context.pathParts, `${section.name}.h`];
    const includePath = headerPathParts.join('/');
    const id = includePath;

    modules.push({
      id,
      section,
      context,
      guard: makeGuard(context.guardParts),
      headerPathParts,
      includePath,
      symbolPrefix: context.symbolParts.join('_'),
      symbolParts: context.symbolParts,
      typeParts: context.typeParts,
      dependencies: new Set<string>(),
      externHeaders: new Set<string>(),
      symbolRefs: new Map<string, number>()
    });
  });

  return modules;
}

function walkSections(
  section: SectionNode,
  context: ModuleContext,
  onModule: (section: SectionNode, context: ModuleContext) => void
): void {
  for (const child of section.children) {

    const next = applySectionContext(child, context);
    if (child.kind === 'module') {
      onModule(child, next);
    }

    walkSections(child, next, onModule);
  }
}

function applySectionContext(section: SectionNode, context: ModuleContext): ModuleContext {
  if (section.kind === 'root' || section.kind === 'scope') {
    return context;
  }

  const guardOnly = hasAttribute(section, 'scope', 'guard');
  return {
    pathParts: section.kind === 'package' ? [...context.pathParts, section.name] : context.pathParts,
    guardParts: [...context.guardParts, section.name],
    symbolParts: guardOnly ? context.symbolParts : [...context.symbolParts, section.name],
    typeParts: [...context.typeParts, section.name]
  };
}

function hasAttribute(node: SectionNode | AliasNode | EnumNode, name: string, arg?: string): boolean {
  return node.attributes.some((attribute) => {
    if (attribute.name !== name) {
      return false;
    }

    return arg === undefined || attribute.args.includes(arg);
  });
}

function hasAttr(attributes: Attribute[], name: string, arg?: string): boolean {
  return attributes.some((attribute) => {
    if (attribute.name !== name) {
      return false;
    }

    return arg === undefined || attribute.args.includes(arg);
  });
}

function isTemplateMutable(template: TemplateNode): boolean {
  return hasAttr(template.attributes, 'template', 'mutable');
}

function isFieldMutable(field: TemplateField, template?: TemplateNode): boolean {
  return field.mutable || (template ? isTemplateMutable(template) : false);
}

function renderFieldDeclaration(field: TemplateField, typeName: string, template?: TemplateNode): string {
  const prefix = isFieldMutable(field, template) ? '' : 'const ';
  return `${prefix}${typeName} ${field.name}`;
}

function getHeaderArg(attributes: Attribute[]): string | undefined {
  for (const attr of attributes) {
    if (attr.name === 'header' && attr.args.length > 0) {
      return attr.args[0].replace(/^"(.*)"$/, '$1');
    }
  }
  return undefined;
}

function parseExprOf(target: string): string | undefined {
  const match = target.match(/^c\.expr\("(.*)"\)$/);
  return match ? match[1] : undefined;
}

function buildTypeSymbols(modules: ModuleArtifact[], templateSymbols: Map<string, TemplateSymbol>): Map<string, TypeSymbol> {
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
        kind: declaration.kind,
        target: declaration.target,
        line: declaration.line,
        defineOnly: declaration.kind === 'alias' && declaration.attributes.some((a) => a.name === 'alias' && a.args[0] === 'define')
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
        key,
        cName,
        moduleId: module.id,
        includePath: module.includePath,
        kind: 'template',
        line: template.line,
        defineOnly: false
      });
    }

    for (const { struct, symbolParts, typeParts } of collectScopeStructs(module.section, [])) {
      const key = makeTypeKey([...module.typeParts, ...typeParts], struct.name);
      const cName = makeTypedefName([...module.symbolParts, ...symbolParts], struct.name);
      const existing = symbols.get(key);

      if (existing) {
        throw new Error(`Line ${struct.line}: type "${key}" is already defined in ${existing.includePath}`);
      }

      symbols.set(key, {
        key,
        cName,
        moduleId: module.id,
        includePath: module.includePath,
        kind: 'struct',
        line: struct.line,
        defineOnly: false
      });
    }
  }

  for (const symbol of symbols.values()) {
    if (symbol.defineOnly) { continue; }
    symbol.defineOnly = resolveTypeSymbolDefineOnly(symbol, symbols, templateSymbols, new Set());
  }

  return symbols;
}

function collectScopeTemplates(
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

function collectScopeStructs(
  section: SectionNode,
  extraParts: string[]
): Array<{ struct: StructNode; symbolParts: string[]; typeParts: string[] }> {
  const result = section.structs.map((struct) => ({ struct, symbolParts: extraParts, typeParts: extraParts }));
  for (const child of section.children) {
    if (child.kind === 'scope') {
      result.push(...collectScopeStructs(child, [...extraParts, child.name]));
    }
  }
  return result;
}

function buildParamTemplateMap(modules: ModuleArtifact[]): Map<string, TemplateNode> {
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

function buildBodyTemplateMap(modules: ModuleArtifact[]): Map<string, TemplateNode> {
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

function expandArgWithSubst(
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

function applyBodyTemplateInline(
  calleeTemplate: TemplateNode,
  args: string[],
  line: number,
  templateSymbols: Map<string, TemplateSymbol>
): string {
  const paramMap = new Map<string, string>();
  const callableParamMap = new Map<string, string>();
  calleeTemplate.params.forEach((p, i) => {
    if (p.variadic) {
      paramMap.set(p.name, args.slice(i).join(', '));
    } else if (i < args.length) {
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

function expandTemplateBodyInline(
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
  if (calleeTemplate) {
    return applyBodyTemplateInline(calleeTemplate, args, template.bodyLine, templateSymbols);
  }
  return applyTemplateSymbol(expression.callee, args, template.bodyLine, templateSymbols);
}

function expandStructUse(
  useExpr: string | undefined,
  line: number,
  paramTemplates: Map<string, TemplateNode>
): TemplateField[] {
  if (!useExpr) { return []; }
  const call = parseCallExpression(useExpr, line);
  if (!call) { return []; }

  const template = paramTemplates.get(call.callee);
  if (!template) { return []; }

  const paramMap = new Map<string, string>();
  template.params.forEach((param, i) => {
    if (i < call.args.length) {
      paramMap.set(param.name, call.args[i].trim());
    }
  });

  return template.fields.map((field) => ({
    name: field.name,
    target: paramMap.get(field.target) ?? field.target,
    mutable: field.mutable,
    attributes: field.attributes,
    line: field.line
  }));
}

function buildTemplateSymbols(modules: ModuleArtifact[]): Map<string, TemplateSymbol> {
  const symbols = new Map<string, TemplateSymbol>();
  for (const module of modules) {
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

      if (template.fields.length > 0 && template.params.length === 0) {
        continue;
      }

      symbols.set(key, {
        key,
        macroName,
        moduleId: module.id,
        includePath: module.includePath,
        inlineOnly: template.attributes.some((a) => a.name === 'template' && a.args.includes('inline')),
        defineOnly: template.attributes.some((a) => a.name === 'template' && a.args.includes('define')),
        ...(template.bodyRaw && template.body ? { rawBody: template.body, rawParams: template.params.map((p) => p.name) } : {})
      });
    }
  }

  return symbols;
}

function addDep(module: ModuleArtifact, otherModuleId: string): void {
  if (otherModuleId !== module.id) {
    module.dependencies.add(otherModuleId);
  }
}

function addSymbolRef(module: ModuleArtifact, symbolKey: string): void {
  module.symbolRefs.set(symbolKey, (module.symbolRefs.get(symbolKey) ?? 0) + 1);
}

function resolveModuleDependencies(
  modules: ModuleArtifact[],
  symbols: Map<string, TypeSymbol>,
  templateSymbols: Map<string, TemplateSymbol>,
  paramTemplates: Map<string, TemplateNode>
): void {
  for (const module of modules) {
    for (const { declaration } of collectScopeTypeDeclarations(module.section, [])) {
      const header = getHeaderArg(declaration.attributes);
      if (header) { module.externHeaders.add(header); }
      for (const symbol of getTypeExpressionSymbols(declaration.target, declaration.line, symbols, templateSymbols)) {
        addDep(module, symbol.moduleId);
        addSymbolRef(module, symbol.key);
      }
    }

    for (const { template } of collectScopeTemplates(module.section, [])) {
      const header = getHeaderArg(template.attributes);
      if (header) { module.externHeaders.add(header); }

      if (template.fields.length > 0 && template.params.length > 0) {
        const paramNames = new Set(template.params.map((p) => p.name));
        for (const field of template.fields) {
          if (paramNames.has(field.target)) { continue; }
          for (const symbol of getTypeExpressionSymbols(field.target, field.line, symbols, templateSymbols)) {
            addDep(module, symbol.moduleId);
            addSymbolRef(module, symbol.key);
          }
        }
        continue;
      }

      if (template.fields.length > 0) {
        for (const field of template.fields) {
          for (const symbol of getTypeExpressionSymbols(field.target, field.line, symbols, templateSymbols)) {
            addDep(module, symbol.moduleId);
            addSymbolRef(module, symbol.key);
          }
        }
        continue;
      }

      if (template.bodyRaw) { continue; }

      if (template.bodyInline) {
        const expression = parseUseExpression(template.body, template.bodyLine);
        const fieldTemplate = paramTemplates.get(expression.callee);
        if (fieldTemplate) {
          const outerParamNames = new Set(template.params.map((p) => p.name));
          const innerParamMap = new Map<string, string>();
          fieldTemplate.params.forEach((p, i) => {
            if (i < expression.args.length) { innerParamMap.set(p.name, expression.args[i].trim()); }
          });
          for (const field of fieldTemplate.fields) {
            const mappedTarget = innerParamMap.get(field.target) ?? field.target;
            if (outerParamNames.has(mappedTarget)) { continue; }
            for (const sym of getTypeExpressionSymbols(mappedTarget, field.line, symbols, templateSymbols)) {
              addDep(module, sym.moduleId);
              addSymbolRef(module, sym.key);
            }
          }
        }
        continue;
      }

      for (const usedTemplate of getUsedTemplateSymbols(template, templateSymbols)) {
        addDep(module, usedTemplate.moduleId);
        addSymbolRef(module, usedTemplate.key);
      }
    }

    for (const { struct } of collectScopeStructs(module.section, [])) {
      for (const field of struct.fields) {
        for (const symbol of getTypeExpressionSymbols(field.target, field.line, symbols, templateSymbols)) {
          addDep(module, symbol.moduleId);
          addSymbolRef(module, symbol.key);
        }
      }
      for (const use of (struct.uses ?? [])) {
        if (use.inline) {
          for (const field of expandStructUse(use.expr, struct.line, paramTemplates)) {
            for (const sym of getTypeExpressionSymbols(field.target, field.line, symbols, templateSymbols)) {
              addDep(module, sym.moduleId);
              addSymbolRef(module, sym.key);
            }
          }
          continue;
        }
        const call = parseCallExpression(use.expr, struct.line);
        if (!call) { continue; }
        const tmpl = templateSymbols.get(call.callee);
        if (tmpl) { addDep(module, tmpl.moduleId); addSymbolRef(module, tmpl.key); }
        for (const arg of call.args) {
          for (const sym of getTypeExpressionSymbols(arg, struct.line, symbols, templateSymbols)) {
            addDep(module, sym.moduleId);
            addSymbolRef(module, sym.key);
          }
        }
      }
      for (const fn of struct.fns) {
        for (const p of fn.params) {
          if (p.variadic) { continue; }
          for (const symbol of getTypeExpressionSymbols(p.type, p.line, symbols, templateSymbols)) {
            addDep(module, symbol.moduleId);
            addSymbolRef(module, symbol.key);
          }
        }
        const returnTargets = fn.returnType === 'any'
          ? inferStructMethodReturnTargets(fn, struct, paramTemplates)
          : [fn.returnType];
        for (const returnTarget of returnTargets) {
          for (const symbol of getTypeExpressionSymbols(returnTarget, fn.line, symbols, templateSymbols)) {
            addDep(module, symbol.moduleId);
            addSymbolRef(module, symbol.key);
          }
        }
        addFnBodyDependencies(module, fn, symbols, templateSymbols);
      }
    }

    for (const { fn } of collectScopeFns(module.section, [])) {
      for (const p of fn.params) {
        if (p.variadic) { continue; }
        for (const symbol of getTypeExpressionSymbols(p.type, p.line, symbols, templateSymbols)) {
          addDep(module, symbol.moduleId);
          addSymbolRef(module, symbol.key);
        }
      }
      if (fn.returnType === 'any') {
        throw new Error(`Line ${fn.line}: any return type is only supported for struct methods`);
      }
      for (const symbol of getTypeExpressionSymbols(fn.returnType, fn.line, symbols, templateSymbols)) {
        addDep(module, symbol.moduleId);
        addSymbolRef(module, symbol.key);
      }
      addFnBodyDependencies(module, fn, symbols, templateSymbols);
    }
  }

  const byId = new Map(modules.map((m) => [m.id, m]));
  for (const module of modules) {
    for (const depId of [...module.dependencies]) {
      const dep = byId.get(depId);
      if (dep && dep.headerPathParts.length === 0) {
        for (const header of dep.externHeaders) {
          module.externHeaders.add(header);
        }
        module.dependencies.delete(depId);
      }
    }
  }
}

function buildSymbolUsageIndex(modules: ModuleArtifact[]): SymbolUsageIndex {
  const usedBy = new Map<string, Array<{ moduleId: string; count: number }>>();
  const totalCount = new Map<string, number>();

  for (const module of modules) {
    for (const [symbolKey, count] of module.symbolRefs) {
      let refs = usedBy.get(symbolKey);
      if (!refs) { refs = []; usedBy.set(symbolKey, refs); }
      refs.push({ moduleId: module.id, count });
      totalCount.set(symbolKey, (totalCount.get(symbolKey) ?? 0) + count);
    }
  }

  return { usedBy, totalCount };
}

function getUsedTemplateSymbols(template: TemplateNode, templateSymbols: Map<string, TemplateSymbol>): TemplateSymbol[] {
  if (template.bodyRaw) { return []; }
  const expression = parseUseExpression(template.body, template.bodyLine);
  const callableParams = new Set(template.params.filter((p) => p.callable).map((p) => p.name));
  const result: TemplateSymbol[] = [];

  collectUsedTemplateSymbols(expression, template.bodyLine, templateSymbols, result, callableParams);
  return result;
}

function collectUsedTemplateSymbols(
  expression: UseExpression,
  line: number,
  templateSymbols: Map<string, TemplateSymbol>,
  result: TemplateSymbol[],
  callableParams: Set<string>
): void {
  if (!callableParams.has(expression.callee)) {
    const symbol = templateSymbols.get(expression.callee);
    if (!symbol) {
      throw new Error(`Line ${line}: unknown template "${expression.callee}"`);
    }
    if (!symbol.rawBody && !symbol.inlineOnly) {
      result.push(symbol);
    }
  }

  for (const arg of expression.args) {
    const nested = parseCallExpression(arg, line);
    if (nested) {
      collectUsedTemplateSymbols(nested, line, templateSymbols, result, callableParams);
    }
  }
}

function addFnBodyDependencies(
  module: ModuleArtifact,
  fn: FnNode,
  symbols: Map<string, TypeSymbol>,
  templateSymbols: Map<string, TemplateSymbol>
): void {
  for (const line of fn.body) {
    const letStatement = parseLetStatement(line);
    if (letStatement) {
      for (const symbol of getTypeExpressionSymbols(letStatement.type, fn.line, symbols, templateSymbols)) {
        addDep(module, symbol.moduleId);
        addSymbolRef(module, symbol.key);
      }
      addFnExpressionDependencies(module, letStatement.expr, fn.line, templateSymbols);
      continue;
    }

    if (/^return\s+/.test(line)) {
      addFnExpressionDependencies(module, line.slice('return '.length).trim(), fn.line, templateSymbols);
      continue;
    }

    if (/^use\s+c\.expr\(/.test(line)) {
      continue;
    }

    if (/^use\s+/.test(line)) {
      addFnUseExpressionDependencies(module, parseUseExpression(line, fn.line), fn.line, templateSymbols);
    }
  }
}

function addFnExpressionDependencies(
  module: ModuleArtifact,
  expr: string,
  line: number,
  templateSymbols: Map<string, TemplateSymbol>
): void {
  const expression = parseCallExpression(expr, line);
  if (expression) {
    addFnUseExpressionDependencies(module, expression, line, templateSymbols);
  }
}

function addFnUseExpressionDependencies(
  module: ModuleArtifact,
  expression: UseExpression,
  line: number,
  templateSymbols: Map<string, TemplateSymbol>
): void {
  const used: TemplateSymbol[] = [];
  collectUsedTemplateSymbols(expression, line, templateSymbols, used, new Set());
  for (const symbol of used) {
    addDep(module, symbol.moduleId);
    addSymbolRef(module, symbol.key);
  }
}

function reduceTransitiveDependencies(module: ModuleArtifact, modules: ModuleArtifact[]): string[] {
  const direct = new Set(module.dependencies);
  const byId = new Map(modules.map((candidate) => [candidate.id, candidate]));

  for (const dependencyId of module.dependencies) {
    const dependency = byId.get(dependencyId);
    if (!dependency) {
      continue;
    }

    for (const transitiveId of collectTransitiveDependencies(dependency, byId)) {
      direct.delete(transitiveId);
    }
  }

  return [...direct];
}

function collectTransitiveDependencies(module: ModuleArtifact, byId: Map<string, ModuleArtifact>): Set<string> {
  const result = new Set<string>();
  const stack = [...module.dependencies];

  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || result.has(id)) {
      continue;
    }

    result.add(id);
    const dependency = byId.get(id);
    if (dependency) {
      stack.push(...dependency.dependencies);
    }
  }

  return result;
}

function collectScopeFns(
  section: SectionNode,
  extraParts: string[]
): Array<{ fn: FnNode; symbolParts: string[] }> {
  const result = section.fns.map((fn) => ({ fn, symbolParts: extraParts }));
  for (const child of section.children) {
    if (child.kind === 'scope') {
      result.push(...collectScopeFns(child, [...extraParts, child.name]));
    }
  }
  return result;
}

function getFnSpecifiers(fn: FnNode): string {
  const fnAttrs = fn.attributes.filter((a) => a.name === 'fn');
  if (fnAttrs.length === 0) { return ''; }
  const last = fnAttrs[fnAttrs.length - 1];
  const valid = new Set(['static', 'extern', 'inline']);
  for (const arg of last.args) {
    if (!valid.has(arg)) {
      throw new Error(`Line ${last.line}: @fn only supports static, extern, inline`);
    }
  }
  return last.args.join(' ');
}

function getFnOutputTarget(fn: FnNode): OutputTarget {
  const pubAttrs = fn.attributes.filter((a) => a.name === 'pub');
  if (pubAttrs.length === 0) { return fn.body.length > 0 ? 'both' : 'header'; }
  const last = pubAttrs[pubAttrs.length - 1];
  if (last.args.length !== 1 || !['header', 'source', 'all'].includes(last.args[0])) {
    throw new Error(`Line ${last.line}: @pub only supports @pub(header), @pub(source), and @pub(all)`);
  }
  return last.args[0] === 'all' ? 'both' : last.args[0] as OutputTarget;
}

function makeFnSignature(
  fn: FnNode,
  fnCName: string,
  symbols: Map<string, TypeSymbol>,
  templateSymbols: Map<string, TemplateSymbol>,
  leadingParams: string[] = []
): string {
  const specifiers = getFnSpecifiers(fn);
  const prefix = specifiers ? `${specifiers} ` : '';
  const returnC = resolveFnReturnType(fn, symbols, templateSymbols);
  const params = [
    ...leadingParams,
    ...fn.params.map((p) => p.variadic ? '...' : renderFnParam(p, symbols, templateSymbols))
  ];
  const paramsC = params.length > 0
    ? params.join(', ')
    : 'void';
  return `${prefix}${returnC} ${fnCName}(${paramsC})`;
}

function resolveFnReturnType(
  fn: FnNode,
  symbols: Map<string, TypeSymbol>,
  templateSymbols: Map<string, TemplateSymbol>
): string {
  if (fn.returnType !== 'any') {
    return resolveTypeExpression(fn.returnType, fn.line, symbols, templateSymbols);
  }

  throw new Error(`Line ${fn.line}: any return type is only supported for struct methods`);
}

function renderFnParam(
  param: FnParam,
  symbols: Map<string, TypeSymbol>,
  templateSymbols: Map<string, TemplateSymbol>
): string {
  const typeName = resolveTypeExpression(param.type, param.line, symbols, templateSymbols);
  const prefix = param.mutable ? '' : 'const ';
  return `${prefix}${typeName} ${param.name}`;
}

function makeStructMethodSignature(
  fn: FnNode,
  fnCName: string,
  symbols: Map<string, TypeSymbol>,
  templateSymbols: Map<string, TemplateSymbol>,
  selfTypeName: string,
  struct: StructNode,
  paramTemplates: Map<string, TemplateNode>
): string {
  const specifiers = getFnSpecifiers(fn);
  const prefix = specifiers ? `${specifiers} ` : '';
  const returnC = resolveStructMethodReturnType(fn, struct, paramTemplates, symbols, templateSymbols);
  const selfPrefix = fn.selfMutable ? '' : 'const ';
  const params = [`${selfPrefix}${selfTypeName} *self`, ...fn.params.map((p) => p.variadic ? '...' : renderFnParam(p, symbols, templateSymbols))];
  const paramsC = params.join(', ');
  return `${prefix}${returnC} ${fnCName}(${paramsC})`;
}

function resolveStructMethodReturnType(
  fn: FnNode,
  struct: StructNode,
  paramTemplates: Map<string, TemplateNode>,
  symbols: Map<string, TypeSymbol>,
  templateSymbols: Map<string, TemplateSymbol>
): string {
  if (fn.returnType !== 'any') {
    return resolveTypeExpression(fn.returnType, fn.line, symbols, templateSymbols);
  }

  const fieldName = inferReturnedSelfField(fn);
  if (!fieldName) {
    throw new Error(`Line ${fn.bodyLine || fn.line}: cannot infer any return type`);
  }

  const field = getStructFields(struct, paramTemplates).find((candidate) => candidate.name === fieldName);
  if (!field) {
    throw new Error(`Line ${fn.bodyLine || fn.line}: cannot infer any return type, unknown field "self.${fieldName}"`);
  }

  return resolveTypeExpression(field.target, field.line, symbols, templateSymbols);
}

function inferStructMethodReturnTargets(
  fn: FnNode,
  struct: StructNode,
  paramTemplates: Map<string, TemplateNode>
): string[] {
  const fieldName = inferReturnedSelfField(fn);
  if (!fieldName) {
    throw new Error(`Line ${fn.bodyLine || fn.line}: cannot infer any return type`);
  }

  const field = getStructFields(struct, paramTemplates).find((candidate) => candidate.name === fieldName);
  if (!field) {
    throw new Error(`Line ${fn.bodyLine || fn.line}: cannot infer any return type, unknown field "self.${fieldName}"`);
  }

  return [field.target];
}

function inferReturnedSelfField(fn: FnNode): string | undefined {
  if (fn.body.length !== 1) { return undefined; }
  return fn.body[0].match(/^return\s+self\.([A-Za-z_][A-Za-z0-9_]*)$/)?.[1];
}

function getStructFields(struct: StructNode, paramTemplates: Map<string, TemplateNode>): TemplateField[] {
  const fields = [...struct.fields];
  for (const use of (struct.uses ?? [])) {
    fields.push(...expandStructUse(use.expr, struct.line, paramTemplates));
  }
  return fields;
}

function renderFnBody(
  fn: FnNode,
  symbols: Map<string, TypeSymbol>,
  templateSymbols: Map<string, TemplateSymbol>,
  methodSelfPointer = false
): string[] {
  return fn.body.map((line) => renderFnBodyLine(line, fn.line, symbols, templateSymbols, methodSelfPointer));
}

function renderFnBodyLine(
  line: string,
  fnLine: number,
  symbols: Map<string, TypeSymbol>,
  templateSymbols: Map<string, TemplateSymbol>,
  methodSelfPointer: boolean
): string {
  const letStatement = parseLetStatement(line);
  if (letStatement) {
    const typeName = resolveTypeExpression(letStatement.type, fnLine, symbols, templateSymbols);
    const expr = renderFnExpression(letStatement.expr, methodSelfPointer);
    const expanded = expandTemplateArgument(expr, fnLine, templateSymbols, new Set());
    return `  ${typeName} ${letStatement.name} = ${expanded};`;
  }

  const exprOfMatch = line.match(/^use\s+c\.expr\((.*)\)$/);
  if (exprOfMatch) {
    return `  ${parseFnExprArgument(exprOfMatch[1].trim())}`;
  }

  if (/^return\s+/.test(line)) {
    const expr = renderFnExpression(line.slice('return '.length).trim(), methodSelfPointer);
    const expanded = expandTemplateArgument(expr, fnLine, templateSymbols, new Set());
    return `  return ${expanded};`;
  }

  if (/^use\s+/.test(line)) {
    const expression = parseUseExpression(renderFnExpression(line, methodSelfPointer), fnLine);
    const args = expression.args.map((arg) => expandTemplateArgument(arg, fnLine, templateSymbols, new Set()));
    const expanded = applyTemplateSymbol(expression.callee, args, fnLine, templateSymbols);
    return `  ${expanded};`;
  }

  throw new Error(`Line ${fnLine}: function bodies only support \`let name -> type = expr\`, \`return expr\`, and \`use c.expr(...)\``);
}

function parseLetStatement(line: string): LetStatement | undefined {
  const match = line.match(/^let\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+|\s+->\s*)(.+?)\s*=\s*(.+)$/);
  if (!match) {
    return undefined;
  }

  return {
    name: match[1],
    type: match[2].trim(),
    expr: match[3].trim()
  };
}

function parseFnExprArgument(arg: string): string {
  return arg.match(/^"(.*)"$/)?.[1] ?? arg;
}

function renderFnExpression(expr: string, methodSelfPointer: boolean): string {
  if (!methodSelfPointer) { return expr; }
  return expr.replace(/\bself\./g, 'self->');
}

function makeFnCName(module: ModuleArtifact, symbolParts: string[], fnName: string): string {
  const nameParts = [...module.symbolParts, ...symbolParts];
  if (nameParts[nameParts.length - 1] !== fnName) { nameParts.push(fnName); }
  return nameParts.join('_');
}

function makeStructMethodCName(module: ModuleArtifact, symbolParts: string[], structName: string, fnName: string): string {
  const nameParts = [...module.symbolParts, ...symbolParts];
  if (nameParts[nameParts.length - 1] !== structName) { nameParts.push(structName); }
  if (nameParts[nameParts.length - 1] !== fnName) { nameParts.push(fnName); }
  return nameParts.join('_');
}

function renderHeader(
  module: ModuleArtifact,
  includes: string[],
  symbols: Map<string, TypeSymbol>,
  templateSymbols: Map<string, TemplateSymbol>,
  paramTemplates: Map<string, TemplateNode>,
  bodyTemplates: Map<string, TemplateNode>
): string {
  const lines = [
    `#ifndef ${module.guard}`,
    `#define ${module.guard}`,
    ''
  ];

  for (const header of [...module.externHeaders].sort()) {
    lines.push(`#include <${header}>`);
  }

  for (const includePath of includes) {
    lines.push(`#include <${includePath}>`);
  }

  if (module.externHeaders.size > 0 || includes.length > 0) {
    lines.push('');
  }

  for (const { declaration, symbolParts } of collectScopeTypeDeclarations(module.section, [])) {
    const allSymbolParts = [...module.symbolParts, ...symbolParts];
    if (declaration.kind === 'alias') {
      const type = resolveTypeExpression(declaration.target, declaration.line, symbols, templateSymbols);
      const cName = makeTypedefName(allSymbolParts, declaration.name);
      const aliasKey = makeTypeKey([...module.typeParts, ...symbolParts], declaration.name);
      const defineOnly = symbols.get(aliasKey)?.defineOnly ?? shouldDefineAlias(declaration.target, declaration.line, symbols, templateSymbols);
      lines.push(defineOnly ? `#define ${cName} ${type}` : `typedef ${type} ${cName};`);
      continue;
    }

    const type = resolveTypeExpression(declaration.target, declaration.line, symbols, templateSymbols);
    const cName = makeTypedefName(allSymbolParts, declaration.name);
    lines.push(`typedef ${type} ${cName};`);

    if (declaration.members.length > 0) {
      lines.push('');
    }

    declaration.members.forEach((member, index) => {
      const mode = getEnumConstMode(declaration);
      const target = getEnumOutputTarget(declaration);

      if (shouldOutputHeaderCase(mode, target)) {
        lines.push(renderEnumCaseForHeader(allSymbolParts, declaration, member, index, cName, mode));
      }
    });
  }

  for (const { template, symbolParts } of collectScopeTemplates(module.section, [])) {
    const allSymbolParts = [...module.symbolParts, ...symbolParts];
    if (template.fields.length > 0 && template.params.length > 0) {
      const paramNames = new Set(template.params.map((p) => p.name));
      const paramList = template.params.map((p) => p.name).join(', ');
      const fieldDefs = template.fields.map((field, index) => {
        const typeName = paramNames.has(field.target)
          ? field.target
          : resolveTypeExpression(field.target, field.line, symbols, templateSymbols);
        const semi = index < template.fields.length - 1 ? ';' : '';
        return `${renderFieldDeclaration(field, typeName, template)}${semi}`;
      }).join(' ');
      lines.push(`#define ${makeMacroName(allSymbolParts, template.name)}(${paramList}) ${fieldDefs}`);
      continue;
    }

    if (template.fields.length > 0) {
      const cName = makeTypedefName(allSymbolParts, template.name);
      lines.push(`typedef struct ${cName} {`);
      for (const field of template.fields) {
        const typeName = resolveTypeExpression(field.target, field.line, symbols, templateSymbols);
        lines.push(`  ${renderFieldDeclaration(field, typeName, template)};`);
      }
      lines.push(`} ${cName};`);
      continue;
    }

    const typeKeyParts = [...module.typeParts, ...symbolParts];
    if (typeKeyParts[typeKeyParts.length - 1] !== template.name) { typeKeyParts.push(template.name); }
    if (templateSymbols.get(typeKeyParts.join('.'))?.inlineOnly) { continue; }

    const paramList = template.params.map((p) => (p.variadic ? '...' : p.name)).join(', ');
    const body = template.bodyInline
      ? expandTemplateBodyInline(template, templateSymbols, bodyTemplates)
      : expandTemplateBody(template, templateSymbols);
    lines.push(`#define ${makeMacroName(allSymbolParts, template.name)}(${paramList}) ${body}`);
  }

  for (const { struct, symbolParts } of collectScopeStructs(module.section, [])) {
    const allSymbolParts = [...module.symbolParts, ...symbolParts];
    const tagName = makeStructTagName(allSymbolParts, struct.name);
    const typedefName = makeTypedefName(allSymbolParts, struct.name);
    lines.push(`typedef struct ${tagName} {`);
    for (const field of struct.fields) {
      const typeName = resolveTypeExpression(field.target, field.line, symbols, templateSymbols);
      lines.push(`  ${renderFieldDeclaration(field, typeName)};`);
    }
    for (const use of (struct.uses ?? [])) {
      if (use.inline) {
        for (const field of expandStructUse(use.expr, struct.line, paramTemplates)) {
          const typeName = resolveTypeExpression(field.target, field.line, symbols, templateSymbols);
          lines.push(`  ${renderFieldDeclaration(field, typeName)};`);
        }
        continue;
      }
      const call = parseCallExpression(use.expr, struct.line);
      if (!call) { continue; }
      const tmpl = templateSymbols.get(call.callee);
      if (!tmpl) { continue; }
      const resolvedArgs = call.args.map((arg) => resolveTypeExpression(arg, struct.line, symbols, templateSymbols));
      lines.push(`  ${tmpl.macroName}(${resolvedArgs.join(', ')});`);
    }
    lines.push(`} ${typedefName};`);

    for (const fn of struct.fns) {
      const target = getFnOutputTarget(fn);
      if (target === 'source') { continue; }
      const fnCName = makeStructMethodCName(module, symbolParts, struct.name, fn.name);
      lines.push(`${makeStructMethodSignature(fn, fnCName, symbols, templateSymbols, typedefName, struct, paramTemplates)};`);
    }
  }

  for (const { fn, symbolParts: extraParts } of collectScopeFns(module.section, [])) {
    const target = getFnOutputTarget(fn);
    if (target === 'source') { continue; }
    const fnCName = makeFnCName(module, extraParts, fn.name);
    lines.push(`${makeFnSignature(fn, fnCName, symbols, templateSymbols)};`);
  }

  lines.push('', `#endif // ${module.guard}`, '');
  return lines.join('\n');
}

function renderSource(
  module: ModuleArtifact,
  symbols: Map<string, TypeSymbol>,
  templateSymbols: Map<string, TemplateSymbol>,
  paramTemplates: Map<string, TemplateNode>
): string | undefined {
  const lines = [`#include <${module.includePath}>`, ''];
  let hasDefinitions = false;

  for (const { declaration, symbolParts } of collectScopeTypeDeclarations(module.section, [])) {
    if (declaration.kind !== 'enum') {
      continue;
    }

    const mode = getEnumConstMode(declaration);
    const target = getEnumOutputTarget(declaration);

    if (mode !== 'extern' || (target !== 'source' && target !== 'both')) {
      continue;
    }

    const allSymbolParts = [...module.symbolParts, ...symbolParts];
    const cName = makeTypedefName(allSymbolParts, declaration.name);
    for (const [index, member] of declaration.members.entries()) {
      const memberName = makeEnumCaseName(allSymbolParts, declaration.name, member.name);
      const rawValue = member.value ?? String(index);
      lines.push(`const ${cName} ${memberName} = ${rawValue};`);
      hasDefinitions = true;
    }
  }

  for (const { fn, symbolParts: extraParts } of collectScopeFns(module.section, [])) {
    const target = getFnOutputTarget(fn);
    if (target !== 'source' && target !== 'both') { continue; }
    const fnCName = makeFnCName(module, extraParts, fn.name);
    lines.push(`${makeFnSignature(fn, fnCName, symbols, templateSymbols)} {`);
    lines.push(...renderFnBody(fn, symbols, templateSymbols));
    lines.push('}');
    hasDefinitions = true;
  }

  for (const { struct, symbolParts } of collectScopeStructs(module.section, [])) {
    const allSymbolParts = [...module.symbolParts, ...symbolParts];
    const typedefName = makeTypedefName(allSymbolParts, struct.name);
    for (const fn of struct.fns) {
      const target = getFnOutputTarget(fn);
      if (target !== 'source' && target !== 'both') { continue; }
      const fnCName = makeStructMethodCName(module, symbolParts, struct.name, fn.name);
      lines.push(`${makeStructMethodSignature(fn, fnCName, symbols, templateSymbols, typedefName, struct, paramTemplates)} {`);
      lines.push(...renderFnBody(fn, symbols, templateSymbols, true));
      lines.push('}');
      hasDefinitions = true;
    }
  }

  if (!hasDefinitions) {
    return undefined;
  }

  lines.push('');
  return lines.join('\n');
}

function shouldOutputHeaderCase(mode: EnumConstMode, target: OutputTarget): boolean {
  if (mode === 'define' || mode === 'static') {
    return true;
  }

  return target === 'header' || target === 'both';
}

function renderEnumCaseForHeader(
  symbolParts: string[],
  declaration: EnumNode,
  member: EnumMemberNode,
  index: number,
  cName: string,
  mode: EnumConstMode
): string {
  const memberName = makeEnumCaseName(symbolParts, declaration.name, member.name);
  const rawValue = member.value ?? String(index);

  if (mode === 'define') {
    return `#define ${memberName} ((${cName})${rawValue})`;
  }

  if (mode === 'extern') {
    return `extern const ${cName} ${memberName};`;
  }

  return `static const ${cName} ${memberName} = ${rawValue};`;
}

function isTypeTemplateParam(paramName: string | undefined): boolean {
  return paramName === 'type';
}

function expandTypeTemplateExpression(
  expression: UseExpression,
  template: TemplateSymbol,
  line: number,
  symbols: Map<string, TypeSymbol>,
  templateSymbols: Map<string, TemplateSymbol>
): string {
  const args = expression.args.map((arg, index) => {
    const paramName = template.rawParams?.[index];
    return isTypeTemplateParam(paramName)
      ? resolveTypeExpression(arg, line, symbols, templateSymbols)
      : arg;
  });
  for (const [index, paramName] of (template.rawParams ?? []).entries()) {
    if (isTypeTemplateParam(paramName) && expression.args[index] === undefined) {
      throw new Error(`Line ${line}: type template "${expression.callee}" expects argument "${paramName}"`);
    }
  }
  return applyRawBody(template.rawBody!, template.rawParams ?? [], args);
}

function resolveTypeExpression(
  target: string,
  line: number,
  symbols: Map<string, TypeSymbol>,
  templateSymbols: Map<string, TemplateSymbol>
): string {
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
  if (!symbol) {
    throw new Error(`Line ${line}: unknown type "${target}"`);
  }

  return symbol.cName;
}

function getTypeExpressionSymbols(
  target: string,
  line: number,
  symbols: Map<string, TypeSymbol>,
  templateSymbols: Map<string, TemplateSymbol>
): TypeSymbol[] {
  if (parseExprOf(target) !== undefined) { return []; }

  const expression = parseCallExpression(target, line);
  if (expression) {
    const template = templateSymbols.get(expression.callee);
    if (template?.rawBody !== undefined) {
      const result: TypeSymbol[] = [];
      for (let index = 0; index < expression.args.length; index += 1) {
        if (isTypeTemplateParam(template.rawParams?.[index])) {
          result.push(...getTypeExpressionSymbols(expression.args[index], line, symbols, templateSymbols));
        }
      }
      return result;
    }

    throw new Error(`Line ${line}: unknown type template "${expression.callee}"`);
  }

  const symbol = symbols.get(target);
  if (!symbol) {
    throw new Error(`Line ${line}: unknown type "${target}"`);
  }

  return [symbol];
}

function shouldDefineAlias(
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
  if (symbol.kind === 'enum' || symbol.kind === 'template' || symbol.kind === 'struct') {
    return false;
  }

  if (seen.has(symbol.key)) {
    throw new Error(`Line ${symbol.line}: cyclic type alias "${symbol.key}"`);
  }

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
    if (template?.rawBody !== undefined) {
      return template.defineOnly;
    }

    throw new Error(`Line ${line}: unknown type template "${expression.callee}"`);
  }

  const symbol = symbols.get(target);
  if (!symbol) {
    throw new Error(`Line ${line}: unknown type "${target}"`);
  }

  return symbol.defineOnly || resolveTypeSymbolDefineOnly(symbol, symbols, templateSymbols, seen);
}

function getEnumConstMode(declaration: EnumNode): EnumConstMode {
  const enumAttributes = declaration.attributes.filter((attribute) => attribute.name === 'enum');
  if (enumAttributes.length === 0) {
    return 'static';
  }

  for (const attribute of enumAttributes) {
    if (attribute.args.length !== 1 || !['define', 'static', 'extern'].includes(attribute.args[0])) {
      throw new Error(`Line ${attribute.line}: @enum only supports @enum(static), @enum(define), and @enum(extern)`);
    }

    if (attribute.args[0] === 'define' || attribute.args[0] === 'extern') {
      return attribute.args[0];
    }
  }

  return 'static';
}

function getEnumOutputTarget(declaration: EnumNode): OutputTarget {
  const pubAttrs = declaration.attributes.filter((a) => a.name === 'pub');
  if (pubAttrs.length === 0) { return 'header'; }
  const last = pubAttrs[pubAttrs.length - 1];
  if (last.args.length !== 1 || !['header', 'source', 'all'].includes(last.args[0])) {
    throw new Error(`Line ${last.line}: @pub only supports @pub(header), @pub(source), and @pub(all)`);
  }
  if (last.args[0] === 'all') {
    const mode = getEnumConstMode(declaration);
    if (mode === 'static' || mode === 'define') {
      throw new Error(`Line ${last.line}: @enum(${mode}) cannot use @pub(all), only @pub(header)`);
    }
    return 'both';
  }
  return last.args[0] as OutputTarget;
}

function collectScopeTypeDeclarations(section: SectionNode, extraParts: string[]): ScopedTypeDeclaration[] {
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

function collectScopeRecordTemplates(
  section: SectionNode,
  extraParts: string[]
): Array<{ template: TemplateNode; symbolParts: string[]; typeParts: string[] }> {
  return collectScopeTemplates(section, extraParts).filter(
    ({ template }) => template.fields.length > 0 && template.params.length === 0
  );
}

function getTypeDeclarations(section: SectionNode): TypeDeclaration[] {
  return [...section.aliases, ...section.enums].sort((left, right) => left.line - right.line);
}

function makeTypeKey(typeParts: string[], declarationName: string): string {
  const parts = [...typeParts];
  if (parts[parts.length - 1] !== declarationName) {
    parts.push(declarationName);
  }

  return parts.join('.');
}

function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

function makeTypedefName(symbolParts: string[], declarationName: string): string {
  const parts = [...symbolParts.map(toSnakeCase)];
  const snakeName = toSnakeCase(declarationName);
  if (parts[parts.length - 1] !== snakeName) {
    parts.push(snakeName);
  }

  return `${parts.join('_')}_t`;
}

function makeStructTagName(symbolParts: string[], declarationName: string): string {
  const parts = [...symbolParts.map(toSnakeCase)];
  const snakeName = toSnakeCase(declarationName);
  if (parts[parts.length - 1] !== snakeName) {
    parts.push(snakeName);
  }

  return parts.join('_');
}

function makeEnumCaseName(symbolParts: string[], enumName: string, memberName: string): string {
  const parts = [...symbolParts];
  if (parts[parts.length - 1] !== enumName) {
    parts.push(enumName);
  }

  parts.push(memberName);
  return parts.filter(Boolean).join('_');
}

function makeGuard(parts: string[]): string {
  return `${parts.join('_')}_h`
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

function resolveWorkspacePath(workspaceFolder: vscode.WorkspaceFolder, value: string): string {
  return path.resolve(workspaceFolder.uri.fsPath, value);
}
