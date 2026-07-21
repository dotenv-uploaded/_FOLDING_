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
  LlmKeyInput,
  LlmKeyStatus,
  LlmProvider,
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
import { openDb, Store, type FileRow } from '@main/db/store';
import { ApprovalBroker } from '@main/agent/approval';
import { ChatService } from '@main/agent/host';
import { loadCreateAgent, type AgentSource } from '@main/agent/loader';
import { createKordoc } from '@main/kordoc';
import { buildTree } from '@main/tree';
import { UserFacingError, logError, toUserMessage } from '@main/util/errors';
import { ensureDir } from '@main/util/fsx';
import { isInside, makeRootId, sourceUriToRelativePath, splitVirtualPath } from '@main/util/vpath';
import { FileWatcher, type WatchChange } from '@main/watcher';
import { describeFile, indexRoot, scanPreview } from '@main/watcher/scan';
import { SidecarClient } from '@main/sidecar/client';
import {
  SidecarSupervisor,
  type SidecarRuntimePaths,
  validateSidecarRuntimePaths,
} from '@main/sidecar/supervisor';
import { executionSummary } from '@main/agent/sidecar-agent';
import { syncNormalizedInputs, type InputSyncProgress } from '@main/sidecar/input-sync';

const DEFAULT_CLOUD_API_URL = 'http://127.0.0.1:8787/api/v1';
// sidecar 주소는 더 이상 고정값이 아니다 — SidecarSupervisor 가 빈 포트를 잡아 정한다.
// 이미 떠 있는 엔진에 붙으려면 CODEGATE_SIDECAR_URL 로 지정한다.

export interface ServicesOptions {
  /** `app.getPath('userData')` */
  userDataDir: string;
  /** `app.getPath('home')` */
  homeDir: string;
  /** 렌더러로 단방향 푸시 */
  send: (channel: string, payload: unknown) => void;
  /** 패키징 자원 경로. 테스트와 개발 도구에서는 생략 가능하다. */
  resourcesPath?: string;
  isPackaged?: boolean;
  projectDir?: string;
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
  /** L2 — sidecar 프로세스를 띄우고 지켜본다 (스펙 v2.1 §1 L2). */
  readonly supervisor: SidecarSupervisor;
  /** `~/.codegate/wiki` — `AgentDeps.config.wikiDir` 로 주입된다. */
  readonly wikiDir: string;

