export type SectionKind = 'root' | 'package' | 'module' | 'scope';

export interface Attribute {
  name: string;
  args: string[];
  line: number;
}

export interface FnParam {
  name: string;
  type: string;
  variadic: boolean;
  mutable: boolean;
  attributes: Attribute[];
  line: number;
}

export interface FnNode {
  kind: 'fn';
  name: string;
  params: FnParam[];
  returnType: string;
  body: string[];
  bodyLine: number;
  returnAttributes: Attribute[];
  attributes: Attribute[];
  selfMutable: boolean;
  line: number;
}

export interface LetNode {
  kind: 'let';
  name: string;
  type: string;
  expr: string;
  mutable: boolean;
  attributes: Attribute[];
  line: number;
}

export interface TemplateParam {
  variadic: boolean;
  name: string;
  callable: boolean;
  line: number;
}

export interface TemplateField {
  name: string;
  target: string;
  mutable: boolean;
  attributes: Attribute[];
  line: number;
}

export interface TemplateNode {
  kind: 'template';
  name: string;
  params: TemplateParam[];
  fields: TemplateField[];
  body: string;
  bodyLine: number;
  bodyInline: boolean;
  bodyRaw: boolean;
  mutable: boolean;
  attributes: Attribute[];
  line: number;
}

export interface StructUse {
  expr: string;
  inline: boolean;
  line: number;
}

export interface StructNode {
  kind: 'struct';
  name: string;
  fields: TemplateField[];
  uses: StructUse[];
  fns: FnNode[];
  attributes: Attribute[];
  line: number;
}

export interface AliasNode {
  kind: 'alias';
  name: string;
  target: string;
  attributes: Attribute[];
  line: number;
}

export interface EnumNode {
  kind: 'enum';
  name: string;
  target: string;
  members: EnumMemberNode[];
  attributes: Attribute[];
  line: number;
}

export interface EnumMemberNode {
  name: string;
  value?: string;
  attributes: Attribute[];
  line: number;
}

export interface SectionNode {
  kind: SectionKind;
  name: string;
  attributes: Attribute[];
  aliases: AliasNode[];
  enums: EnumNode[];
  templates: TemplateNode[];
  structs: StructNode[];
  fns: FnNode[];
  lets: LetNode[];
  children: SectionNode[];
  line: number;
}

export interface ParsedDsl {
  root: SectionNode;
  diagnostics: string[];
}

interface TemplateFrame {
  indent: number;
  node: TemplateNode;
}

interface StructFrame {
  indent: number;
  node: StructNode;
}

interface FnFrame {
  indent: number;
  node: FnNode;
}

interface EnumFrame {
  indent: number;
  node: EnumNode;
}

interface ScopeFrame {
  indent: number;
  section: SectionNode;
  inheritedAttributes: Attribute[];
}

export function makePublicPath(pathParts: string[]): string[] {
  const parts = [...pathParts];
  if (parts.length >= 2 && parts[parts.length - 1] === parts[parts.length - 2]) {
    parts.pop();
  }
  return parts;
}

