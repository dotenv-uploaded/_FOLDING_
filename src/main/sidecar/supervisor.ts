/**
 * sidecar 프로세스 수명주기 (스펙 v2.1 §1 L2).
 *
 * `codegate-local`(Python)은 그냥 프로그램이라 누군가 켜주고 지켜봐야 한다. 그게 여기다.
 *   · 빈 포트를 잡고 `--port`·`--cors-origin` 과 함께 띄운다
 *   · `GET /health` 가 200 을 줄 때까지 기다린다 (그전에 요청을 보내면 실패한다)
 *   · 비정상 종료를 감지해 백오프를 두고 되살린다
 *   · 앱이 끝나면 같이 내린다 — **파이썬을 고아 프로세스로 남기지 않는다**
 *
 * 비즈니스 로직은 하나도 두지 않는다. 띄우고·기다리고·되살리고·내리는 것이 전부다.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import type { SidecarLifecycleState, SidecarStatus } from '@contracts';
import { SIDECAR_STATUS_MESSAGE } from '@contracts';
import { logError } from '@main/util/errors';

/** `/health` 가 200 을 줄 때까지 이만큼만 기다린다. */
const READY_TIMEOUT_MS = 30_000;
const HEALTH_INTERVAL_MS = 300;
/** 이 횟수를 넘기면 자동 재기동을 포기하고 사용자에게 알린다. */
const MAX_RESTARTS = 3;
/** 종료 신호 뒤 이만큼 기다렸다가 강제 종료. */
const KILL_GRACE_MS = 3_000;

export interface SidecarSupervisorOptions {
  /** 렌더러 오리진 — sidecar CORS 를 여기로 좁힌다 */
  corsOrigin: string;
  onState: (state: SidecarLifecycleState) => void;
  /** 실행 파일. 없으면 PATH 의 `codegate-local` */
  binary?: string;
  /**
   * 이미 떠 있는 sidecar 에 붙을 때(개발 중 수동 실행 등).
   * 지정되면 **spawn 하지 않는다** — 남의 프로세스를 관리하려 들지 않는다.
   */
  externalUrl?: string;
  /** 자식에게 넘길 추가 환경변수 (경로 등) */
  extraEnv?: Record<string, string>;
  /** 테스트에서 health 확인을 갈아끼우기 위한 구멍 */
  fetchImpl?: typeof fetch;
}

/** 비어 있는 loopback 포트를 하나 잡아 준다. */
export function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (typeof address === 'string' || !address) {
        srv.close(() => reject(new Error('포트를 할당하지 못했습니다.')));
        return;
      }
      const { port } = address;
      srv.close(() => resolve(port));
    });
  });
}

export class SidecarSupervisor {
  private child: ChildProcess | null = null;
  private baseUrl: string | null = null;
  private stopping = false;
  private readonly fetchImpl: typeof fetch;
  private state: SidecarLifecycleState;

  constructor(private readonly options: SidecarSupervisorOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.state = {
      status: 'stopped',
      baseUrl: null,
      message: SIDECAR_STATUS_MESSAGE.stopped,
      restarts: 0,
      updatedAt: new Date().toISOString(),
    };
  }

  getState(): SidecarLifecycleState {
    return this.state;
  }

  /** 우리가 띄운 프로세스인지 (외부 연결이면 false). */
  get managed(): boolean {
    return !this.options.externalUrl;
  }

  private setState(status: SidecarStatus, patch: Partial<SidecarLifecycleState> = {}): void {
    this.state = {
      ...this.state,
      status,
      message: patch.message ?? SIDECAR_STATUS_MESSAGE[status],
      baseUrl: patch.baseUrl !== undefined ? patch.baseUrl : this.baseUrl,
      updatedAt: new Date().toISOString(),
      ...patch,
    };
    this.options.onState(this.state);
  }

  /**
   * base URL 을 확정한다. **spawn 하기 전에** 부른다 —
   * 포트를 먼저 잡아 두면 재기동해도 URL 이 바뀌지 않아, 이미 만들어진 클라이언트가 그대로 산다.
   */
  async prepare(): Promise<string> {
    if (this.options.externalUrl) {
      this.baseUrl = this.options.externalUrl.replace(/\/+$/, '');
      this.setState('external', { baseUrl: this.baseUrl });
      return this.baseUrl;
    }
    const port = await allocatePort();
    this.baseUrl = `http://127.0.0.1:${port}`;
    return this.baseUrl;
  }

