/**
 * 메인 프로세스 서비스 컨테이너 — L2·L3·L4 와 에이전트 호스트를 한 곳에서 조립한다.
 * IPC 핸들러(`ipc.ts`)와 앱 부트스트랩(`index.ts`)은 이 객체만 본다.
 */
import path from 'node:path';
import type {
  AgentDeps,
  BuildState,
  ExecutionSummary,
  FileNode,
  Root,
  ScanPreview,
  Session,
} from '@contracts';
import { AuthError, IPC_EVENTS } from '@contracts';
import { AuthService, SafeStorageAuthStorage } from '@main/auth';
import { SafeStorageLlmKeyStore, type LlmKeyStore } from '@main/auth/llm-key';
import { createConverter } from '@main/build/convert';
import { LlmEnricher, MockEnricher } from '@main/build/enrich';
import { createBuilderCore } from '@main/build/assemble';
import { BuildService } from '@main/build/service';
import { openDb, Store } from '@main/db/store';
import { ApprovalBroker } from '@main/agent/approval';
import { ChatService } from '@main/agent/host';
import { loadCreateAgent, type AgentSource } from '@main/agent/loader';
import { createKordoc } from '@main/kordoc';
import { buildTree } from '@main/tree';
import { logError } from '@main/util/errors';
import { ensureDir } from '@main/util/fsx';
import { isInside, makeRootId, splitVirtualPath } from '@main/util/vpath';
import { FileWatcher, type WatchChange } from '@main/watcher';
import { describeFile, indexRoot, scanPreview } from '@main/watcher/scan';
import { SidecarClient } from '@main/sidecar/client';
import { executionSummary } from '@main/agent/sidecar-agent';

const DEFAULT_CLOUD_API_URL = 'http://127.0.0.1:8787/api/v1';
const DEFAULT_SIDECAR_URL = 'http://127.0.0.1:8000/api/v1';

export interface ServicesOptions {
  /** `app.getPath('userData')` */
  userDataDir: string;
  /** `app.getPath('home')` */
  homeDir: string;
  /** 렌더러로 단방향 푸시 */
  send: (channel: string, payload: unknown) => void;
}

export class AppServices {
  readonly store: Store;
  readonly auth: AuthService;
  readonly approval: ApprovalBroker;
  readonly build: BuildService;
  readonly chat: ChatService;
  readonly watcher: FileWatcher;
  readonly agentSource: AgentSource;
  /** 자격증명 ② — enrichment LLM 키. IPC 핸들러가 이 객체만 만진다. */
  readonly llmKeys: LlmKeyStore;
  readonly sidecar: SidecarClient;
  /** `~/.codegate/wiki` — `AgentDeps.config.wikiDir` 로 주입된다. */
  readonly wikiDir: string;

  /**
   * `AgentDeps.config.roots` 는 에이전트 생성 시 한 번만 전달되므로,
   * 폴더가 추가/삭제되면 **같은 배열을 제자리에서 갱신**해 최신 상태를 유지한다.
   */
  private readonly agentRoots: string[];

  private constructor(
    private readonly options: ServicesOptions,
    parts: {
      store: Store;
      auth: AuthService;
      approval: ApprovalBroker;
      build: BuildService;
      chat: ChatService;
      watcher: FileWatcher;
      agentSource: AgentSource;
      llmKeys: LlmKeyStore;
      sidecar: SidecarClient;
      wikiDir: string;
      agentRoots: string[];
    },
  ) {
    this.store = parts.store;
    this.auth = parts.auth;
    this.approval = parts.approval;
    this.build = parts.build;
    this.chat = parts.chat;
    this.watcher = parts.watcher;
    this.agentSource = parts.agentSource;
    this.llmKeys = parts.llmKeys;
    this.sidecar = parts.sidecar;
    this.wikiDir = parts.wikiDir;
    this.agentRoots = parts.agentRoots;
  }

