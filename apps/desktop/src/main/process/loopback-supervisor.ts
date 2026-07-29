import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

export interface LoopbackProcessOptions {
  name: string;
  command?: string;
  args: (origin: string) => string[];
  env: (origin: string) => NodeJS.ProcessEnv;
  cwd?: string;
  externalOrigin?: string;
  healthUrl: (origin: string) => string;
  ready: (response: Response) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
  readyTimeoutMs?: number;
}

export class LoopbackProcessSupervisor {
  private child: ChildProcess | null = null;
  private origin: string | null = null;
  private lifecycle: Promise<void> = Promise.resolve();
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: typeof spawn;

  constructor(private readonly options: LoopbackProcessOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  get baseOrigin(): string | null {
    return this.origin;
  }

  get managed(): boolean {
    return !this.options.externalOrigin;
  }

  async prepare(): Promise<string> {
    if (this.origin) return this.origin;
    if (this.options.externalOrigin) {
      this.origin = normalizeLoopbackOrigin(this.options.externalOrigin);
      return this.origin;
    }
    this.origin = `http://127.0.0.1:${await allocatePort()}`;
    return this.origin;
  }

  async start(): Promise<string> {
    const operation = async (): Promise<string> => {
      const origin = await this.prepare();
      if (
        this.child &&
        this.child.exitCode === null &&
        this.child.signalCode === null
      ) {
        return origin;
      }
      if (this.managed) {
        const command = this.options.command;
        if (!command) {
          throw new Error(`${this.options.name} 실행 파일이 설치본에 포함되지 않았습니다.`);
        }
        const child = this.spawnImpl(command, this.options.args(origin), {
          cwd: this.options.cwd,
          env: this.options.env(origin),
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          windowsHide: true,
        });
        this.child = child;
        child.stdout?.on('data', (chunk: Buffer) =>
          console.info(`[${this.options.name}]`, chunk.toString().trimEnd()),
        );
        child.stderr?.on('data', (chunk: Buffer) =>
          console.warn(`[${this.options.name}]`, chunk.toString().trimEnd()),
        );
        child.once('exit', () => {
          if (this.child === child) this.child = null;
        });
        await waitForSpawn(child, this.options.name);
      }
      try {
        await this.waitForHealth(origin);
      } catch (error) {
        if (this.managed) await this.stopChild();
        throw error;
      }
      return origin;
    };
    const next = this.lifecycle.then(operation, operation);
    this.lifecycle = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async stop(): Promise<void> {
    const operation = async (): Promise<void> => {
      if (this.managed) await this.stopChild();
    };
    const next = this.lifecycle.then(operation, operation);
    this.lifecycle = next.catch(() => undefined);
    return next;
  }

  async dispose(): Promise<void> {
    await this.stop();
  }

  private async waitForHealth(origin: string): Promise<void> {
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? 60_000);
    let lastError = '응답 없음';
    while (Date.now() < deadline) {
      if (this.managed && (!this.child || !processTreeRunning(this.child))) {
        throw new Error(`${this.options.name} process가 준비되기 전에 종료됐습니다.`);
      }
      try {
        const response = await this.fetchImpl(this.options.healthUrl(origin), {
          signal: AbortSignal.timeout(5_000),
        });
        if (await this.options.ready(response)) return;
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await delay(250);
    }
    throw new Error(`${this.options.name} 준비 시간이 초과됐습니다: ${lastError}`);
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || !processTreeRunning(child)) return;
    await signalProcessTree(child, 'SIGTERM');
    if (await waitForProcessTreeExit(child, 5_000)) return;
    await signalProcessTree(child, 'SIGKILL');
    if (!(await waitForProcessTreeExit(child, 5_000))) {
      throw new Error(`${this.options.name} process tree를 종료하지 못했습니다.`);
    }
  }
}

export function normalizeLoopbackOrigin(value: string): string {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '::1'].includes(host) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('관리 프로세스 주소는 인증정보가 없는 loopback HTTP 주소여야 합니다.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/+$/, '');
}

function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('loopback port를 할당하지 못했습니다.'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function waitForSpawn(child: ChildProcess, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, 50);
    const onError = (error: Error): void => {
      cleanup();
      reject(new Error(`${name} 실행에 실패했습니다: ${error.message}`));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`${name} process가 즉시 종료됐습니다 (${code ?? signal}).`));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processTreeRunning(child: ChildProcess): boolean {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  }
  return child.exitCode === null && child.signalCode === null;
}

async function waitForProcessTreeExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processTreeRunning(child)) return true;
    await delay(100);
  }
  return !processTreeRunning(child);
}

async function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (!child.pid) {
    child.kill(signal);
    return;
  }
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
    return;
  }
  const args = ['/pid', String(child.pid), '/t'];
  if (signal === 'SIGKILL') args.push('/f');
  await new Promise<void>((resolve) => {
    const killer = spawn('taskkill.exe', args, { stdio: 'ignore' });
    killer.once('error', () => resolve());
    killer.once('exit', () => resolve());
  });
}
