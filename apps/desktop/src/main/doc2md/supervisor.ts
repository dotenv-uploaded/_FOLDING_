import { LoopbackProcessSupervisor } from '@main/process/loopback-supervisor';

export interface Doc2MdProcessConfig {
  externalUrl?: string;
  command?: string;
  commandArgs?: string[];
  cwd?: string;
}

export class Doc2MdSupervisor {
  private readonly process: LoopbackProcessSupervisor;

  constructor(config: Doc2MdProcessConfig) {
    this.process = new LoopbackProcessSupervisor({
      name: 'doc2md',
      command: config.command,
      args: (origin) => {
        const url = new URL(origin);
        return [
          ...(config.commandArgs ?? []),
          '--host',
          '127.0.0.1',
          '--port',
          url.port,
        ];
      },
      env: () => ({
        ...safeProcessEnvironment(process.env),
        PYTHONUTF8: '1',
        PYTHONUNBUFFERED: '1',
      }),
      cwd: config.cwd,
      externalOrigin: config.externalUrl,
      healthUrl: (origin) => `${origin}/health`,
      ready: async (response) => {
        if (!response.ok) return false;
        const payload = (await response.json()) as { status?: unknown };
        return payload.status === 'ok';
      },
    });
  }

  get baseUrl(): string | null {
    return this.process.baseOrigin;
  }

  prepare(): Promise<string> {
    return this.process.prepare();
  }

  start(): Promise<string> {
    return this.process.start();
  }

  stop(): Promise<void> {
    return this.process.stop();
  }

  dispose(): Promise<void> {
    return this.process.dispose();
  }
}

function safeProcessEnvironment(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const name of [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'HOME',
    'USERPROFILE',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'TZ',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'CODEGATE_KORDOC_DIR',
    'CODEGATE_NODE_BIN',
    'ELECTRON_RUN_AS_NODE',
  ]) {
    if (baseEnv[name] !== undefined) safe[name] = baseEnv[name];
  }
  return safe;
}