  static async create(options: ServicesOptions): Promise<AppServices> {
    const cloudApiUrl =
      process.env.CODEGATE_CLOUD_API_URL ??
      process.env.CODEGATE_BACKEND_URL ??
      DEFAULT_CLOUD_API_URL;
    const sidecarUrl = process.env.CODEGATE_SIDECAR_URL ?? DEFAULT_SIDECAR_URL;
    const sidecar = new SidecarClient(sidecarUrl);
    // v1.4: 조립 스테이징은 wikiDir 안에서 일어난다 (stagingDirFor) — 별도 tmpDir 불필요
    const wikiDir = path.join(options.homeDir, '.codegate', 'wiki');
    await ensureDir(wikiDir);

    const store = new Store(openDb(path.join(options.userDataDir, 'codegate.db')));
    store.clearStaleStreaming();

    const auth = new AuthService({
      cloudApiUrl,
      supabaseUrl: process.env.CODEGATE_SUPABASE_URL,
      supabasePublishableKey: process.env.CODEGATE_SUPABASE_PUBLISHABLE_KEY,
      store: new SafeStorageAuthStorage(options.userDataDir),
      onSessionChanged: (session: Session) => options.send(IPC_EVENTS.sessionChanged, session),
    });

    const approval = new ApprovalBroker({
      send: (envelope) => options.send(IPC_EVENTS.approvalRequest, envelope),
    });

    const kordoc = createKordoc({ fixtureDir: path.join(wikiDir, 'fixtures') });

    // 자격증명 ② — 백엔드 토큰(auth.bin)과 다른 파일에 따로 보관한다 (스펙 v1.4 §5)
    const llmKeys = new SafeStorageLlmKeyStore(options.userDataDir);

    /*
     * 로컬 빌드 파이프라인 (스펙 v1.4 §0).
     * 세 단계 모두 실물이 오면 이 세 줄만 바뀐다:
     *   convert  → 민규 변환 모듈
     *   enrich   → LLM API 직접 호출
     *   assemble → 용휘 빌더 코어
     */
    const mock = process.env.CODEGATE_MOCK === '1';
    const converter = createConverter({ kordoc, mock });
    const enricher = mock ? new MockEnricher() : new LlmEnricher({ keys: llmKeys });
    const builder = createBuilderCore({ mock });

    // 아직 인스턴스가 없으므로 나중에 채워 넣는 지연 참조
    let self: AppServices | null = null;

    const build = new BuildService({
      store,
      wikiDir,
      converter,
      enricher,
      builder,
      llmKeys,
      onState: (state: BuildState) => options.send(IPC_EVENTS.buildState, state),
      onFilesChanged: () => self?.emitTree(),
      // 구독 검사는 빌드 시작 전에 (스펙 v1.4 §5)
      ensureSubscription: async () => {
        await auth.ensureActiveSubscription();
      },
      onAuthError: (error: AuthError) => auth.handleAuthError(error),
    });

    const watcher = new FileWatcher({
      onChanges: (changes) => {
        void self?.onWatchChanges(changes);
      },
    });

    const { createAgent, source } = await loadCreateAgent();

    // 자격증명 ① 백엔드 토큰(auth)과 ② Anthropic 키(환경변수)는 여기서도 섞이지 않는다.
    const agentRoots: string[] = [];
    const deps: AgentDeps = {
      config: { roots: agentRoots, backendUrl: sidecarUrl, wikiDir },
      auth: {
        getToken: () => auth.getToken(),
        canWrite: () => {
          const session = auth.getSession();
          return Boolean(
            session.authenticated && session.provisioned && session.writeScope !== 'none',
          );
        },
      },
      kordoc,
      approvalHandler: approval.request,
    };

    const chat = new ChatService({
      store,
      deps,
      createAgent,
      sendEvent: (envelope) => options.send(IPC_EVENTS.agentEvent, envelope),
      onAuthError: (error) => auth.handleAuthError(error),
      rejectApprovals: () => approval.rejectAll(),
    });

    const services = new AppServices(options, {
      store,
      auth,
      approval,
      build,
      chat,
      watcher,
      agentSource: source,
      llmKeys,
      sidecar,
      wikiDir,
      agentRoots,
    });
    self = services;

    services.syncAgentRoots();
    await watcher.sync(store.listRoots());
    return services;
  }

  /* ------------------------------------------------------------- 폴더 (L4) */

  listRoots(): Root[] {
    return this.store.listRoots();
  }

  scanPreview(rootPath: string): Promise<ScanPreview> {
    return scanPreview(rootPath);
  }

