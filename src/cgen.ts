import * as cp from 'child_process';
import * as path from 'path';
import * as util from 'util';
import * as vscode from 'vscode';

const execFile = util.promisify(cp.execFile);

export interface CgenConfig {
  build: {
    include: string;
    source: string;
  };
}

type SectionKind = 'root' | 'package' | 'module' | 'scope';
type EnumConstMode = 'static' | 'define' | 'extern';
type EmitTarget = 'header' | 'source' | 'both';

interface Attribute {
  name: string;
  args: string[];
  line: number;
}

interface SectionNode {
  kind: SectionKind;
  name: string;
  attributes: Attribute[];
  aliases: AliasNode[];
  enums: EnumNode[];
  templates: TemplateNode[];
  children: SectionNode[];
  line: number;
}

interface TemplateParam {
  variadic: boolean;
  name: string;
  line: number;
}

interface TemplateField {
  name: string;
  target: string;
  line: number;
}

interface TemplateNode {
  kind: 'template';
  name: string;
  params: TemplateParam[];
  fields: TemplateField[];
  body: string;
  bodyLine: number;
  attributes: Attribute[];
  line: number;
}

interface TemplateFrame {
  indent: number;
  node: TemplateNode;
}

interface AliasNode {
  kind: 'alias';
  name: string;
  target: string;
  attributes: Attribute[];
  line: number;
}

interface EnumNode {
  kind: 'enum';
  name: string;
  target: string;
  members: EnumMemberNode[];
  attributes: Attribute[];
  line: number;
}

interface EnumMemberNode {
  name: string;
  value?: string;
  line: number;
}

interface ScopeFrame {
  indent: number;
  section: SectionNode;
  inheritedAttributes: Attribute[];
}

interface EnumFrame {
  indent: number;
  node: EnumNode;
}

interface ParsedDsl {
  root: SectionNode;
  diagnostics: string[];
}

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
}

interface TypeSymbol {
  key: string;
  cName: string;
  moduleId: string;
  includePath: string;
  kind: 'alias' | 'enum' | 'template';
  target?: string;
  line: number;
  defineOnly: boolean;
}

interface TemplateSymbol {
  key: string;
  macroName: string;
  moduleId: string;
  includePath: string;
}

interface UseExpression {
  callee: string;
  args: string[];
}

type TypeDeclaration = AliasNode | EnumNode;

interface ScopedTypeDeclaration {
  declaration: TypeDeclaration;
  symbolParts: string[];
  typeParts: string[];
}

const builtinCTypes: Record<string, string> = {
  'c.char': 'char',
  'c.schar': 'signed char',
  'c.uchar': 'unsigned char',
  'c.sshort': 'signed short',
  'c.short': 'short',
  'c.ushort': 'unsigned short',
  'c.sint': 'signed int',
  'c.int': 'int',
  'c.uint': 'unsigned int',
  'c.slong': 'signed long',
  'c.long': 'long',
  'c.ulong': 'unsigned long',
  'c.sllong': 'signed long long',
  'c.llong': 'long long',
  'c.ullong': 'unsigned long long',
  'c.float': 'float',
  'c.double': 'double',
  'c.bool': '_Bool',
  'c.size': 'size_t',
  'c.void': 'void'
};

const defineAliasBuiltins = new Set(['c.void', 'c.ptr.of']);

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

