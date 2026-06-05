import type { SectionNode, FnNode, TemplateNode } from './parser';
import {
  type ModuleContext,
  type ModuleArtifact,
  type TypeSymbol,
  type TemplateSymbol,
  type SymbolUsageIndex,
  type UseExpression,
  hasAttribute,
  makeGuard,
} from './cgenTypes';
import {
  parseCallExpression,
  parseUseExpression,
  parseLetStatement,
  parseAssignmentStatement,
} from './expander';
import {
  collectScopeTemplates,
  collectScopeStructs,
  collectScopeFns,
  collectScopeLets,
  collectScopeTypeDeclarations,
  getTypeExpressionSymbols,
  hasReturnStatement,
  inferReturnedSelfField,
  getStructFields,
} from './symbols';
import { expandStructUse } from './expander';

export function collectModules(root: SectionNode): ModuleArtifact[] {
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

  walkSections(root, { pathParts: [], guardParts: [], symbolParts: [], typeParts: [] }, (section, context) => {
    const headerPathParts = [...context.pathParts, `${section.name}.h`];
    const includePath = headerPathParts.join('/');
    modules.push({
      id: includePath,
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
    if (child.kind === 'module') { onModule(child, next); }
    walkSections(child, next, onModule);
  }
}

function applySectionContext(section: SectionNode, context: ModuleContext): ModuleContext {
  if (section.kind === 'root' || section.kind === 'scope') { return context; }
  const guardOnly = hasAttribute(section, 'scope', 'guard');
  return {
    pathParts: section.kind === 'package' ? [...context.pathParts, section.name] : context.pathParts,
    guardParts: [...context.guardParts, section.name],
    symbolParts: guardOnly ? context.symbolParts : [...context.symbolParts, section.name],
    typeParts: [...context.typeParts, section.name]
  };
}

function addDep(module: ModuleArtifact, otherModuleId: string): void {
  if (otherModuleId !== module.id) { module.dependencies.add(otherModuleId); }
}

function addSymbolRef(module: ModuleArtifact, symbolKey: string): void {
  module.symbolRefs.set(symbolKey, (module.symbolRefs.get(symbolKey) ?? 0) + 1);
}

function addSymbolDep(module: ModuleArtifact, symbol: TypeSymbol | TemplateSymbol): void {
  addDep(module, symbol.moduleId);
  addSymbolRef(module, symbol.key);
  if (symbol.externHeader) { module.externHeaders.add(symbol.externHeader); }
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
    if (!symbol) { throw new Error(`Line ${line}: unknown template "${expression.callee}"`); }
    if (!symbol.rawBody && !symbol.intrinsicOnly) { result.push(symbol); }
  }
  for (const arg of expression.args) {
    const nested = parseCallExpression(arg, line);
    if (nested) { collectUsedTemplateSymbols(nested, line, templateSymbols, result, callableParams); }
  }
}

function addFnExpressionDependencies(
  module: ModuleArtifact,
  expr: string,
  line: number,
  templateSymbols: Map<string, TemplateSymbol>
): void {
  const expression = parseCallExpression(expr, line);
  if (expression) { addFnUseExpressionDependencies(module, expression, line, templateSymbols); }
}

function addFnUseExpressionDependencies(
  module: ModuleArtifact,
  expression: UseExpression,
  line: number,
  templateSymbols: Map<string, TemplateSymbol>
): void {
  const used: TemplateSymbol[] = [];
  collectUsedTemplateSymbols(expression, line, templateSymbols, used, new Set());
  for (const symbol of used) { addSymbolDep(module, symbol); }
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
        addSymbolDep(module, symbol);
      }
      addFnExpressionDependencies(module, letStatement.expr, fn.line, templateSymbols);
      continue;
    }
    if (/^return\s+/.test(line)) {
      addFnExpressionDependencies(module, line.slice('return '.length).trim(), fn.line, templateSymbols);
      continue;
    }
    const assignment = parseAssignmentStatement(line);
    if (assignment) {
      addFnExpressionDependencies(module, assignment.expr, fn.line, templateSymbols);
      continue;
    }
    if (/^use\s+c\.expr\(/.test(line)) { continue; }
    if (/^use\s+/.test(line)) {
      addFnUseExpressionDependencies(module, parseUseExpression(line, fn.line), fn.line, templateSymbols);
    }
  }
}

