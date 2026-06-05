import * as vscode from 'vscode';

type ProjectType = 'auto' | 'executable' | 'static' | 'shared' | 'interface';

export interface CgenConfig {
  project: {
    name: string;
    version: string;
    description: string;
    type: ProjectType;
  };
  generate: {
    include: string;
    source: string;
    clean: boolean;
  };
  build?: {
    system: 'cmake' | 'meson';
    action: 'configure' | 'build' | 'configure+build';
    dir: string;
  };
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
  if (!config.generate?.include || !config.generate?.source) {
    throw new Error('cgen.json must contain generate.include and generate.source');
  }
  const projectType = config.project?.type ?? 'auto';
  if (!['auto', 'executable', 'static', 'shared', 'interface'].includes(projectType)) {
    throw new Error('cgen.json project.type must be auto, executable, static, shared, or interface');
  }

  return {
    project: {
      name: config.project?.name ?? '',
      version: config.project?.version ?? '',
      description: config.project?.description ?? '',
      type: projectType,
    },
    generate: {
      include: config.generate.include,
      source: config.generate.source,
      clean: config.generate.clean !== false,
    },
    ...(config.build && {
      build: {
        system: config.build.system,
        action: config.build.action,
        dir: config.build.dir ?? './build',
      }
    }),
  };
}