export async function generateDsl(workspaceFolder: vscode.WorkspaceFolder, source: string): Promise<string[]> {
  const config = await loadConfig(workspaceFolder);
  const parsed = parseDsl(source);

  if (parsed.diagnostics.length > 0) {
    throw new Error(parsed.diagnostics.join('\n'));
  }

  const generated: string[] = [];
  const includeRoot = resolveWorkspacePath(workspaceFolder, config.build.include);
  const sourceRoot = resolveWorkspacePath(workspaceFolder, config.build.source);
  const modules = collectModules(parsed.root);
  const symbols = buildTypeSymbols(modules);
  const templateSymbols = buildTemplateSymbols(modules);

  resolveModuleDependencies(modules, symbols, templateSymbols);

  for (const module of modules) {
    const headerPath = path.join(includeRoot, ...module.headerPathParts);
    const includes = reduceTransitiveDependencies(module, modules)
      .map((moduleId) => modules.find((candidate) => candidate.id === moduleId))
      .filter((candidate): candidate is ModuleArtifact => candidate !== undefined)
      .map((candidate) => candidate.includePath)
      .sort();
    const text = renderHeader(module, includes, symbols, templateSymbols);

    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(headerPath)));
    await vscode.workspace.fs.writeFile(vscode.Uri.file(headerPath), Buffer.from(text, 'utf8'));
    generated.push(headerPath);

    const sourceText = renderSource(module);
    if (sourceText) {
      const sourcePath = path.join(sourceRoot, ...module.context.pathParts, `${module.section.name}.c`);
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(sourcePath)));
      await vscode.workspace.fs.writeFile(vscode.Uri.file(sourcePath), Buffer.from(sourceText, 'utf8'));
      generated.push(sourcePath);
    }
  }

  await runClangFormat(workspaceFolder, generated);
  return generated;
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

function parseDsl(source: string): ParsedDsl {
  const root: SectionNode = createSection('root', '', 0);
  const stack: ScopeFrame[] = [{ indent: -1, section: root, inheritedAttributes: [] }];
  const diagnostics: string[] = [];
  let pendingAttributes: Attribute[] = [];
  let currentEnum: EnumFrame | undefined;
  let currentTemplate: TemplateFrame | undefined;

  expandInlineDsl(source).split(/\r?\n/).forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const withoutComment = rawLine.replace(/#.*$/, '').trimEnd();
    if (withoutComment.trim().length === 0) {
      return;
    }

    const indent = countIndent(withoutComment, diagnostics, lineNumber);
    const line = withoutComment.trim();

    if (currentEnum && indent <= currentEnum.indent) {
      currentEnum = undefined;
    }

    if (currentTemplate && indent <= currentTemplate.indent) {
      currentTemplate = undefined;
    }

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const parentFrame = stack[stack.length - 1];
    const parent = parentFrame.section;
    const attribute = parseAttribute(line, lineNumber);
    if (attribute) {
      pendingAttributes.push(attribute);
      return;
    }

    if (currentEnum) {
      const member = parseEnumMember(line, lineNumber);
      if (member) {
        currentEnum.node.members.push(member);
        return;
      }
    }

    if (currentTemplate) {
      if (/^param\s+\.\.\.$/.test(line)) {
        diagnostics.push(`Line ${lineNumber}: variadic param must have an alias: use \`param ... as name\``);
        return;
      }

      const param = parseTemplateParam(line, lineNumber);
      if (param) {
        if (currentTemplate.node.fields.length > 0) {
          diagnostics.push(`Line ${lineNumber}: template "${currentTemplate.node.name}" with fields cannot have params`);
          return;
        }

        currentTemplate.node.params.push(param);
        return;
      }

      const field = parseTemplateField(line, lineNumber);
      if (field) {
        if (currentTemplate.node.params.length > 0 || currentTemplate.node.body !== '') {
          diagnostics.push(`Line ${lineNumber}: template "${currentTemplate.node.name}" with params or body cannot have fields`);
          return;
        }

        currentTemplate.node.fields.push(field);
        return;
      }

      if (currentTemplate.node.body === '') {
        if (currentTemplate.node.fields.length > 0) {
          diagnostics.push(`Line ${lineNumber}: template "${currentTemplate.node.name}" with fields cannot have a body`);
          return;
        }

        currentTemplate.node.body = line;
        currentTemplate.node.bodyLine = lineNumber;
        return;
      }

      diagnostics.push(`Line ${lineNumber}: template "${currentTemplate.node.name}" already has a body`);
      return;
    }

    const section = parseSection(line, lineNumber);
    if (section) {
      section.attributes = [...parentFrame.inheritedAttributes, ...pendingAttributes];
      pendingAttributes = [];
      parent.children.push(section);
      stack.push({ indent, section, inheritedAttributes: [...section.attributes] });
      return;
    }

    const alias = parseAlias(line, lineNumber);
    if (alias) {
      alias.attributes = [...parentFrame.inheritedAttributes, ...pendingAttributes];
      pendingAttributes = [];
      parent.aliases.push(alias);
      return;
    }

    const enumNode = parseEnum(line, lineNumber);
    if (enumNode) {
      enumNode.attributes = [...parentFrame.inheritedAttributes, ...pendingAttributes];
      pendingAttributes = [];
      parent.enums.push(enumNode);
      currentEnum = { indent, node: enumNode };
      return;
    }

    const templateNode = parseTemplate(line, lineNumber);
    if (templateNode) {
      templateNode.attributes = [...parentFrame.inheritedAttributes, ...pendingAttributes];
      pendingAttributes = [];
      parent.templates.push(templateNode);
      currentTemplate = { indent, node: templateNode };
      return;
    }

    diagnostics.push(`Line ${lineNumber}: cannot parse "${line}"`);
  });

  if (pendingAttributes.length > 0) {
    diagnostics.push(`Line ${pendingAttributes[0].line}: attribute is not attached to any DSL object`);
  }

  return { root, diagnostics };
}

