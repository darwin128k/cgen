export const builtinCTypes: Record<string, string> = {
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

export const defineAliasBuiltins = new Set(['c.void', 'c.ptr.of']);

export const knownTemplateBuiltins = new Set([
  'c.ret', 'c.cast', 'c.call', 'c.initializer', 'c.sel', 'c.struct.of',
  'c.eq', 'c.ne', 'c.lt', 'c.le', 'c.gt', 'c.ge',
  'c.math.add', 'c.math.sub', 'c.math.mul', 'c.math.div', 'c.math.mod', 'c.math.neg',
  'c.math.bit.and', 'c.math.bit.or', 'c.math.bit.xor', 'c.math.bit.not', 'c.math.bit.shl', 'c.math.bit.shr', 'c.math.bit.set'
]);

function protectTemplateOperand(arg: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*\(.*\)$/.test(arg) ? arg : `(${arg})`;
}

const builtinArity: Record<string, number | null> = {
  'c.ret': 1, 'c.struct.of': 1, 'c.math.neg': 1, 'c.math.bit.not': 1,
  'c.cast': 2, 'c.sel': 3,
  'c.eq': 2, 'c.ne': 2, 'c.lt': 2, 'c.le': 2, 'c.gt': 2, 'c.ge': 2,
  'c.math.add': 2, 'c.math.sub': 2, 'c.math.mul': 2, 'c.math.div': 2, 'c.math.mod': 2,
  'c.math.bit.and': 2, 'c.math.bit.or': 2, 'c.math.bit.xor': 2,
  'c.math.bit.shl': 2, 'c.math.bit.shr': 2, 'c.math.bit.set': 2,
  'c.initializer': null, 'c.call': null
};

export function applyTemplateBuiltin(builtin: string, args: string[], line: number): string {
  const expected = builtinArity[builtin];
  if (expected !== null && expected !== undefined && args.length !== expected) {
    throw new Error(`Line ${line}: ${builtin} expects ${expected} argument${expected === 1 ? '' : 's'}, got ${args.length}`);
  }

  const operand = (index: number) => protectTemplateOperand(args[index]);

  switch (builtin) {
    case 'c.ret': return args[0];
    case 'c.cast': return `((${args[0]})${args[1]})`;
    case 'c.call': return `${args[0]}(${args.slice(1).join(', ')})`;
    case 'c.struct.of': return `struct ${args[0]}`;
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