export function parseDsl(source: string): ParsedDsl {
  const root: SectionNode = createSection('root', '', 0);
  const stack: ScopeFrame[] = [{ indent: -1, section: root, inheritedAttributes: [] }];
  const diagnostics: string[] = [];
  let pendingAttributes: Attribute[] = [];
  let currentEnum: EnumFrame | undefined;
  let currentTemplate: TemplateFrame | undefined;
  let currentStruct: StructFrame | undefined;
  let currentFn: FnFrame | undefined;

  expandInlineDsl(source).split(/\r?\n/).forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const withoutComment = rawLine.replace(/#.*$/, '').trimEnd();
    if (withoutComment.trim().length === 0) {
      return;
    }

    const indent = countIndent(withoutComment, diagnostics, lineNumber);
    const line = withoutComment.trim();

    if (currentFn && indent <= currentFn.indent) {
      currentFn = undefined;
    }

    if (currentEnum && indent <= currentEnum.indent) {
      currentEnum = undefined;
    }

    if (currentTemplate && indent <= currentTemplate.indent) {
      currentTemplate = undefined;
    }

    if (currentStruct && indent <= currentStruct.indent) {
      currentStruct = undefined;
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

    if (currentFn) {
      const param = parseFnParam(line, lineNumber, pendingAttributes);
      if (param) {
        pendingAttributes = [];
        currentFn.node.params.push(param);
        return;
      }

      if (/^return(?:\s|$)/.test(line) && pendingAttributes.length > 0) {
        currentFn.node.returnAttributes.push(...pendingAttributes);
        pendingAttributes = [];
      }

      if (currentFn.node.body.length === 0) { currentFn.node.bodyLine = lineNumber; }
      currentFn.node.body.push(line);
      return;
    }

    if (currentEnum) {
      const member = parseEnumMember(line, lineNumber);
      if (member) {
        member.attributes = [...pendingAttributes];
        pendingAttributes = [];
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
        currentTemplate.node.params.push(param);
        return;
      }

      const field = parseTemplateField(line, lineNumber);
      if (field) {
        if (currentTemplate.node.body !== '') {
          diagnostics.push(`Line ${lineNumber}: template "${currentTemplate.node.name}" with a body cannot have fields`);
          return;
        }
        field.attributes = [...pendingAttributes];
        field.mutable = field.attributes.some((a) => a.name === 'mutable');
        pendingAttributes = [];
        currentTemplate.node.fields.push(field);
        return;
      }

      if (currentTemplate.node.body === '') {
        if (currentTemplate.node.fields.length > 0) {
          diagnostics.push(`Line ${lineNumber}: template "${currentTemplate.node.name}" with fields cannot have a body`);
          return;
        }
        const exprOfMatch = line.match(/^use\s+c\.expr\((.*)\)$/);
        if (exprOfMatch) {
          pendingAttributes = [];
          currentTemplate.node.bodyRaw = true;
          currentTemplate.node.body = parseExprBodyArgument(exprOfMatch[1].trim());
          currentTemplate.node.bodyLine = lineNumber;
          return;
        }
        currentTemplate.node.bodyInline = pendingAttributes.some((a) => a.name === 'expand');
        pendingAttributes = [];
        currentTemplate.node.body = line;
        currentTemplate.node.bodyLine = lineNumber;
        return;
      }

      diagnostics.push(`Line ${lineNumber}: template "${currentTemplate.node.name}" already has a body`);
      return;
    }

    if (currentStruct) {
      const fnNode = parseFn(line, lineNumber, diagnostics);
      if (fnNode != null) {
        fnNode.attributes = [...parentFrame.inheritedAttributes, ...pendingAttributes];
        fnNode.selfMutable = fnNode.attributes.some((a) => a.name === 'mutable');
        pendingAttributes = [];
        currentStruct.node.fns.push(fnNode);
        currentFn = { indent, node: fnNode };
        return;
      }
      if (fnNode === null) { return; }

      const field = parseTemplateField(line, lineNumber);
      if (field) {
        field.attributes = [...pendingAttributes];
        field.mutable = field.attributes.some((a) => a.name === 'mutable');
        pendingAttributes = [];
        currentStruct.node.fields.push(field);
        return;
      }
      if (/^use\s+/.test(line)) {
        const inline = pendingAttributes.some((a) => a.name === 'expand');
        pendingAttributes = [];
        currentStruct.node.uses.push({ expr: line.slice(4).trim(), inline, line: lineNumber });
        return;
      }
    }

    const section = parseSection(line, lineNumber);
    if (section) {
      section.attributes = [...parentFrame.inheritedAttributes, ...pendingAttributes];
      pendingAttributes = [];
      parent.children.push(section);
      stack.push({ indent, section, inheritedAttributes: section.attributes.filter((a) => a.name !== 'doc') });
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

    const templateNode = parseTemplate(line, lineNumber, diagnostics);
    if (templateNode != null) {
      templateNode.attributes = [...parentFrame.inheritedAttributes, ...pendingAttributes];
      templateNode.mutable = templateNode.attributes.some((a) => a.name === 'mutable');
      pendingAttributes = [];
      parent.templates.push(templateNode);
      currentTemplate = { indent, node: templateNode };
      return;
    }
    if (templateNode === null) { return; }

    const structNode = parseStruct(line, lineNumber);
    if (structNode) {
      structNode.attributes = [...parentFrame.inheritedAttributes, ...pendingAttributes];
      pendingAttributes = [];
      parent.structs.push(structNode);
      currentStruct = { indent, node: structNode };
      return;
    }

    const fnNode = parseFn(line, lineNumber, diagnostics);
    if (fnNode != null) {
      fnNode.attributes = [...parentFrame.inheritedAttributes, ...pendingAttributes];
      fnNode.selfMutable = fnNode.attributes.some((a) => a.name === 'mutable');
      pendingAttributes = [];
      parent.fns.push(fnNode);
      currentFn = { indent, node: fnNode };
      return;
    }
    if (fnNode === null) { return; }

    const letNode = parseLet(line, lineNumber);
    if (letNode) {
      letNode.attributes = [...parentFrame.inheritedAttributes, ...pendingAttributes];
      letNode.mutable = letNode.attributes.some((a) => a.name === 'mutable');
      pendingAttributes = [];
      parent.lets.push(letNode);
      return;
    }

    diagnostics.push(`Line ${lineNumber}: cannot parse "${line}"`);
  });

  if (pendingAttributes.length > 0) {
    diagnostics.push(`Line ${pendingAttributes[0].line}: attribute is not attached to any DSL object`);
  }

  return { root, diagnostics };
}

export function expandInlineDsl(source: string): string {
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

    const originalIndent = rawLine.match(/^(\s*)/)?.[1] ?? '';
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const isSection = /^(package|module|scope)\s+[A-Za-z_][A-Za-z0-9_]*$/.test(part);
      lines.push(`${originalIndent}${'    '.repeat(index)}${part}${isSection ? ':' : ''}`);
    }
  }

  return lines.join('\n');
}