function parseAttribute(line: string, lineNumber: number): Attribute | undefined {
  const match = line.match(/^@([A-Za-z_][A-Za-z0-9_]*)(?:\(([^)]*)\))?$/);
  if (!match) {
    return undefined;
  }

  return {
    name: match[1],
    args: match[2] ? match[2].split(',').map((value) => value.trim()).filter(Boolean) : [],
    line: lineNumber
  };
}

function parseSection(line: string, lineNumber: number): SectionNode | undefined {
  const match = line.match(/^(package|module|scope)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*$/);
  if (!match) {
    return undefined;
  }

  return createSection(match[1] as SectionKind, match[2], lineNumber);
}

function parseAlias(line: string, lineNumber: number): AliasNode | undefined {
  const match = line.match(/^alias\s+([A-Za-z_][A-Za-z0-9_]*)\s+as\s+(.+)$/);
  if (!match) {
    return undefined;
  }

  return {
    kind: 'alias',
    name: match[1],
    target: match[2].trim(),
    attributes: [],
    line: lineNumber
  };
}

function parseEnum(line: string, lineNumber: number): EnumNode | undefined {
  const match = line.match(/^enum\s+([A-Za-z_][A-Za-z0-9_]*)\s+as\s+(.+)\s*:\s*$/);
  if (!match) {
    return undefined;
  }

  return {
    kind: 'enum',
    name: match[1],
    target: match[2].trim(),
    members: [],
    attributes: [],
    line: lineNumber
  };
}

function parseEnumMember(line: string, lineNumber: number): EnumMemberNode | undefined {
  const match = line.match(/^case\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*=\s*([A-Za-z0-9_+-]+))?$/);
  if (!match) {
    return undefined;
  }

  return {
    name: match[1],
    value: match[2],
    line: lineNumber
  };
}

function parseTemplate(line: string, lineNumber: number): TemplateNode | undefined {
  const match = line.match(/^template\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*$/);
  if (!match) {
    return undefined;
  }

  return { kind: 'template', name: match[1], params: [], fields: [], body: '', bodyLine: lineNumber, attributes: [], line: lineNumber };
}

function parseTemplateParam(line: string, lineNumber: number): TemplateParam | undefined {
  const variadicMatch = line.match(/^param\s+\.\.\.\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/);
  if (variadicMatch) {
    return { variadic: true, name: variadicMatch[1], line: lineNumber };
  }

  const normalMatch = line.match(/^param\s+([A-Za-z_][A-Za-z0-9_]*)$/);
  if (normalMatch) {
    return { variadic: false, name: normalMatch[1], line: lineNumber };
  }

  return undefined;
}