  async addRoot(rootPath: string): Promise<Root> {
    const preview = await scanPreview(rootPath);
    const root: Root = {
      id: makeRootId(rootPath),
      path: rootPath,
      includedCount: preview.included.length,
      excludedCount: preview.excluded.length,
      addedAt: new Date().toISOString(),
    };
    this.store.upsertRoot(root);
    this.store.upsertFiles(await indexRoot(root.id, rootPath));

    this.syncAgentRoots();
    await this.watcher.sync(this.store.listRoots());
    this.emitTree();
    void this.build.trigger();
    return root;
  }

  async removeRoot(id: string): Promise<void> {
    this.store.removeRoot(id);
    this.syncAgentRoots();
    await this.watcher.sync(this.store.listRoots());
    this.emitTree();
  }

  /* --------------------------------------------------------------- 트리 (L1) */

  getTree(): FileNode[] {
    return buildTree(this.store.listRoots(), this.store.listFiles());
  }

  emitTree(): void {
    this.options.send(IPC_EVENTS.treeChanged, this.getTree());
  }

  /** 가상 경로(`<rootId>/<상대경로>`) → 원본 절대경로. 등록 폴더 밖이면 null. */
  resolveOriginal(virtualPath: string): string | null {
    const roots = this.store.listRoots();
    const normalized = virtualPath.replace(/^source:\/\//, '');
    const { rootId, relPath } = splitVirtualPath(normalized);
    const identifiedRoot = roots.find((root) => root.id === rootId);
    if (identifiedRoot && relPath) {
      const absolute = path.resolve(identifiedRoot.path, relPath);
      return isInside(identifiedRoot.path, absolute) ? absolute : null;
    }
    const indexedFiles = this.store.listFiles();
    for (const root of roots) {
      const indexed = indexedFiles.find(
        (file) => file.rootId === root.id && file.relPath === normalized,
      );
      if (indexed && isInside(root.path, indexed.absPath)) return indexed.absPath;
    }
    return null;
  }

  async retryExecution(messageId: string, executionId: string): Promise<ExecutionSummary> {
    this.requireWriteProvisioning();
    const execution = await this.sidecar.retry(executionId);
    const summary = executionSummary(await this.sidecar.waitForExecution(execution));
    this.store.updateMessage(messageId, { execution: summary });
    return summary;
  }

  async undoExecution(messageId: string, executionId: string): Promise<ExecutionSummary> {
    this.requireWriteProvisioning();
    const execution = await this.sidecar.undo(executionId);
    const summary = executionSummary(await this.sidecar.waitForExecution(execution));
    this.store.updateMessage(messageId, { execution: summary });
    return summary;
  }

  /* --------------------------------------------------------------- 정리 */

  async dispose(): Promise<void> {
    this.approval.rejectAll();
    this.chat.abortAll();
    await this.watcher.close();
    this.store.close();
  }

  private async onWatchChanges(changes: WatchChange[]): Promise<void> {
    try {
      for (const change of changes) {
        if (change.kind === 'unlink') {
          this.store.markFileDeleted(change.rootId, change.relPath);
          continue;
        }
        const row = await describeFile(change.rootId, change.relPath, change.absPath);
        if (!row) continue;
        // 내용이 그대로면(단순 touch·메타데이터 변경) 재빌드 대상으로 올리지 않는다
        const previous = this.store.findFile(change.rootId, change.relPath);
        if (previous && !previous.dirty && previous.sha256 === row.sha256) continue;
        this.store.upsertFiles([row]);
      }
      this.emitTree();
      // debounce 로 이미 한 번에 묶여 들어왔으므로 여기서 재빌드는 한 번만 일어난다
      void this.build.trigger();
    } catch (err) {
      logError('watcher:apply', err);
    }
  }

  /** 등록 폴더 목록을 `AgentDeps.config.roots` 배열에 제자리 반영. */
  private syncAgentRoots(): void {
    const paths = this.store.listRoots().map((r) => r.path);
    this.agentRoots.splice(0, this.agentRoots.length, ...paths);
  }

  private requireWriteProvisioning(): void {
    const session = this.auth.getSession();
    if (!session.authenticated || !session.provisioned || session.writeScope === 'none') {
      throw new AuthError('not_provisioned', '계정에 문서 쓰기 권한이 연결되지 않았습니다.');
    }
  }
}
