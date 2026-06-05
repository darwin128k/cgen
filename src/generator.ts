import * as path from 'path';
import * as vscode from 'vscode';
import { type FileIndexEntry, hashSource } from './indexer';
import { parseDsl, createSection, type SectionNode, type ParsedDsl } from './parser';
import { formatCgen } from './formatter';
import { type SymbolUsageIndex, type ModuleArtifact, type TypeSymbol, type TemplateSymbol } from './cgenTypes';
import { type TemplateNode } from './parser';
import { loadConfig } from './config';
import { buildTemplateSymbols, buildTypeSymbols, buildParamTemplateMap, buildBodyTemplateMap } from './symbols';
import { collectModules, resolveModuleDependencies, buildSymbolUsageIndex, reduceTransitiveDependencies } from './resolver';
import { renderHeader, renderSource } from './renderer';
import {
  generateCMakeLists,
  runBuildSystem,
  cleanDirectory,
  runClangFormat,
  resolveWorkspacePath,
} from './build';

export { buildProject } from './build';

export class DslError extends Error {
  constructor(message: string, public readonly root: SectionNode, public readonly perFileData: FileIndexEntry[] = []) {
    super(message);
  }
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

interface DslSourceOptions {
  primaryUri?: vscode.Uri;
}

function mergeDsls(parsedList: ParsedDsl[]): ParsedDsl {
  const root = createSection('root', '', 0);
  const diagnostics: string[] = [];
  for (const parsed of parsedList) {
    for (const child of parsed.root.children) { root.children.push(child); }
    for (const diagnostic of parsed.diagnostics) { diagnostics.push(diagnostic); }
  }
  return { root, diagnostics };
}

async function collectAllDslSources(
  workspaceFolder: vscode.WorkspaceFolder,
  extensionUri: vscode.Uri,
  primarySource: string,
  options: DslSourceOptions = {}
): Promise<Array<{ relativePath: string | null; source: string }>> {
  const primaryFormatted = formatCgen(primarySource);
  const primaryRelativePath = options.primaryUri && options.primaryUri.scheme === 'file'
    ? path.relative(workspaceFolder.uri.fsPath, options.primaryUri.fsPath).replace(/\\/g, '/')
    : undefined;
  const sources: Array<{ relativePath: string | null; source: string }> = [];
  const seen = new Set<string>();

  const packagesUri = vscode.Uri.joinPath(extensionUri, 'packages');
  try {
    const entries = await vscode.workspace.fs.readDirectory(packagesUri);
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.endsWith('.cgen')) { continue; }
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
    if (primaryRelativePath === relativePath) { continue; }
    const bytes = await vscode.workspace.fs.readFile(uri);
    const fileSource = formatCgen(Buffer.from(bytes).toString('utf8'));
    if (!seen.has(fileSource)) {
      seen.add(fileSource);
      sources.push({ relativePath, source: fileSource });
    }
  }

  if (primaryFormatted && !seen.has(primaryFormatted)) {
    sources.push({ relativePath: primaryRelativePath ?? null, source: primaryFormatted });
  }

  return sources;
}

async function buildDslArtifacts(
  workspaceFolder: vscode.WorkspaceFolder,
  extensionUri: vscode.Uri,
  source: string,
  options: DslSourceOptions = {}
): Promise<DslArtifacts> {
  const allSources = await collectAllDslSources(workspaceFolder, extensionUri, source, options);
  const parsedList = allSources.map((s) => parseDsl(s.source));
  const merged = mergeDsls(parsedList);

  const perFileData: FileIndexEntry[] = allSources.map((s, i) => ({
    relativePath: s.relativePath,
    hash: hashSource(s.source),
    root: parsedList[i].root,
    diagnostics: parsedList[i].diagnostics
  }));

  try {
    if (merged.diagnostics.length > 0) { throw new Error(merged.diagnostics.join('\n')); }

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

export async function resolveDslUsage(
  workspaceFolder: vscode.WorkspaceFolder,
  extensionUri: vscode.Uri,
  source: string,
  options: DslSourceOptions = {}
): Promise<{ root: SectionNode; usage: SymbolUsageIndex; perFileData: FileIndexEntry[] }> {
  const { root, usage, perFileData } = await buildDslArtifacts(workspaceFolder, extensionUri, source, options);
  return { root, usage, perFileData };
}

export async function generateDsl(
  workspaceFolder: vscode.WorkspaceFolder,
  extensionUri: vscode.Uri,
  source: string,
  options: { build?: boolean; primaryUri?: vscode.Uri } = {}
): Promise<{ files: string[]; root: SectionNode; usage: SymbolUsageIndex; perFileData: FileIndexEntry[] }> {
  const config = await loadConfig(workspaceFolder);
  if (options.build && !config.build) {
    throw new Error('cgen.json must contain build settings to generate and build');
  }
  const { root, modules, symbols, templateSymbols, paramTemplates, bodyTemplates, usage, perFileData } = await buildDslArtifacts(workspaceFolder, extensionUri, source, options);

  const generated: string[] = [];
  const includeRoot = resolveWorkspacePath(workspaceFolder, config.generate.include);
  const sourceRoot = resolveWorkspacePath(workspaceFolder, config.generate.source);

  if (config.generate.clean) {
    await cleanDirectory(includeRoot);
    await cleanDirectory(sourceRoot);
  }

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

  if (options.build && config.build) {
    await generateCMakeLists(workspaceFolder, config, generated);
    await runBuildSystem(workspaceFolder, config.build);
  }

  return { files: generated, root, usage, perFileData };
}
