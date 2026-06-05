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
  returnTypeInferred: boolean;
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

export interface FieldNode {
  name: string;
  target: string;
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
  params: FnParam[];
  fields: FieldNode[];
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
      finalizeFnReturnType(currentFn.node);
      currentFn = undefined;
    }

    if (currentEnum && indent <= currentEnum.indent) {
      currentEnum = undefined;
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

    if (currentStruct) {
      const param = parseFnParam(line, lineNumber, pendingAttributes);
      if (param) {
        pendingAttributes = [];
        currentStruct.node.params.push(param);
        return;
      }

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

      const field = parseFieldNode(line, lineNumber);
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
  if (currentFn) {
    finalizeFnReturnType(currentFn.node);
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

function parseAlias(line: string, lineNumber: number): AliasNode | undefined {
  const match = line.match(/^alias\s+([A-Za-z_][A-Za-z0-9_]*)\s+as\s+(.+)$/);
  if (!match) {
    return undefined;
  }
  return { kind: 'alias', name: match[1], target: match[2].trim(), attributes: [], line: lineNumber };
}

function parseEnum(line: string, lineNumber: number): EnumNode | undefined {
  const match = line.match(/^enum\s+([A-Za-z_][A-Za-z0-9_]*)\s+as\s+(.+)\s*:\s*$/);
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

  const inferredMatch = rest.match(/^:\s*$/);
  if (!inferredMatch) {
    return undefined;
  }

  return {
    kind: 'fn',
    name,
    params: [],
    returnType: 'auto',
    returnTypeInferred: true,
    body: [],
    bodyLine: 0,
    returnAttributes: [],
    attributes: [],
    selfMutable: false,
    line: lineNumber
  };
}

function finalizeFnReturnType(fn: FnNode): void {
  if (!fn.returnTypeInferred) { return; }
  const typedReturns = fn.body
    .map((line) => {
      const match = line.match(/^return\s+(.+)$/);
      return match ? splitTrailingReturnAsType(match[1])?.type : undefined;
    })
    .filter((type): type is string => !!type);
  if (typedReturns.length > 0) {
    fn.returnType = typedReturns[0];
    return;
  }
  fn.returnType = fn.body.some((line) => /^return(?:\s+|$)/.test(line)) ? 'any' : 'none';
}

function splitTrailingReturnAsType(source: string): { expr: string; type: string } | undefined {
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

function parseFnParam(text: string, lineNumber: number, attributes: Attribute[] = []): FnParam | undefined {
  const trimmed = text.trim();
  const mutable = attributes.some((a) => a.name === 'mutable');

  const variadicMatch = trimmed.match(/^param\s+\.\.\.\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/);
  if (variadicMatch) {
    return { name: variadicMatch[1], type: '...', variadic: true, mutable: true, attributes, line: lineNumber };
  }

  const normalMatch = trimmed.match(/^param\s+([A-Za-z_][A-Za-z0-9_]*)\s+as\s+(.+)$/);
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
  const anyMatch = trimmed.match(/^param\s+([A-Za-z_][A-Za-z0-9_]*)$/);
  if (anyMatch) {
    return {
      name: anyMatch[1],
      type: 'any',
      variadic: false,
      mutable,
      attributes,
      line: lineNumber
    };
  }
  return undefined;
}

function parseLet(line: string, lineNumber: number): LetNode | undefined {
  const match = line.match(/^let\s+([A-Za-z_][A-Za-z0-9_]*)\s+as\s+(.+?)\s*=\s*(.+)$/);
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

function parseStruct(line: string, lineNumber: number): StructNode | undefined {
  const match = line.match(/^struct\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*$/);
  if (!match) {
    return undefined;
  }
  return { kind: 'struct', name: match[1], params: [], fields: [], uses: [], fns: [], attributes: [], line: lineNumber };
}

function parseFieldNode(line: string, lineNumber: number): FieldNode | undefined {
  const match = line.match(/^field\s+([A-Za-z_][A-Za-z0-9_]*)\s+as\s+(.+)$/);
  if (!match) {
    return undefined;
  }
  return { name: match[1], target: match[2].trim(), mutable: false, attributes: [], line: lineNumber };
}