export function resolveModuleDependencies(
  modules: ModuleArtifact[],
  symbols: Map<string, TypeSymbol>,
  templateSymbols: Map<string, TemplateSymbol>,
  paramTemplates: Map<string, TemplateNode>
): void {
  for (const module of modules) {
    for (const { declaration } of collectScopeTypeDeclarations(module.section, [])) {
      for (const symbol of getTypeExpressionSymbols(declaration.target, declaration.line, symbols, templateSymbols)) {
        addSymbolDep(module, symbol);
      }
    }

    for (const { letNode } of collectScopeLets(module.section, [])) {
      for (const symbol of getTypeExpressionSymbols(letNode.type, letNode.line, symbols, templateSymbols)) {
        addSymbolDep(module, symbol);
      }
      addFnExpressionDependencies(module, letNode.expr, letNode.line, templateSymbols);
    }

    for (const { template } of collectScopeTemplates(module.section, [])) {
      if (template.fields.length > 0 && template.params.length > 0) {
        const paramNames = new Set(template.params.map((p) => p.name));
        for (const field of template.fields) {
          if (paramNames.has(field.target)) { continue; }
          for (const symbol of getTypeExpressionSymbols(field.target, field.line, symbols, templateSymbols)) {
            addSymbolDep(module, symbol);
          }
        }
        continue;
      }
      if (template.fields.length > 0) {
        for (const field of template.fields) {
          for (const symbol of getTypeExpressionSymbols(field.target, field.line, symbols, templateSymbols)) {
            addSymbolDep(module, symbol);
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
              addSymbolDep(module, sym);
            }
          }
        }
        continue;
      }
      for (const usedTemplate of getUsedTemplateSymbols(template, templateSymbols)) {
        addSymbolDep(module, usedTemplate);
      }
    }

    for (const { struct } of collectScopeStructs(module.section, [])) {
      for (const field of struct.fields) {
        for (const symbol of getTypeExpressionSymbols(field.target, field.line, symbols, templateSymbols)) {
          addSymbolDep(module, symbol);
        }
      }
      for (const use of (struct.uses ?? [])) {
        if (use.inline) {
          for (const field of expandStructUse(use.expr, struct.line, paramTemplates)) {
            for (const sym of getTypeExpressionSymbols(field.target, field.line, symbols, templateSymbols)) {
              addSymbolDep(module, sym);
            }
          }
          continue;
        }
        const call = parseCallExpression(use.expr, struct.line);
        if (!call) { continue; }
        const tmpl = templateSymbols.get(call.callee);
        if (tmpl) { addSymbolDep(module, tmpl); }
        for (const arg of call.args) {
          for (const sym of getTypeExpressionSymbols(arg, struct.line, symbols, templateSymbols)) {
            addSymbolDep(module, sym);
          }
        }
      }
      for (const fn of struct.fns) {
        validateStructMethodBody(fn, struct, paramTemplates);
        validateFnReturnBody(fn);
        for (const p of fn.params) {
          if (p.variadic) { continue; }
          for (const symbol of getTypeExpressionSymbols(p.type, p.line, symbols, templateSymbols)) {
            addSymbolDep(module, symbol);
          }
        }
        const returnTargets = fn.returnType === 'any'
          ? inferStructMethodReturnTargets(fn, struct, paramTemplates)
          : [fn.returnType];
        for (const returnTarget of returnTargets) {
          for (const symbol of getTypeExpressionSymbols(returnTarget, fn.line, symbols, templateSymbols)) {
            addSymbolDep(module, symbol);
          }
        }
        addFnBodyDependencies(module, fn, symbols, templateSymbols);
      }
    }

    for (const { fn } of collectScopeFns(module.section, [])) {
      validateFnReturnBody(fn);
      for (const p of fn.params) {
        if (p.variadic) { continue; }
        for (const symbol of getTypeExpressionSymbols(p.type, p.line, symbols, templateSymbols)) {
          addSymbolDep(module, symbol);
        }
      }
      if (fn.returnType === 'any') {
        throw new Error(`Line ${fn.line}: any return type is only supported for struct methods`);
      }
      for (const symbol of getTypeExpressionSymbols(fn.returnType, fn.line, symbols, templateSymbols)) {
        addSymbolDep(module, symbol);
      }
      addFnBodyDependencies(module, fn, symbols, templateSymbols);
    }
  }

  const byId = new Map(modules.map((m) => [m.id, m]));
  for (const module of modules) {
    for (const depId of [...module.dependencies]) {
      const dep = byId.get(depId);
      if (dep && dep.headerPathParts.length === 0) {
        for (const header of dep.externHeaders) { module.externHeaders.add(header); }
        module.dependencies.delete(depId);
      }
    }
  }
}