function parseTemplateField(line: string, lineNumber: number): TemplateField | undefined {
  const match = line.match(/^field\s+([A-Za-z_][A-Za-z0-9_]*)\s+as\s+(.+)$/);
  if (!match) {
    return undefined;
  }

  return {
    name: match[1],
    target: match[2].trim(),
    line: lineNumber
  };
}

function expandTemplateBody(template: TemplateNode, templateSymbols: Map<string, TemplateSymbol>): string {
  if (!template.body) {
    throw new Error(`Line ${template.line}: template "${template.name}" has no body`);
  }

  const expression = parseUseExpression(template.body, template.bodyLine);

  const variadicParam = template.params.find((p) => p.variadic);
  const args = expression.args.map((arg) => expandTemplateArgument(arg, template.bodyLine, templateSymbols));
  let result = expression.callee.startsWith('c.')
    ? applyTemplateBuiltin(expression.callee, args, template.bodyLine)
    : applyTemplateSymbol(expression.callee, args, template.bodyLine, templateSymbols);

  if (variadicParam) {
    result = result.replace(new RegExp(`\\b${escapeRegex(variadicParam.name)}\\b`, 'g'), '__VA_ARGS__');
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

function expandTemplateArgument(arg: string, line: number, templateSymbols: Map<string, TemplateSymbol>): string {
  const expression = parseCallExpression(arg, line);
  if (!expression) {
    return arg;
  }

  const args = expression.args.map((nestedArg) => expandTemplateArgument(nestedArg, line, templateSymbols));
  return expression.callee.startsWith('c.')
    ? applyTemplateBuiltin(expression.callee, args, line)
    : applyTemplateSymbol(expression.callee, args, line, templateSymbols);
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

  return `${symbol.macroName}(${args.join(', ')})`;
}

function applyTemplateBuiltin(builtin: string, args: string[], line: number): string {
  const operand = (index: number) => protectTemplateOperand(args[index], line);

  switch (builtin) {
    case 'c.ret': return `(${args[0]})`;
    case 'c.initializer': return `{ ${args.join(', ')} }`;
    case 'c.sel': return `(${operand(0)} ? ${operand(1)} : ${operand(2)})`;
    case 'c.eq': return `(${operand(0)} == ${operand(1)})`;
    case 'c.ne': return `(${operand(0)} != ${operand(1)})`;
    case 'c.lt': return `(${operand(0)} < ${operand(1)})`;
    case 'c.le': return `(${operand(0)} <= ${operand(1)})`;
    case 'c.gt': return `(${operand(0)} > ${operand(1)})`;
    case 'c.ge': return `(${operand(0)} >= ${operand(1)})`;
    case 'c.math.add': return `(${operand(0)} + ${operand(1)})`;
    case 'c.math.sub': return `(${operand(0)} - ${operand(1)})`;
    case 'c.math.mul': return `(${operand(0)} * ${operand(1)})`;
    case 'c.math.div': return `(${operand(0)} / ${operand(1)})`;
    case 'c.math.mod': return `(${operand(0)} % ${operand(1)})`;
    case 'c.math.neg': return `(-${operand(0)})`;
    case 'c.math.bit.and': return `(${operand(0)} & ${operand(1)})`;
    case 'c.math.bit.or': return `(${operand(0)} | ${operand(1)})`;
    case 'c.math.bit.xor': return `(${operand(0)} ^ ${operand(1)})`;
    case 'c.math.bit.not': return `(~${operand(0)})`;
    case 'c.math.bit.shl': return `(${operand(0)} << ${operand(1)})`;
    case 'c.math.bit.shr': return `(${operand(0)} >> ${operand(1)})`;
    case 'c.math.bit.set': return `(${operand(0)} |= ${operand(1)})`;
    default: throw new Error(`Line ${line}: unknown template builtin "${builtin}"`);
  }
}

function protectTemplateOperand(arg: string, line: number): string {
  if (parseCallExpression(arg, line)) {
    return arg;
  }

  return `(${arg})`;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeMacroName(symbolParts: string[], name: string): string {
  const parts = [...symbolParts];
  if (parts[parts.length - 1] !== name) {
    parts.push(name);
  }

  return parts.filter(Boolean).join('_');
}

function expandInlineDsl(source: string): string {
  const lines: string[] = [];

  for (const rawLine of source.split(/\r?\n/)) {
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
      const indent = '    '.repeat(index);
      lines.push(`${indent}${part}${isSection ? ':' : ''}`);
    }
  }

  return lines.join('\n');
}

function createSection(kind: SectionKind, name: string, line: number): SectionNode {
  return {
    kind,
    name,
    attributes: [],
    aliases: [],
    enums: [],
    templates: [],
    children: [],
    line
  };
}

function countIndent(line: string, diagnostics: string[], lineNumber: number): number {
  const indentText = line.match(/^\s*/)?.[0] ?? '';
  if (indentText.includes('\t')) {
    diagnostics.push(`Line ${lineNumber}: tabs are not supported for indentation yet`);
  }
  return indentText.length;
}

function collectModules(root: SectionNode): ModuleArtifact[] {
  const modules: ModuleArtifact[] = [];

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
      dependencies: new Set<string>()
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
    typeParts: guardOnly ? context.typeParts : [...context.typeParts, section.name]
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

function buildTypeSymbols(modules: ModuleArtifact[]): Map<string, TypeSymbol> {
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
        defineOnly: false
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
  }

  for (const symbol of symbols.values()) {
    symbol.defineOnly = resolveTypeSymbolDefineOnly(symbol, symbols, new Set());
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

      if (template.fields.length > 0) {
        continue;
      }

      symbols.set(key, {
        key,
        macroName,
        moduleId: module.id,
        includePath: module.includePath
      });
    }
  }

  return symbols;
}

function resolveModuleDependencies(
  modules: ModuleArtifact[],
  symbols: Map<string, TypeSymbol>,
  templateSymbols: Map<string, TemplateSymbol>
): void {
  for (const module of modules) {
    for (const { declaration } of collectScopeTypeDeclarations(module.section, [])) {
      for (const symbol of getTypeExpressionSymbols(declaration.target, declaration.line, symbols)) {
        if (symbol.moduleId !== module.id) {
          module.dependencies.add(symbol.moduleId);
        }
      }
    }

    for (const { template } of collectScopeTemplates(module.section, [])) {
      if (template.fields.length > 0) {
        for (const field of template.fields) {
          for (const symbol of getTypeExpressionSymbols(field.target, field.line, symbols)) {
            if (symbol.moduleId !== module.id) {
              module.dependencies.add(symbol.moduleId);
            }
          }
        }
        continue;
      }

      for (const usedTemplate of getUsedTemplateSymbols(template, templateSymbols)) {
        if (usedTemplate.moduleId !== module.id) {
          module.dependencies.add(usedTemplate.moduleId);
        }
      }
    }
  }
}

function getUsedTemplateSymbols(template: TemplateNode, templateSymbols: Map<string, TemplateSymbol>): TemplateSymbol[] {
  const expression = parseUseExpression(template.body, template.bodyLine);
  const result: TemplateSymbol[] = [];

  collectUsedTemplateSymbols(expression, template.bodyLine, templateSymbols, result);
  return result;
}

function collectUsedTemplateSymbols(
  expression: UseExpression,
  line: number,
  templateSymbols: Map<string, TemplateSymbol>,
  result: TemplateSymbol[]
): void {
  if (!expression.callee.startsWith('c.')) {
    const symbol = templateSymbols.get(expression.callee);
    if (!symbol) {
      throw new Error(`Line ${line}: unknown template "${expression.callee}"`);
    }

    result.push(symbol);
  }

  for (const arg of expression.args) {
    const nested = parseCallExpression(arg, line);
    if (nested) {
      collectUsedTemplateSymbols(nested, line, templateSymbols, result);
    }
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

function renderHeader(
  module: ModuleArtifact,
  includes: string[],
  symbols: Map<string, TypeSymbol>,
  templateSymbols: Map<string, TemplateSymbol>
): string {
  const lines = [
    `#ifndef ${module.guard}`,
    `#define ${module.guard}`,
    ''
  ];

  for (const includePath of includes) {
    lines.push(`#include <${includePath}>`);
  }

  if (includes.length > 0) {
    lines.push('');
  }

  for (const { declaration, symbolParts } of collectScopeTypeDeclarations(module.section, [])) {
    const allSymbolParts = [...module.symbolParts, ...symbolParts];
    if (declaration.kind === 'alias') {
      const type = resolveTypeExpression(declaration.target, declaration.line, symbols);
      const cName = makeTypedefName(allSymbolParts, declaration.name);
      lines.push(shouldDefineAlias(declaration.target, declaration.line, symbols) ? `#define ${cName} ${type}` : `typedef ${type} ${cName};`);
      continue;
    }

    const type = resolveTypeExpression(declaration.target, declaration.line, symbols);
    const cName = makeTypedefName(allSymbolParts, declaration.name);
    lines.push(`typedef ${type} ${cName};`);

    if (declaration.members.length > 0) {
      lines.push('');
    }

    declaration.members.forEach((member, index) => {
      const mode = getEnumConstMode(declaration);
      const emit = getEmitTarget(declaration);

      if (shouldEmitHeaderCase(mode, emit)) {
        lines.push(renderEnumCaseForHeader(allSymbolParts, declaration, member, index, cName, mode));
      }
    });
  }

  for (const { template, symbolParts } of collectScopeTemplates(module.section, [])) {
    const allSymbolParts = [...module.symbolParts, ...symbolParts];
    if (template.fields.length > 0) {
      const cName = makeTypedefName(allSymbolParts, template.name);
      lines.push(`typedef struct ${cName} {`);
      for (const field of template.fields) {
        lines.push(`  ${resolveTypeExpression(field.target, field.line, symbols)} ${field.name};`);
      }
      lines.push(`} ${cName};`);
      continue;
    }

    const paramList = template.params.map((p) => (p.variadic ? '...' : p.name)).join(', ');
    const body = expandTemplateBody(template, templateSymbols);
    lines.push(`#define ${makeMacroName(allSymbolParts, template.name)}(${paramList}) ${body}`);
  }

  lines.push('', `#endif // ${module.guard}`, '');
  return lines.join('\n');
}

function renderSource(module: ModuleArtifact): string | undefined {
  const lines = [`#include <${module.includePath}>`, ''];
  let hasDefinitions = false;

  for (const { declaration, symbolParts } of collectScopeTypeDeclarations(module.section, [])) {
    if (declaration.kind !== 'enum') {
      continue;
    }

    const mode = getEnumConstMode(declaration);
    const emit = getEmitTarget(declaration);

    if (mode !== 'extern' || (emit !== 'source' && emit !== 'both')) {
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

  if (!hasDefinitions) {
    return undefined;
  }

  lines.push('');
  return lines.join('\n');
}

function shouldEmitHeaderCase(mode: EnumConstMode, emit: EmitTarget): boolean {
  if (mode === 'define' || mode === 'static') {
    return true;
  }

  return emit === 'header' || emit === 'both';
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

function resolveTypeExpression(target: string, line: number, symbols: Map<string, TypeSymbol>): string {
  const builtin = builtinCTypes[target];
  if (builtin) {
    return builtin;
  }

  const expression = parseCallExpression(target, line);
  if (expression) {
    if (expression.callee !== 'c.ptr.of' || expression.args.length !== 1) {
      throw new Error(`Line ${line}: unknown type builtin "${expression.callee}"`);
    }

    return `${resolveTypeExpression(expression.args[0], line, symbols)} *`;
  }

  const symbol = symbols.get(target);
  if (!symbol) {
    throw new Error(`Line ${line}: unknown type "${target}"`);
  }

  return symbol.cName;
}

function getTypeExpressionSymbols(target: string, line: number, symbols: Map<string, TypeSymbol>): TypeSymbol[] {
  if (builtinCTypes[target]) {
    return [];
  }

  const expression = parseCallExpression(target, line);
  if (expression) {
    if (expression.callee !== 'c.ptr.of' || expression.args.length !== 1) {
      throw new Error(`Line ${line}: unknown type builtin "${expression.callee}"`);
    }

    return getTypeExpressionSymbols(expression.args[0], line, symbols);
  }

  const symbol = symbols.get(target);
  if (!symbol) {
    throw new Error(`Line ${line}: unknown type "${target}"`);
  }

  return [symbol];
}

function shouldDefineAlias(target: string, line: number, symbols: Map<string, TypeSymbol>): boolean {
  return isDefineOnlyTypeExpression(target, line, symbols, new Set());
}

function resolveTypeSymbolDefineOnly(
  symbol: TypeSymbol,
  symbols: Map<string, TypeSymbol>,
  seen: Set<string>
): boolean {
  if (symbol.kind === 'enum' || symbol.kind === 'template') {
    return false;
  }

  if (seen.has(symbol.key)) {
    throw new Error(`Line ${symbol.line}: cyclic type alias "${symbol.key}"`);
  }

  seen.add(symbol.key);
  const result = isDefineOnlyTypeExpression(symbol.target!, symbol.line, symbols, seen);
  seen.delete(symbol.key);
  return result;
}

function isDefineOnlyTypeExpression(
  target: string,
  line: number,
  symbols: Map<string, TypeSymbol>,
  seen: Set<string>
): boolean {
  if (builtinCTypes[target]) {
    return defineAliasBuiltins.has(target);
  }

  const expression = parseCallExpression(target, line);
  if (expression) {
    if (expression.callee !== 'c.ptr.of' || expression.args.length !== 1) {
      throw new Error(`Line ${line}: unknown type builtin "${expression.callee}"`);
    }

    return defineAliasBuiltins.has(expression.callee);
  }

  const symbol = symbols.get(target);
  if (!symbol) {
    throw new Error(`Line ${line}: unknown type "${target}"`);
  }

  return symbol.defineOnly || resolveTypeSymbolDefineOnly(symbol, symbols, seen);
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

function getEmitTarget(declaration: EnumNode): EmitTarget {
  const emitAttributes = declaration.attributes.filter((attribute) => attribute.name === 'emit');
  if (emitAttributes.length === 0) {
    return 'header';
  }

  const attribute = emitAttributes[emitAttributes.length - 1];
  if (attribute.args.length !== 1 || !['header', 'source', 'both'].includes(attribute.args[0])) {
    throw new Error(`Line ${attribute.line}: @emit only supports @emit(header), @emit(source), and @emit(both)`);
  }

  const emit = attribute.args[0] as EmitTarget;
  const mode = getEnumConstMode(declaration);
  if ((mode === 'static' || mode === 'define') && emit !== 'header') {
    throw new Error(`Line ${attribute.line}: @enum(${mode}) can only use @emit(header)`);
  }

  return emit;
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
  return collectScopeTemplates(section, extraParts).filter(({ template }) => template.fields.length > 0);
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

function makeTypedefName(symbolParts: string[], declarationName: string): string {
  const parts = [...symbolParts];
  if (parts[parts.length - 1] !== declarationName) {
    parts.push(declarationName);
  }

  return `${parts.join('_')}_t`;
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