  /** 띄우고 준비될 때까지 기다린다. 외부 연결 모드면 health 확인만 한다. */
  async start(): Promise<void> {
    if (!this.baseUrl) await this.prepare();
    this.stopping = false;

    if (!this.managed) {
      await this.waitForHealth().catch((err: unknown) => {
        this.setState('unhealthy', {
          error: err instanceof Error ? err.message : '외부 엔진에 연결하지 못했습니다.',
        });
      });
      return;
    }

    this.setState('starting');
    try {
      this.spawnChild();
      await this.waitForHealth();
      this.setState('ready');
    } catch (err) {
      logError('sidecar:start', err);
      this.setState('crashed', {
        error: err instanceof Error ? err.message : '엔진을 시작하지 못했습니다.',
      });
    }
  }

  /** 사용자가 "다시 시작"을 눌렀을 때 — 재시도 카운터를 되돌린다. */
  async restart(): Promise<void> {
    if (!this.managed) {
      await this.start();
      return;
    }
    await this.stopChild();
    this.state = { ...this.state, restarts: 0 };
    await this.start();
  }

  private spawnChild(): void {
    const url = new URL(this.baseUrl!);
    const bin = this.options.binary ?? process.env.CODEGATE_SIDECAR_BIN ?? 'codegate-local';

    const child = spawn(bin, ['--port', url.port, '--cors-origin', this.options.corsOrigin], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // 자격증명 분리 (스펙 v2.1 §6): Anthropic 키는 sidecar 환경변수로만 간다.
        // Supabase 토큰은 여기 절대 넣지 않는다.
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
        CODEGATE_ENVIRONMENT: process.env.CODEGATE_ENVIRONMENT ?? 'local',
        CODEGATE_AUTH_MODE: process.env.CODEGATE_AUTH_MODE ?? 'local',
        ...this.options.extraEnv,
      },
    });

    child.stdout?.on('data', (b: Buffer) => console.info('[sidecar]', b.toString().trimEnd()));
    child.stderr?.on('data', (b: Buffer) => console.warn('[sidecar]', b.toString().trimEnd()));

    child.on('error', (err) => {
      logError('sidecar:spawn', err);
      this.setState('crashed', {
        error: `엔진 실행 파일을 찾지 못했습니다 (${bin}). 설치 상태를 확인해 주세요.`,
      });
    });

    child.on('exit', (code, signal) => {
      if (this.stopping) return; // 우리가 내린 것
      this.onAbnormalExit(code, signal);
    });

    this.child = child;
  }

  private onAbnormalExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.child = null;
    const detail = signal ? `신호 ${signal}` : `종료 코드 ${code}`;

    if (this.state.restarts >= MAX_RESTARTS) {
      this.setState('crashed', {
        error: `엔진이 반복해서 종료됩니다 (${detail}). 설정에서 다시 시작해 주세요.`,
      });
      return;
    }

    const restarts = this.state.restarts + 1;
    this.setState('restarting', { restarts });
    // 연달아 죽을 때 즉시 재시도하면 CPU 만 태운다 — 점점 늦춘다
    setTimeout(() => {
      void this.start();
    }, 500 * restarts);
  }

  /** `/health` 가 200 을 줄 때까지 짧게 반복해 두드린다. */
  private async waitForHealth(): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let lastError = '엔진이 응답하지 않습니다.';

    while (Date.now() < deadline) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/api/v1/health`);
        if (res.ok) return;
        lastError = `엔진이 준비되지 않았습니다 (HTTP ${res.status}).`;
      } catch {
        lastError = '엔진에 연결하지 못했습니다.';
      }
      await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS));
    }
    throw new Error(lastError);
  }

  private async stopChild(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    if (!child || child.killed) return;

    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // 얌전히 안 죽으면 강제로 — 고아로 남기는 것보다 낫다
        if (!child.killed) child.kill('SIGKILL');
        resolve();
      }, KILL_GRACE_MS);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** 앱 종료 시. 외부 연결 모드면 남의 프로세스를 건드리지 않는다. */
  async stop(): Promise<void> {
    if (!this.managed) {
      this.stopping = true;
      return;
    }
    await this.stopChild();
    this.setState('stopped');
  }
}