export function buildSymbolUsageIndex(modules: ModuleArtifact[]): SymbolUsageIndex {
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

export function reduceTransitiveDependencies(module: ModuleArtifact, modules: ModuleArtifact[]): string[] {
  const direct = new Set(module.dependencies);
  const byId = new Map(modules.map((candidate) => [candidate.id, candidate]));
  for (const dependencyId of module.dependencies) {
    const dependency = byId.get(dependencyId);
    if (!dependency) { continue; }
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
    if (!id || result.has(id)) { continue; }
    result.add(id);
    const dependency = byId.get(id);
    if (dependency) { stack.push(...dependency.dependencies); }
  }
  return result;
}

function validateFnReturnBody(fn: FnNode): void {
  if (fn.returnType === 'none' && hasReturnStatement(fn)) {
    throw new Error(`Line ${fn.bodyLine || fn.line}: none function cannot return a value`);
  }
}

function validateStructMethodBody(
  fn: FnNode,
  struct: import('./parser').StructNode,
  paramTemplates: Map<string, TemplateNode>
): void {
  const fields = new Map(getStructFields(struct, paramTemplates).map((field) => [field.name, field]));
  for (const line of fn.body) {
    const assignment = parseAssignmentStatement(line);
    if (!assignment?.target.startsWith('self.')) { continue; }
    const fieldName = assignment.target.slice('self.'.length);
    const field = fields.get(fieldName);
    if (!field) {
      throw new Error(`Line ${fn.bodyLine || fn.line}: unknown self field "${assignment.target}"`);
    }
    if (!fn.selfMutable) {
      throw new Error(`Line ${fn.bodyLine || fn.line}: cannot assign to "${assignment.target}" in a const method`);
    }
    if (!field.mutable) {
      throw new Error(`Line ${fn.bodyLine || fn.line}: cannot assign to const field "${assignment.target}"`);
    }
  }
}

function inferStructMethodReturnTargets(
  fn: FnNode,
  struct: import('./parser').StructNode,
  paramTemplates: Map<string, TemplateNode>
): string[] {
  if (!hasReturnStatement(fn)) { return []; }
  const fieldName = inferReturnedSelfField(fn);
  if (!fieldName) { throw new Error(`Line ${fn.bodyLine || fn.line}: cannot infer any return type`); }
  const field = getStructFields(struct, paramTemplates).find((candidate) => candidate.name === fieldName);
  if (!field) { throw new Error(`Line ${fn.bodyLine || fn.line}: cannot infer any return type, unknown field "self.${fieldName}"`); }
  return [field.target];
}
