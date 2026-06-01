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
  attributes: Attribute[];
  selfMutable: boolean;
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
      const paramAttribute = pendingAttributes.find((a) => a.name === 'param');
      if (paramAttribute) {
        diagnostics.push(`Line ${paramAttribute.line}: use \`mut name -> type\` or \`const name -> type\` for function parameters`);
        pendingAttributes = [];
        return;
      }

      const param = parseFnParam(line, lineNumber, pendingAttributes);
      if (param) {
        pendingAttributes = [];
        currentFn.node.params.push(param);
        return;
      }

      currentFn.node.body.push(line);
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
      if (/^(?:param\s+)?\.\.\.$/.test(line)) {
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
        pendingAttributes = [];
        currentTemplate.node.fields.push(field);
        return;
      }

      if (currentTemplate.node.body === '') {
        if (currentTemplate.node.fields.length > 0) {
          diagnostics.push(`Line ${lineNumber}: template "${currentTemplate.node.name}" with fields cannot have a body`);
          return;
        }
        const rawOfMatch = line.match(/^use\s+c\.raw\("(.*)"\)$/);
        if (rawOfMatch) {
          pendingAttributes = [];
          currentTemplate.node.bodyRaw = true;
          currentTemplate.node.body = rawOfMatch[1];
          currentTemplate.node.bodyLine = lineNumber;
          return;
        }
        currentTemplate.node.bodyInline = pendingAttributes.some((a) => a.name === 'use' && a.args[0] === 'inline');
        pendingAttributes = [];
        currentTemplate.node.body = line;
        currentTemplate.node.bodyLine = lineNumber;
        return;
      }

      diagnostics.push(`Line ${lineNumber}: template "${currentTemplate.node.name}" already has a body`);
      return;
    }

    if (currentStruct) {
      const fnNode = parseFn(line, lineNumber);
      if (fnNode) {
        fnNode.attributes = [...parentFrame.inheritedAttributes, ...pendingAttributes];
        pendingAttributes = [];
        currentStruct.node.fns.push(fnNode);
        currentFn = { indent, node: fnNode };
        return;
      }

      const field = parseTemplateField(line, lineNumber);
      if (field) {
        field.attributes = [...pendingAttributes];
        pendingAttributes = [];
        currentStruct.node.fields.push(field);
        return;
      }
      if (/^use\s+/.test(line)) {
        const inline = pendingAttributes.some((a) => a.name === 'use' && a.args[0] === 'inline');
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

    const structNode = parseStruct(line, lineNumber);
    if (structNode) {
      structNode.attributes = [...parentFrame.inheritedAttributes, ...pendingAttributes];
      pendingAttributes = [];
      parent.structs.push(structNode);
      currentStruct = { indent, node: structNode };
      return;
    }

    const fnNode = parseFn(line, lineNumber);
    if (fnNode) {
      fnNode.attributes = [...parentFrame.inheritedAttributes, ...pendingAttributes];
      pendingAttributes = [];
      parent.fns.push(fnNode);
      currentFn = { indent, node: fnNode };
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
  return { name: match[1], value: match[2], line: lineNumber };
}

function parseFn(line: string, lineNumber: number): FnNode | undefined {
  const startMatch = line.match(/^(mut\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\()?/);
  if (!startMatch) {
    return undefined;
  }

  const selfMutable = !!startMatch[1];
  const name = startMatch[2];
  let rest = line.slice(startMatch[0].length);
  const params: FnParam[] = [];

  if (startMatch[2]) {
    let depth = 1;
    let i = 0;
    for (; i < rest.length; i++) {
      if (rest[i] === '(') { depth++; } else if (rest[i] === ')') { depth--; if (depth === 0) { break; } }
    }
    if (depth !== 0) { return undefined; }
    const paramStr = rest.slice(0, i);
    rest = rest.slice(i + 1).trim();
    for (const part of splitByCommaBalanced(paramStr)) {
      const p = parseFnParam(part.trim(), lineNumber);
      if (p) { params.push(p); }
    }
  }

  const returnMatch = rest.match(/^(?:as\s+|->\s*)(.+?)\s*:\s*$/);
  if (!returnMatch) {
    return undefined;
  }

  return { kind: 'fn', name, params, returnType: returnMatch[1].trim(), body: [], attributes: [], selfMutable, line: lineNumber };
}

function parseFnParam(text: string, lineNumber: number, attributes: Attribute[] = []): FnParam | undefined {
  const trimmed = text.trim();
  const modifierMatch = trimmed.match(/^(mut|const)\s+(.+)$/);
  const modifier = modifierMatch?.[1];
  const body = modifierMatch ? modifierMatch[2].trim() : trimmed;
  const mutable = modifier === 'mut';

  const variadicMatch = body.match(/^(?:param\s+)?\.\.\.(?:\s+as\s+|\s+->\s*)([A-Za-z_][A-Za-z0-9_]*)$/);
  if (variadicMatch) {
    return { name: variadicMatch[1], type: '...', variadic: true, mutable: true, attributes, line: lineNumber };
  }

  const normalMatch = body.match(/^(?:param\s+)?([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+|\s+->\s*)(.+)$/);
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

function splitByCommaBalanced(source: string): string[] {
  if (!source.trim()) { return []; }
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '(') { depth++; } else if (source[i] === ')') { depth--; } else if (source[i] === ',' && depth === 0) { parts.push(source.slice(start, i)); start = i + 1; }
  }
  parts.push(source.slice(start));
  return parts;
}

function parseTemplate(line: string, lineNumber: number): TemplateNode | undefined {
  const match = line.match(/^template\s+([A-Za-z_][A-Za-z0-9_]*)(?:\(([^)]*)\))?\s*:\s*$/);
  if (!match) {
    return undefined;
  }
  const params: TemplateParam[] = [];
  if (match[2]) {
    for (const part of match[2].split(',')) {
      const param = parseTemplateParam(part.trim(), lineNumber);
      if (param) { params.push(param); }
    }
  }
  return { kind: 'template', name: match[1], params, fields: [], body: '', bodyLine: lineNumber, bodyInline: false, bodyRaw: false, attributes: [], line: lineNumber };
}

function parseStruct(line: string, lineNumber: number): StructNode | undefined {
  const match = line.match(/^struct\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*$/);
  if (!match) {
    return undefined;
  }
  return { kind: 'struct', name: match[1], fields: [], uses: [], fns: [], attributes: [], line: lineNumber };
}

function parseTemplateParam(line: string, lineNumber: number): TemplateParam | undefined {
  const variadicMatch = line.match(/^(?:param\s+)?\.\.\.(?:\s+as\s+|\s+->\s*)([A-Za-z_][A-Za-z0-9_]*)$/);
  if (variadicMatch) {
    return { variadic: true, callable: false, name: variadicMatch[1], line: lineNumber };
  }
  const normalMatch = line.match(/^(?:param\s+)?([A-Za-z_][A-Za-z0-9_]*)(?:(?:\s+as\s+|\s+->\s*)(\S+))?$/);
  if (normalMatch) {
    return { variadic: false, callable: normalMatch[2] === 'template', name: normalMatch[1], line: lineNumber };
  }
  return undefined;
}

function parseTemplateField(line: string, lineNumber: number): TemplateField | undefined {
  const match = line.match(/^(mut\s+)?field\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+|\s+->\s*)(.+)$/);
  if (!match) {
    return undefined;
  }
  return { name: match[2], target: match[3].trim(), mutable: !!match[1], attributes: [], line: lineNumber };
}