export function createSection(kind: SectionKind, name: string, line: number): SectionNode {
  return {
    kind,
    name,
    attributes: [],
    aliases: [],
    enums: [],
    templates: [],
    structs: [],
    fns: [],
    lets: [],
    children: [],
    line
  };
}

function countIndent(line: string, diagnostics: string[], lineNumber: number): number {
  const match = line.match(/^(\s*)/);
  const spaces = match?.[1] ?? '';
  if (spaces.includes('\t')) {
    diagnostics.push(`Line ${lineNumber}: tabs are not allowed for indentation, use spaces`);
  }
  return spaces.replace(/\t/g, '    ').length;
}

function parseAttribute(line: string, lineNumber: number): Attribute | undefined {
  const match = line.match(/^@([A-Za-z_][A-Za-z0-9_]*)(?:\((.*)\))?$/);
  if (!match) {
    return undefined;
  }
  return {
    name: match[1],
    args: match[2] ? splitAttributeArgs(match[2]) : [],
    line: lineNumber
  };
}

function splitAttributeArgs(source: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote = '';
  let escaped = false;
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
    if (char === ',') {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts.filter(Boolean);
}

function parseSection(line: string, lineNumber: number): SectionNode | undefined {
  const match = line.match(/^(package|module|scope)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*$/);
  if (!match) {
    return undefined;
  }
  return createSection(match[1] as SectionKind, match[2], lineNumber);
}

function parseExprBodyArgument(arg: string): string {
  const quoted = arg.match(/^"(.*)"$/);
  if (quoted) {
    return quoted[1];
  }

  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg)) {
    return `\${${arg}}`;
  }

  return arg;
}

function parseAlias(line: string, lineNumber: number): AliasNode | undefined {
  const match = line.match(/^alias\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+|\s+->\s*)(.+)$/);
  if (!match) {
    return undefined;
  }
  return { kind: 'alias', name: match[1], target: match[2].trim(), attributes: [], line: lineNumber };
}

function parseEnum(line: string, lineNumber: number): EnumNode | undefined {
  const match = line.match(/^enum\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+|\s+->\s*)(.+)\s*:\s*$/);
  if (!match) {
    return undefined;
  }
  return { kind: 'enum', name: match[1], target: match[2].trim(), members: [], attributes: [], line: lineNumber };
}

function parseEnumMember(line: string, lineNumber: number): EnumMemberNode | undefined {
  const match = line.match(/^case\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*=\s*([A-Za-z0-9_+-]+))?$/);
  if (!match) {
    return undefined;
  }
  return { name: match[1], value: match[2], attributes: [], line: lineNumber };
}

