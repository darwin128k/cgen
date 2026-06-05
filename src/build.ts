import * as cp from 'child_process';
import * as path from 'path';
import * as util from 'util';
import * as vscode from 'vscode';
import type { CgenConfig } from './config';
import { loadConfig } from './config';

const buildOutput = vscode.window.createOutputChannel('CGen Build');
const execFile = util.promisify(cp.execFile);

export function resolveWorkspacePath(workspaceFolder: vscode.WorkspaceFolder, value: string): string {
  return path.resolve(workspaceFolder.uri.fsPath, value);
}

export async function buildProject(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
  const config = await loadConfig(workspaceFolder);
  if (!config.build) {
    throw new Error('cgen.json must contain build settings to run a build');
  }
  await runBuildSystem(workspaceFolder, config.build);
}

export async function generateCMakeLists(
  workspaceFolder: vscode.WorkspaceFolder,
  config: CgenConfig,
  generatedFiles: string[]
): Promise<void> {
  const wsPath = workspaceFolder.uri.fsPath;
  const sourceFiles = generatedFiles
    .filter((f) => f.endsWith('.c'))
    .map((f) => path.relative(wsPath, f).replace(/\\/g, '/'))
    .sort();

  const includePath = path.relative(wsPath, resolveWorkspacePath(workspaceFolder, config.generate.include)).replace(/\\/g, '/');
  const { name, version, description } = config.project;
  const projectType = config.project.type === 'auto'
    ? sourceFiles.length > 0 ? 'static' : 'interface'
    : config.project.type;

  if (projectType === 'interface' && sourceFiles.length > 0) {
    throw new Error('project.type interface cannot contain generated .c source files');
  }
  if (projectType !== 'interface' && sourceFiles.length === 0) {
    throw new Error(`project.type ${projectType} requires at least one generated .c source file`);
  }

  const lines: string[] = [
    'cmake_minimum_required(VERSION 3.15)',
    `project(${name} VERSION ${version} DESCRIPTION "${description}")`,
    '',
  ];

  if (projectType !== 'interface') {
    const target = projectType === 'executable'
      ? `add_executable(${name}`
      : `add_library(${name} ${projectType.toUpperCase()}`;
    lines.push(target);
    for (const f of sourceFiles) { lines.push(`    ${f}`); }
    lines.push(')');
    lines.push('');
    lines.push(`target_include_directories(${name} ${projectType === 'executable' ? 'PRIVATE' : 'PUBLIC'}`);
    lines.push(`    ${includePath}`);
    lines.push(')');
  } else {
    lines.push(`add_library(${name} INTERFACE)`);
    lines.push('');
    lines.push(`target_include_directories(${name} INTERFACE`);
    lines.push(`    ${includePath}`);
    lines.push(')');
  }

  lines.push('');
  const content = lines.join('\n');
  const cmakePath = path.join(wsPath, 'CMakeLists.txt');
  await vscode.workspace.fs.writeFile(vscode.Uri.file(cmakePath), Buffer.from(content, 'utf8'));
}

export async function runBuildSystem(
  workspaceFolder: vscode.WorkspaceFolder,
  build: NonNullable<CgenConfig['build']>
): Promise<void> {
  const wsPath = workspaceFolder.uri.fsPath;

  const run = async (cmd: string, args: string[], label: string): Promise<void> => {
    try {
      await execFile(cmd, args, { cwd: wsPath, maxBuffer: 10 * 1024 * 1024 });
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      buildOutput.clear();
      buildOutput.appendLine(`> ${cmd} ${args.join(' ')}`);
      if (e.stdout) { buildOutput.append(e.stdout); }
      if (e.stderr) { buildOutput.append(e.stderr); }
      buildOutput.appendLine(`\n${label}: failed`);
      buildOutput.show(false);
      throw new Error(`${label} failed. See CGen Build output for details.`);
    }
  };

  if (build.system === 'cmake') {
    if (build.action === 'configure' || build.action === 'configure+build') {
      await run('cmake', ['-B', build.dir, '-S', '.'], 'cmake configure');
    }
    if (build.action === 'build' || build.action === 'configure+build') {
      await run('cmake', ['--build', build.dir], 'cmake build');
    }
  } else if (build.system === 'meson') {
    if (build.action === 'configure' || build.action === 'configure+build') {
      await run('meson', ['setup', build.dir], 'meson setup');
    }
    if (build.action === 'build' || build.action === 'configure+build') {
      await run('meson', ['compile', '-C', build.dir], 'meson compile');
    }
  }
}

export async function cleanDirectory(dirPath: string): Promise<void> {
  const uri = vscode.Uri.file(dirPath);
  try {
    await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
  } catch {
    // Directory doesn't exist — nothing to clean.
  }
  await vscode.workspace.fs.createDirectory(uri);
}

export async function runClangFormat(workspaceFolder: vscode.WorkspaceFolder, files: string[]): Promise<void> {
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