  /**
   * `AgentDeps.config.roots` 는 에이전트 생성 시 한 번만 전달되므로,
   * 폴더가 추가/삭제되면 **같은 배열을 제자리에서 갱신**해 최신 상태를 유지한다.
   */
  private readonly agentRoots: string[];
  private disposed = false;
  private rootGeneration = 0;
  private currentBuildState: BuildState | null = null;
  private readonly scanPreviews = new Map<string, ScanPreview>();
  private knowledgeSyncRequested = false;
  private knowledgeSyncRunning = false;
  private knowledgeSyncTimer: NodeJS.Timeout | null = null;

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
      supervisor: SidecarSupervisor;
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
    this.supervisor = parts.supervisor;
    this.wikiDir = parts.wikiDir;
    this.agentRoots = parts.agentRoots;
  }

  static async create(options: ServicesOptions): Promise<AppServices> {
    const authMode = process.env.CODEGATE_AUTH_MODE === 'supabase' ? 'supabase' : 'local';
    const cloudApiUrl =
      process.env.CODEGATE_CLOUD_API_URL ??
      process.env.CODEGATE_BACKEND_URL ??
      DEFAULT_CLOUD_API_URL;
    const wikiDir = path.join(options.homeDir, '.codegate', 'wiki');
    await ensureDir(wikiDir);
    const store = new Store(openDb(path.join(options.userDataDir, 'codegate.db')));
    store.clearStaleStreaming();
    const llmKeys = new SafeStorageLlmKeyStore(options.userDataDir);

    /*
     * sidecar 수명주기 (스펙 v2.1 §1 L2).
     *
     * `CODEGATE_SIDECAR_URL` 이 있으면 이미 떠 있는 엔진에 붙기만 하고 spawn 하지 않는다
     * (개발 중 수동 실행 등 — 남의 프로세스를 관리하려 들지 않는다).
     * 없으면 우리가 빈 포트를 잡아 직접 띄우고, 죽으면 되살리고, 앱 종료 시 함께 내린다.
     *
     * prepare() 를 먼저 불러 URL 을 확정한 뒤 클라이언트를 만든다 — 포트를 미리 잡아 두면
     * 재기동해도 URL 이 바뀌지 않아 이미 만들어진 클라이언트가 그대로 유효하다.
     */
    const supervisor = new SidecarSupervisor({
      corsOrigin: process.env['ELECTRON_RENDERER_URL'] ?? 'app://codegate',
      externalUrl: process.env.CODEGATE_SIDECAR_URL,
      binary: sidecarBinary(options),
      resolveAnthropicApiKey: () => llmKeys.get('anthropic'),
      onState: (state) => options.send(IPC_EVENTS.sidecarState, state),
    });
    const initialRoot = store.listRoots()[0];
    const sidecarOrigin = await supervisor.prepare();
    const sidecarUrl = `${sidecarOrigin}/api/v1`;
    const sidecar = new SidecarClient(sidecarUrl);

    const auth = new AuthService({
      authMode,
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
      onState: (state: BuildState) => {
        if (self) self.publishBuildState(state);
        else options.send(IPC_EVENTS.buildState, state);
      },
      onFilesChanged: () => self?.emitTree(),
      // 구독 검사는 빌드 시작 전에 (스펙 v1.4 §5)
      ensureSubscription: async () => {
        if (authMode === 'supabase') await auth.ensureActiveSubscription();
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
          if (authMode === 'local') return agentRoots.length > 0;
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
      supervisor,
      wikiDir,
      agentRoots,
    });
    self = services;

    services.syncAgentRoots();
    await watcher.sync(store.listRoots());

    // 창은 먼저 띄우되, 기존 폴더가 있으면 실제 원본을 정규화한 뒤 sidecar를 시작한다.
    // 빈 fixture가 이미 있다고 가정하면 신규 사용자의 첫 검색이 항상 빈 결과가 된다.
    if (initialRoot) {
      services.requestKnowledgeSync('저장된 문서를 다시 확인하는 중');
    } else {
      void supervisor.start().catch((err: unknown) => logError('sidecar:start', err));
    }

    return services;
  }

  /* ------------------------------------------------------------- 폴더 (L4) */

  listRoots(): Root[] {
    return this.store.listRoots();
  }

  async scanPreview(rootPath: string): Promise<ScanPreview> {
    const preview = await scanPreview(rootPath);
    this.scanPreviews.set(rootPath, preview);
    return preview;
  }

  async addRoot(rootPath: string): Promise<Root> {
    const existing = this.store.listRoots();
    try {
      if (existing.length > 0 && existing[0]?.path !== rootPath) {
        throw new UserFacingError(
          '현재 버전은 문서 폴더 하나만 연결할 수 있습니다. 기존 폴더를 제거한 뒤 다시 선택해 주세요.',
        );
      }
      if (existing[0]?.path === rootPath) {
        this.requestKnowledgeSync(
          this.chat.busy ? '현재 답변이 끝나면 문서를 다시 확인합니다' : '문서를 다시 확인하는 중',
        );
        return existing[0];
      }
      const preview = this.scanPreviews.get(rootPath);
      const root: Root = {
        id: makeRootId(rootPath),
        path: rootPath,
        includedCount: preview?.included.length ?? 0,
        excludedCount: preview?.excluded.length ?? 0,
        addedAt: new Date().toISOString(),
      };
      const runtime = sidecarRuntimePaths(this.options, rootPath);
      await validateSidecarRuntimePaths(runtime);
      const pendingRows = (preview?.included ?? []).map((relativePath) =>
        pendingFileRow(root.id, root.path, relativePath),
      );
      await this.watcher.sync([root]);
      this.store.replaceRootFiles(root, pendingRows);
      this.syncAgentRoots();
      this.emitTree();
      this.scanPreviews.delete(rootPath);
      this.requestKnowledgeSync('문서를 백그라운드에서 준비하는 중');
      return root;
    } catch (err) {
      await this.watcher
        .sync(existing)
        .catch((watchError: unknown) => logError('watcher:registration-rollback', watchError));
      this.emitKnowledgeBuildState({
        status: 'failed',
        progress: 0,
        message: '문서 준비 실패',
        error: toUserMessage(err, '문서를 준비하지 못했습니다. 실행 로그를 확인해 주세요.'),
      });
      throw err;
    }
  }

  async removeRoot(id: string): Promise<void> {
    this.rootGeneration += 1;
    this.knowledgeSyncRequested = false;
    if (this.knowledgeSyncTimer) clearTimeout(this.knowledgeSyncTimer);
    this.knowledgeSyncTimer = null;
    this.store.removeRoot(id);
    this.syncAgentRoots();
    await this.watcher.sync(this.store.listRoots());
    this.emitTree();
    await this.supervisor.stop().catch((err: unknown) => logError('sidecar:stop', err));
    this.supervisor.clearRuntime();
    this.emitKnowledgeBuildState({
      status: 'idle',
      progress: 0,
      message: '문서 폴더를 선택해 주세요',
    });
  }

  /* --------------------------------------------------------------- 트리 (L1) */

  getTree(): FileNode[] {
    return buildTree(this.store.listRoots(), this.store.listFiles());
  }

  getBuildState(): BuildState {
    return this.currentBuildState ?? this.build.getState();
  }

  emitTree(): void {
    this.options.send(IPC_EVENTS.treeChanged, this.getTree());
  }

  /** 가상 경로(`<rootId>/<상대경로>`) → 원본 절대경로. 등록 폴더 밖이면 null. */
  resolveOriginal(virtualPath: string): string | null {
    const roots = this.store.listRoots();
    const normalized = sourceUriToRelativePath(virtualPath) ?? virtualPath;
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

  sendChat(conversationId: string, text: string): { messageId: string } {
    const state = this.currentBuildState;
    if (state?.buildId === 'knowledge-sync' && state.status !== 'done') {
      throw new UserFacingError(
        state.status === 'failed'
          ? (state.error ?? '문서 검색 엔진을 준비하지 못했습니다.')
          : '문서 검색 엔진을 준비하고 있습니다. 완료된 뒤 다시 질문해 주세요.',
      );
    }
    return this.chat.send(conversationId, text);
  }

  async undoExecution(messageId: string, executionId: string): Promise<ExecutionSummary> {
    this.requireWriteProvisioning();
    const execution = await this.sidecar.undo(executionId);
    const summary = executionSummary(await this.sidecar.waitForExecution(execution));
    this.store.updateMessage(messageId, { execution: summary });
    return summary;
  }

  async setLlmKey(input: LlmKeyInput): Promise<LlmKeyStatus[]> {
    const status = await this.llmKeys.set(input);
    if (input.provider === 'anthropic' && this.supervisor.configured) {
      await this.supervisor.restart();
    }
    return status;
  }

  async clearLlmKey(provider: LlmProvider): Promise<LlmKeyStatus[]> {
    const status = await this.llmKeys.clear(provider);
    // 실행 중인 process가 삭제 전 키를 계속 들고 있지 않게 즉시 내린다.
    if (provider === 'anthropic') {
      await this.supervisor.stop();
    }
    return status;
  }

  /* --------------------------------------------------------------- 정리 */

  async dispose(): Promise<void> {
    this.disposed = true;
    this.rootGeneration += 1;
    this.knowledgeSyncRequested = false;
    if (this.knowledgeSyncTimer) clearTimeout(this.knowledgeSyncTimer);
    this.knowledgeSyncTimer = null;
    this.approval.rejectAll();
    this.chat.abortAll();
    await this.watcher.close();
    // 파이썬을 고아 프로세스로 남기지 않는다 (스펙 v2.1 §1 L2)
    await this.supervisor.dispose().catch((err: unknown) => logError('sidecar:stop', err));
    this.store.close();
  }

  private async onWatchChanges(changes: WatchChange[]): Promise<void> {
    try {
      let knowledgeChanged = false;
      for (const change of changes) {
        const previous = this.store.findFile(change.rootId, change.relPath);
        if (change.kind === 'unlink') {
          if (!watchChangeNeedsKnowledgeSync(change.kind, previous, null)) continue;
          this.store.markFileDeleted(change.rootId, change.relPath);
          knowledgeChanged = true;
          continue;
        }
        const row = await describeFile(change.rootId, change.relPath, change.absPath);
        // 내용이 그대로면(단순 touch·메타데이터 변경) 재빌드 대상으로 올리지 않는다
        if (!watchChangeNeedsKnowledgeSync(change.kind, previous, row)) continue;
        if (!row) continue;
        this.store.upsertFiles([row]);
        knowledgeChanged = true;
      }
      if (!knowledgeChanged) return;
      this.emitTree();
      // debounce로 묶인 변경을 production normalized input과 sidecar corpus에 한 번 반영한다.
      this.requestKnowledgeSync(
        this.chat.busy ? '현재 답변이 끝나면 문서 변경을 반영합니다' : '문서 변경을 반영하는 중',
      );
    } catch (err) {
      logError('watcher:apply', err);
    }
  }

  private async syncSidecarKnowledge(root: Root): Promise<void> {
    const generation = this.rootGeneration;
    try {
      this.emitKnowledgeBuildState({
        status: 'scanning',
        progress: 2,
        message: '문서 목록을 확인하는 중',
      });
      const rows = await indexRoot(root.id, root.path);
      const preview = await scanPreview(root.path);
      const refreshedRoot: Root = {
        ...root,
        includedCount: preview.included.length,
        excludedCount: preview.excluded.length,
      };
      if (!this.isCurrentRootGeneration(root, generation)) return;
      // 변환·엔진 준비를 기다리지 않고 파일 트리를 먼저 보여준다.
      this.store.replaceRootFiles(refreshedRoot, rows);
      this.emitTree();
      const runtime = sidecarRuntimePaths(this.options, root.path);
      await validateSidecarRuntimePaths(runtime);
      await this.supervisor.stop();
      await syncNormalizedInputs({
        files: rows,
        inputRoot: runtime.llmwikiInputRoot,
        doc2mdUrl: runtime.doc2mdUrl,
        onProgress: (progress) => this.emitInputSyncProgress(progress),
      });
      if (!this.isCurrentRootGeneration(root, generation)) return;
      this.emitKnowledgeBuildState({
        status: 'assembling',
        progress: 78,
        phase: { name: 'assemble', done: 0, total: 1 },
        message: '위키 인덱스를 준비하는 중',
      });
      this.supervisor.configure(runtime);
      this.emitKnowledgeBuildState({
        status: 'assembling',
        progress: 86,
        phase: { name: 'assemble', done: 0, total: 1 },
        message: '검색 엔진을 준비하는 중',
      });
      await this.supervisor.restart();
      if (!this.isCurrentRootGeneration(root, generation)) return;
      const sidecarState = this.supervisor.getState();
      if (!['ready', 'external'].includes(sidecarState.status)) {
        throw new UserFacingError(
          sidecarState.error ?? '검색 엔진을 준비하지 못했습니다. 실행 로그를 확인해 주세요.',
        );
      }
      this.store.replaceRootFiles(refreshedRoot, completedFileRows(rows));
      this.emitTree();
      this.emitKnowledgeBuildState({
        status: 'done',
        progress: 100,
        message: `${rows.length}개 문서 준비 완료`,
      });
    } catch (err) {
      if (this.isCurrentRootGeneration(root, generation)) {
        await this.supervisor
          .stop()
          .catch((stopError: unknown) => logError('sidecar:sync-rollback', stopError));
        this.emitKnowledgeBuildState({
          status: 'failed',
          progress: 0,
          message: '문서 변경 반영 실패',
          error: toUserMessage(err, '문서 변경을 반영하지 못했습니다. 실행 로그를 확인해 주세요.'),
        });
      }
      throw err;
    }
  }

  private requestKnowledgeSync(message: string): void {
    if (this.disposed || this.store.listRoots().length === 0) return;
    this.knowledgeSyncRequested = true;
    this.emitKnowledgeBuildState({ status: 'scanning', progress: 1, message });
    this.scheduleKnowledgeSync();
  }

  private scheduleKnowledgeSync(delayMs = 0): void {
    if (this.disposed || this.knowledgeSyncRunning || this.knowledgeSyncTimer) return;
    this.knowledgeSyncTimer = setTimeout(() => {
      this.knowledgeSyncTimer = null;
      void this.flushKnowledgeSync();
    }, delayMs);
    this.knowledgeSyncTimer.unref();
  }

  private async flushKnowledgeSync(): Promise<void> {
    if (this.disposed || !this.knowledgeSyncRequested || this.knowledgeSyncRunning) return;
    if (this.chat.busy) {
      this.scheduleKnowledgeSync(500);
      return;
    }
    const root = this.store.listRoots()[0];
    if (!root) return;
    this.knowledgeSyncRequested = false;
    this.knowledgeSyncRunning = true;
    try {
      await this.syncSidecarKnowledge(root);
    } catch (err) {
      logError('sidecar:knowledge-sync', err);
    } finally {
      this.knowledgeSyncRunning = false;
      if (this.knowledgeSyncRequested) this.scheduleKnowledgeSync();
    }
  }

  private isCurrentRootGeneration(root: Root, generation: number): boolean {
    return (
      !this.disposed &&
      generation === this.rootGeneration &&
      this.store.listRoots().some((candidate) => candidate.id === root.id)
    );
  }

  private emitInputSyncProgress(progress: InputSyncProgress): void {
    const ratio = progress.total > 0 ? progress.done / progress.total : 1;
    const overall = Math.round(5 + Math.min(Math.max(ratio, 0), 1) * 68);
    const filename = progress.relativePath ? path.basename(progress.relativePath) : null;
    const detail = filename ? ` · ${filename}` : '';
    this.emitKnowledgeBuildState({
      status: 'converting',
      progress: overall,
      phase: { name: 'convert', done: progress.done, total: progress.total },
      message: `문서를 변환하는 중 (${progress.done}/${progress.total})${detail}`,
    });
  }

  private emitKnowledgeBuildState(
    patch: Pick<BuildState, 'status' | 'progress' | 'message'> &
      Partial<Pick<BuildState, 'phase' | 'error'>>,
  ): void {
    this.publishBuildState({
      buildId: 'knowledge-sync',
      ...patch,
      phase: patch.phase,
      error: patch.error,
      updatedAt: new Date().toISOString(),
    } satisfies BuildState);
  }

  private publishBuildState(state: BuildState): void {
    this.currentBuildState = state;
    this.options.send(IPC_EVENTS.buildState, state);
  }

  /** 등록 폴더 목록을 `AgentDeps.config.roots` 배열에 제자리 반영. */
  private syncAgentRoots(): void {
    const paths = this.store.listRoots().map((r) => r.path);
    this.agentRoots.splice(0, this.agentRoots.length, ...paths);
  }

  private requireWriteProvisioning(): void {
    if (process.env.CODEGATE_AUTH_MODE !== 'supabase') {
      if (this.store.listRoots().length === 0) {
        throw new AuthError('not_provisioned', '먼저 문서 폴더를 선택해 주세요.');
      }
      return;
    }
    const session = this.auth.getSession();
    if (!session.authenticated || !session.provisioned || session.writeScope === 'none') {
      throw new AuthError('not_provisioned', '계정에 문서 쓰기 권한이 연결되지 않았습니다.');
    }
  }
}

export function watchChangeNeedsKnowledgeSync(
  kind: WatchChange['kind'],
  previous: FileRow | null | undefined,
  next: FileRow | null,
): boolean {
  if (kind === 'unlink') return Boolean(previous && !previous.deleted);
  if (!next) return false;
  return !(previous && !previous.dirty && previous.sha256 === next.sha256);
}

function sidecarRuntimePaths(options: ServicesOptions, sourceRoot: string): SidecarRuntimePaths {
  const runtimeRoot = path.join(options.userDataDir, 'sidecar');
  const projectDir = options.projectDir ?? process.cwd();
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  const developmentBundle = path.resolve(projectDir, '..', 'LLMWIKI');
  const packagedBundle = path.join(resourcesPath, 'LLMWIKI');
  return {
    sourceRoot,
    llmwikiProjectRoot:
      process.env.CODEGATE_LLMWIKI_PROJECT_ROOT ??
      (options.isPackaged ? packagedBundle : developmentBundle),
    llmwikiInputRoot:
      process.env.CODEGATE_LLMWIKI_INPUT_ROOT ?? path.join(runtimeRoot, 'source-md'),
    llmwikiStorageRoot:
      process.env.CODEGATE_LLMWIKI_STORAGE_ROOT ?? path.join(runtimeRoot, 'llmwiki-storage'),
    dataRoot: process.env.CODEGATE_SIDECAR_DATA_ROOT ?? path.join(runtimeRoot, 'app-data'),
    doc2mdUrl: process.env.CODEGATE_DOC2MD_URL,
    deterministicAgent:
      process.env.CODEGATE_AGENT_MODE === 'deterministic' || process.env.CODEGATE_MOCK === '1',
    claudeModel: process.env.CODEGATE_CLAUDE_MODEL ?? 'sonnet',
    claudeTimeoutSeconds: localClaudeTimeoutSeconds(),
    tenantId: process.env.CODEGATE_LLMWIKI_TENANT_ID ?? 'local',
    wikiId: process.env.CODEGATE_LLMWIKI_WIKI_ID ?? 'workspace',
  };
}

function sidecarBinary(options: ServicesOptions): string {
  if (process.env.CODEGATE_SIDECAR_BIN) return process.env.CODEGATE_SIDECAR_BIN;
  const executable = process.platform === 'win32' ? 'codegate-local.exe' : 'codegate-local';
  if (options.isPackaged) {
    return path.join(options.resourcesPath ?? process.resourcesPath, 'sidecar', executable);
  }
  return path.resolve(
    options.projectDir ?? process.cwd(),
    '..',
    'Backend',
    '.venv',
    process.platform === 'win32' ? 'Scripts' : 'bin',
    executable,
  );
}

function completedFileRows(rows: FileRow[]): FileRow[] {
  return rows.map((row) => ({ ...row, status: 'done', dirty: false, deleted: false }));
}

function localClaudeTimeoutSeconds(): number {
  const configured = Number(process.env.CODEGATE_CLAUDE_TIMEOUT_SECONDS ?? 180);
  return Number.isFinite(configured) && configured >= 1 && configured <= 300 ? configured : 180;
}

function pendingFileRow(rootId: string, rootPath: string, relativePath: string): FileRow {
  const absPath = path.resolve(rootPath, relativePath);
  if (!isInside(rootPath, absPath)) {
    throw new UserFacingError(`등록 폴더 밖의 파일은 추가할 수 없습니다: ${relativePath}`);
  }
  return {
    rootId,
    relPath: relativePath,
    absPath,
    sha256: '',
    size: 0,
    mtime: '',
    status: 'pending',
    dirty: true,
    deleted: false,
  };
}
