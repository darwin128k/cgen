import type {
  SectionNode,
  AliasNode,
  EnumNode,
  Attribute,
} from './parser';

export type EnumConstMode = 'static' | 'define' | 'extern';
export type OutputTarget = 'header' | 'source' | 'both';

export interface ModuleContext {
  pathParts: string[];
  guardParts: string[];
  symbolParts: string[];
  typeParts: string[];
}

export interface ModuleArtifact {
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

export interface TypeSymbol {
  key: string;
  cName: string;
  moduleId: string;
  includePath: string;
  externHeader?: string;
  kind: 'alias' | 'enum' | 'template' | 'struct';
  target?: string;
  line: number;
  defineOnly: boolean;
  intrinsicAlias: boolean;
}

export interface TemplateSymbol {
  key: string;
  macroName: string;
  moduleId: string;
  includePath: string;
  externHeader?: string;
  intrinsicOnly: boolean;
  defineOnly: boolean;
  rawBody?: string;
  rawParams?: string[];
  rawTypeParams?: string[];
}

export interface UseExpression {
  callee: string;
  args: string[];
}

export interface LetStatement {
  name: string;
  type: string;
  expr: string;
}

export interface ReturnStatement {
  expr: string;
  type?: string;
}

export interface AssignmentStatement {
  target: string;
  expr: string;
}

export type TypeDeclaration = AliasNode | EnumNode;

export interface ScopedTypeDeclaration {
  declaration: TypeDeclaration;
  symbolParts: string[];
  typeParts: string[];
}

export interface DocTag {
  command: 'param' | 'return';
  name?: string;
  description?: string;
}

export function hasAttribute(node: SectionNode | AliasNode | EnumNode, name: string, arg?: string): boolean {
  return node.attributes.some((attribute) => {
    if (attribute.name !== name) { return false; }
    return arg === undefined || attribute.args.includes(arg);
  });
}

export function hasAttr(attributes: Attribute[], name: string, arg?: string): boolean {
  return attributes.some((attribute) => {
    if (attribute.name !== name) { return false; }
    return arg === undefined || attribute.args.includes(arg);
  });
}

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function makeGuard(parts: string[]): string {
  return `${parts.join('_')}_h`
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

export function makeMacroName(symbolParts: string[], name: string): string {
  const parts = [...symbolParts];
  if (parts[parts.length - 1] !== name) { parts.push(name); }
  return parts.filter(Boolean).join('_');
}

export function makeTypeKey(typeParts: string[], declarationName: string): string {
  const parts = [...typeParts];
  if (parts[parts.length - 1] !== declarationName) { parts.push(declarationName); }
  return parts.join('.');
}

function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

export function makeTypedefName(symbolParts: string[], declarationName: string): string {
  const parts = [...symbolParts.map(toSnakeCase)];
  const snakeName = toSnakeCase(declarationName);
  if (parts[parts.length - 1] !== snakeName) { parts.push(snakeName); }
  return `${parts.join('_')}_t`;
}

export function makeStructTagName(symbolParts: string[], declarationName: string): string {
  const parts = [...symbolParts.map(toSnakeCase)];
  const snakeName = toSnakeCase(declarationName);
  if (parts[parts.length - 1] !== snakeName) { parts.push(snakeName); }
  return parts.join('_');
}

export function makeEnumCaseName(symbolParts: string[], enumName: string, memberName: string): string {
  const parts = [...symbolParts];
  if (parts[parts.length - 1] !== enumName) { parts.push(enumName); }
  parts.push(memberName);
  return parts.filter(Boolean).join('_');
}

export function getIncludeArg(attributes: Attribute[]): string | undefined {
  for (const attr of attributes) {
    if (attr.name === 'include' && attr.args.length > 0) {
      return attr.args[0].replace(/^"(.*)"$/, '$1');
    }
  }
  return undefined;
}

export function parseExprOf(target: string): string | undefined {
  const match = target.match(/^c\.expr\("(.*)"\)$/);
  return match ? match[1] : undefined;
}