function parseFn(line: string, lineNumber: number, diagnostics?: string[]): FnNode | null | undefined {
  const startMatch = line.match(/^fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*/);
  if (!startMatch) {
    return undefined;
  }

  const name = startMatch[1];
  let rest = line.slice(startMatch[0].length);
  if (rest.startsWith('()')) {
    rest = rest.slice(2).trimStart();
  } else if (rest.startsWith('(')) {
    diagnostics?.push(`Line ${lineNumber}: fn parameters must be declared as indented \`param\` lines`);
    return null;
  }

  const returnMatch = rest.match(/^->\s*(.+?)\s*:\s*$/);
  if (!returnMatch) {
    return undefined;
  }

  return {
    kind: 'fn',
    name,
    params: [],
    returnType: returnMatch[1].trim(),
    body: [],
    bodyLine: 0,
    returnAttributes: [],
    attributes: [],
    selfMutable: false,
    line: lineNumber
  };
}

function parseFnParam(text: string, lineNumber: number, attributes: Attribute[] = []): FnParam | undefined {
  const trimmed = text.trim();
  const mutable = attributes.some((a) => a.name === 'mutable');

  const variadicMatch = trimmed.match(/^param\s+\.\.\.(?:\s+as\s+|\s+->\s*)([A-Za-z_][A-Za-z0-9_]*)$/);
  if (variadicMatch) {
    return { name: variadicMatch[1], type: '...', variadic: true, mutable: true, attributes, line: lineNumber };
  }

  const normalMatch = trimmed.match(/^param\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+|\s+->\s*)(.+)$/);
  if (normalMatch) {
    return {
      name: normalMatch[1],
      type: normalMatch[2].trim(),
      variadic: false,
      mutable,
      attributes,
      line: lineNumber
    };
  }
  return undefined;
}

function parseLet(line: string, lineNumber: number): LetNode | undefined {
  const match = line.match(/^let\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+|\s+->\s*)(.+?)\s*=\s*(.+)$/);
  if (!match) {
    return undefined;
  }
  return {
    kind: 'let',
    name: match[1],
    type: match[2].trim(),
    expr: match[3].trim(),
    mutable: false,
    attributes: [],
    line: lineNumber
  };
}

function parseTemplate(line: string, lineNumber: number, diagnostics?: string[]): TemplateNode | null | undefined {
  const match = line.match(/^template\s+([A-Za-z_][A-Za-z0-9_]*)(.*)$/);
  if (!match) {
    return undefined;
  }
  const rest = match[2].trim();
  if (rest.startsWith('(')) {
    diagnostics?.push(`Line ${lineNumber}: template parameters must be declared as indented \`param\` lines`);
    return null;
  }
  if (rest !== ':') {
    return undefined;
  }
  return { kind: 'template', name: match[1], params: [], fields: [], body: '', bodyLine: lineNumber, bodyInline: false, bodyRaw: false, mutable: false, attributes: [], line: lineNumber };
}

function parseStruct(line: string, lineNumber: number): StructNode | undefined {
  const match = line.match(/^struct\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*$/);
  if (!match) {
    return undefined;
  }
  return { kind: 'struct', name: match[1], fields: [], uses: [], fns: [], attributes: [], line: lineNumber };
}

function parseTemplateParam(line: string, lineNumber: number): TemplateParam | undefined {
  const variadicMatch = line.match(/^param\s+\.\.\.(?:\s+as\s+|\s+->\s*)([A-Za-z_][A-Za-z0-9_]*)$/);
  if (variadicMatch) {
    return { variadic: true, callable: false, name: variadicMatch[1], line: lineNumber };
  }
  const normalMatch = line.match(/^param\s+([A-Za-z_][A-Za-z0-9_]*)(?:(?:\s+as\s+|\s+->\s*)(\S+))?$/);
  if (normalMatch) {
    return { variadic: false, callable: normalMatch[2] === 'template', name: normalMatch[1], line: lineNumber };
  }
  return undefined;
}

function parseTemplateField(line: string, lineNumber: number): TemplateField | undefined {
  const match = line.match(/^field\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+|\s+->\s*)(.+)$/);
  if (!match) {
    return undefined;
  }
  return { name: match[1], target: match[2].trim(), mutable: false, attributes: [], line: lineNumber };
}
