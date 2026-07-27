/**
 * 메인 프로세스 서비스 컨테이너 — L2·L3·L4 와 에이전트 호스트를 한 곳에서 조립한다.
 * IPC 핸들러(`ipc.ts`)와 앱 부트스트랩(`index.ts`)은 이 객체만 본다.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
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
  WikiGraph,
  UsageStatus,
} from '@contracts';
import {
  AuthError,
  BASE_CREDITS,
  IPC_EVENTS,
  USAGE_BLOCKED_MESSAGE,
  USAGE_LIMIT_KRW,
  creditsForDocuments,
  toCredits,
  type UsageKind,
  type UsagePool,
} from '@contracts';
import { AuthService, SafeStorageAuthStorage } from '@main/auth';
import { SafeStorageLlmKeyStore, type LlmKeyStore } from '@main/auth/llm-key';
import { ManagedLlmKeyStore, readInternalApiKey } from '@main/auth/internal-key';
import { createConverter } from '@main/build/convert';
import { LlmEnricher, MockEnricher } from '@main/build/enrich';
import { createBuilderCore } from '@main/build/assemble';
import { readWikiGraph } from '@main/build/graph';
import { BuildEstimateBroker } from '@main/build/estimate-broker';
import { costUsdOf } from '@main/build/pricing';
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
import { resolveRootSelection } from '@main/util/roots';
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
  /** 문서 분석 예상 크레딧 확인 — 렌더러의 답을 여기로 전달한다. */
  readonly buildEstimates: BuildEstimateBroker;
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
  /** 사용자가 `지금 빌드` 를 눌렀는가 — 이때만 위키를 통째로 다시 만든다. */
  private knowledgeRebuildRequested = false;
  private knowledgeSyncRunning = false;
  private knowledgeSyncTimer: NodeJS.Timeout | null = null;

  private constructor(
    private readonly options: ServicesOptions,
    parts: {
      store: Store;
      auth: AuthService;
      approval: ApprovalBroker;
      buildEstimates: BuildEstimateBroker;
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
    this.buildEstimates = parts.buildEstimates;
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
    const authMode = process.env.CODEGATE_AUTH_MODE === 'cloud' ? 'cloud' : 'local';
    const cloudApiUrl =
      process.env.CODEGATE_CLOUD_API_URL ??
      process.env.CODEGATE_BACKEND_URL ??
      DEFAULT_CLOUD_API_URL;
    const wikiDir = path.join(options.homeDir, '.codegate', 'wiki');
    await ensureDir(wikiDir);
    const store = new Store(openDb(path.join(options.userDataDir, 'codegate.db')));
    store.clearStaleStreaming();
    /*
     * 문서 분석 키는 **구독에 포함**된다 — 사용자는 발급받지도 입력하지도 않는다.
     * 내부 키가 있으면 그것이 이기고, 없으면 예전처럼 사용자가 넣어 둔 키로 폴백한다.
     * (내부 키를 설치본에 심는 것은 임시 배선이다 — 근거는 internal-key.ts 주석 참고)
     */
    const internalApiKey = readInternalApiKey(process.env);
    const llmKeys = new ManagedLlmKeyStore(
      new SafeStorageLlmKeyStore(options.userDataDir),
      internalApiKey,
    );
    console.info(
      internalApiKey
        ? '[codegate:llm] 구독 키(내부)로 동작합니다 — 사용자 키 입력 단계 없음.'
        : '[codegate:llm] 내부 키가 없습니다. 설정에 저장된 사용자 키로 폴백합니다.',
    );

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
      // 위키 enrichment(그래프 간선)는 Gemini 로 만들어져 있다 — 이 키가 없으면 관계가
      // 하나도 생기지 않아 그래프에 점만 남는다.
      resolveGeminiApiKey: () => llmKeys.get('gemini'),
      onState: (state) => options.send(IPC_EVENTS.sidecarState, state),
    });
    const initialRoot = store.listRoots()[0];
    const sidecarOrigin = await supervisor.prepare();
    const sidecarUrl = `${sidecarOrigin}/api/v1`;
    const sidecar = new SidecarClient(sidecarUrl);

    const auth = new AuthService({
      authMode,
      cloudApiUrl,
      store: new SafeStorageAuthStorage(options.userDataDir),
      onSessionChanged: (session: Session) => options.send(IPC_EVENTS.sessionChanged, session),
    });

    const approval = new ApprovalBroker({
      send: (envelope) => options.send(IPC_EVENTS.approvalRequest, envelope),
    });

    // 문서 분석을 시작하기 전 예상 크레딧을 묻는 창.
    const buildEstimates = new BuildEstimateBroker({
      send: (envelope) => options.send(IPC_EVENTS.buildEstimate, envelope),
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
    /*
     * 문서 분석은 제공자가 **금액을 알려주지 않는다** — 토큰 수만 준다. 그래서 여기서
     * 단가표로 값을 매겨 사용량에 남긴다. 이게 없으면 폴더를 통째로 등록해도 사용량은 0 이다.
     * 단가를 모르는 모델이면 금액은 비우고 토큰만 남긴다 — "모른다"와 "안 썼다"는 다르다.
     */
    const enricher = mock
      ? new MockEnricher()
      : new LlmEnricher({
          keys: llmKeys,
          onUsage: (usage) =>
            self?.recordUsage(costUsdOf(usage), 'build', {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              model: usage.model,
              units: 1, // 문서 하나를 분석했다
            }),
        });
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
        if (authMode === 'cloud') await auth.ensureActiveSubscription();
      },
      onAuthError: (error: AuthError) => auth.handleAuthError(error),
      remainingBuildCredits: () => self?.usageStatus().pools.build.remainingCredits ?? 0,
      confirmEstimate: (estimate) => buildEstimates.request(estimate),
    });

    const watcher = new FileWatcher({
      onChanges: (changes) => {
        void self?.onWatchChanges(changes);
      },
    });

    // 비용은 services 가 생기기 전에 배선된다 — watcher 와 같은 지연 참조를 쓴다.
    const { createAgent, source } = await loadCreateAgent((costUsd) => {
      self?.recordUsage(costUsd, 'chat');
    });

    // 자격증명 ① 백엔드 토큰(auth)과 ② Anthropic 키(환경변수)는 여기서도 섞이지 않는다.
    const agentRoots: string[] = [];
    const deps: AgentDeps = {
      config: {
        roots: agentRoots,
        backendUrl: sidecarUrl,
        wikiDir,
        wikiInputRoot: sidecarRuntimePaths(options, initialRoot?.path ?? '').llmwikiInputRoot,
      },
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
      buildEstimates,
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

  /**
   * 문서 폴더를 등록한다. **여러 개를 등록할 수 있고, 겹치면 최상위만 남는다.**
   *
   * 겹치는 폴더를 그대로 두면 같은 파일이 두 번 인덱싱되어 위키에 중복 문서가 생기고,
   * 인용이 어느 쪽을 가리키는지 알 수 없게 된다. 그래서 표현이 아니라 **저장 단계에서**
   * 정리한다 (`resolveRootSelection`).
   */
  async addRoot(rootPath: string): Promise<Root> {
    const existing = this.store.listRoots();
    try {
      const selection = resolveRootSelection(
        existing.map((root) => root.path),
        [rootPath],
      );

      // 이미 등록된 폴더 안에 있으면 새로 넣지 않고, 문서만 다시 확인한다.
      if (selection.alreadyCovered.length > 0) {
        const covering =
          existing.find((root) => root.path === rootPath) ??
          existing.find((root) => isInside(root.path, rootPath));
        this.requestKnowledgeSync(
          this.chat.busy ? '현재 답변이 끝나면 문서를 다시 확인합니다' : '문서를 다시 확인하는 중',
        );
        if (covering) return covering;
      }

      // 상위 폴더를 고른 경우 — 흡수된 하위 폴더들을 먼저 걷어낸다.
      for (const absorbed of selection.replaced) {
        const stale = existing.find((root) => root.path === absorbed);
        if (stale) this.store.removeRoot(stale.id);
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
      // 남아 있는 폴더 전부를 감시한다 — 새로 넣은 것만 감시하면 기존 폴더의 변경을 놓친다.
      const kept = this.store.listRoots().filter((r) => r.path !== root.path);
      await this.watcher.sync([...kept, root]);
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

  /**
   * 활성 위키 빌드의 지식 그래프.
   *
   * 저장 경로는 sidecar 런타임과 같은 규칙으로 정한다 — 그래야 sidecar 가 만든 빌드를
   * 그대로 읽는다. 빌드가 없으면 빈 그래프가 나오고, 화면은 그 사실을 그대로 보여준다.
   */
  async getWikiGraph(): Promise<WikiGraph> {
    const root = this.store.listRoots()[0];
    const runtime = sidecarRuntimePaths(this.options, root?.path ?? '');
    return readWikiGraph({
      storageRoot: runtime.llmwikiStorageRoot,
      // 런타임 설정에서 비어 있으면 sidecarRuntimePaths 와 같은 기본값을 쓴다 —
      // 여기서만 다른 값을 쓰면 sidecar 가 쓴 빌드를 못 찾는다.
      tenantId: runtime.tenantId ?? 'local',
      wikiId: runtime.wikiId ?? 'workspace',
    });
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

  /**
   * 채팅은 **문서 준비 상태와 무관하게 항상 받는다.**
   *
   * 예전에는 준비가 끝나지 않으면 질문 자체를 거부했다. 그런데 위키 빌드는 불변이라
   * 새 빌드를 만드는 중에도 **직전 활성 빌드로 답할 수 있고**, 준비가 실패하면 영영
   * 질문할 수 없는 막다른 길이 됐다. 근거가 없으면 에이전트가 "위키에서 확인되지 않음"
   * 이라고 답하므로, 막는 것보다 답하게 두는 편이 정직하고 쓸모 있다.
   */
  sendChat(conversationId: string, text: string): { messageId: string } {
    // 한도를 넘겼으면 **보내기 전에** 막는다. 보내고 나서 막으면 이미 돈이 나간 뒤다.
    const usage = this.usageStatus();
    if (usage.blocked) {
      throw new UserFacingError(USAGE_BLOCKED_MESSAGE);
    }
    return this.chat.send(conversationId, text);
  }

  /* ------------------------------------------------------------ 구독 사용량 */

  /** 지금 이 사용자를 가리키는 키. 로그인 전이면 이 기기 몫으로 센다. */
  private usageSubject(): string {
    return this.auth.getSession().subjectId ?? 'local';
  }

  /**
   * 사용량 현황.
   *
   * 저장은 USD(제공자가 계산해 준 값), 표시는 원. 환산을 여기 한 곳에서만 해서 화면마다
   * 다른 환율이 쓰이는 일이 없게 한다.
   */
  usageStatus(): UsageStatus {
    const subject = this.usageSubject();
    const { costUsd, calls } = this.store.usageTotal(subject);
    const extraKrw = this.store.creditTotalKrw(subject);
    const usedKrw = Math.round(costUsd * usdToKrwRate());
    const remainingKrw = USAGE_LIMIT_KRW + extraKrw - usedKrw;
    const extraCredits = toCredits(extraKrw);
    return {
      usedKrw,
      limitKrw: USAGE_LIMIT_KRW,
      extraKrw,
      remainingKrw,
      // 막히는 것은 **대화**다. 문서 분석은 자기 지갑을 따로 본다.
      blocked: this.spendable('chat', extraCredits) <= 0,
      calls,
      pools: { chat: this.pool('chat'), build: this.pool('build') },
      extraCredits,
    };
  }

  /**
   * 지갑 하나의 현황. `remainingCredits` 는 **기본 크레딧의 잔여만** 센다.
   *
   * 추가 크레딧은 지갑에 나눠 넣지 않는다 — 산 크레딧을 대화에 쓸지 문서에 쓸지는 그때그때
   * 사용자가 정할 일이다. 그래서 공용으로 따로 두고, 두 지갑 어느 쪽이든 기본이 떨어진 뒤에
   * 쓰인다. 여기서 더해 버리면 같은 크레딧이 두 지갑에 두 번 있는 것처럼 보인다.
   */
  private pool(kind: UsageKind): UsagePool {
    const { units } = this.store.usageTotal(this.usageSubject(), kind);
    // 대화는 한 건이 1 크레딧, 문서 분석은 20개가 1 크레딧 — 크레딧은 제품 단위지 원가가 아니다.
    const usedCredits = kind === 'build' ? creditsForDocuments(units) : units;
    const limitCredits = BASE_CREDITS[kind];
    return {
      kind,
      usedCredits,
      limitCredits,
      remainingCredits: Math.max(limitCredits - usedCredits, 0),
    };
  }

  /** 이 지갑으로 지금 쓸 수 있는 양 = 기본 잔여 + 공용 추가 크레딧. */
  private spendable(kind: UsageKind, extraCredits: number): number {
    return this.pool(kind).remainingCredits + Math.max(extraCredits, 0);
  }

  /**
   * 호출 한 건이 쓴 양을 기록한다.
   *
   * 금액을 몰라도 **토큰이 있으면 남긴다.** 금액만 보고 버리면 "안 썼다"와 "모른다"가
   * 같아지고, 그 순간 사용량은 조용히 새기 시작한다.
   */
  recordUsage(
    costUsd: number | null | undefined,
    source: string,
    detail?: {
      inputTokens?: number | null;
      outputTokens?: number | null;
      model?: string | null;
      units?: number;
    },
  ): void {
    this.store.recordUsage({
      id: randomUUID(),
      subjectId: this.usageSubject(),
      costUsd: costUsd ?? null,
      source,
      createdAt: new Date().toISOString(),
      inputTokens: detail?.inputTokens ?? null,
      outputTokens: detail?.outputTokens ?? null,
      model: detail?.model ?? null,
      units: detail?.units ?? 1,
    });
    this.options.send(IPC_EVENTS.usageChanged, this.usageStatus());
  }

  /**
   * 크레딧 추가.
   *
   * **결제는 아직 없다.** 지금은 화면과 한도 해제 흐름을 잇는 자리이고, 실제 결제가 붙으면
   * 이 함수가 결제 확인 뒤에 불리게 된다. 결제 없이 크레딧이 늘어난다는 사실을 감추지 않는다.
   */
  purchaseCredit(amountKrw: number): UsageStatus {
    if (!Number.isInteger(amountKrw) || amountKrw <= 0) {
      throw new UserFacingError('구매 금액이 올바르지 않습니다.');
    }
    this.store.addCreditKrw({
      id: randomUUID(),
      subjectId: this.usageSubject(),
      amountKrw,
      createdAt: new Date().toISOString(),
    });
    const status = this.usageStatus();
    this.options.send(IPC_EVENTS.usageChanged, status);
    return status;
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
      await this.restartSidecarSelfHealing(runtime);
      if (!this.isCurrentRootGeneration(root, generation)) return;
      const sidecarState = this.supervisor.getState();
      if (!['ready', 'external'].includes(sidecarState.status)) {
        throw new UserFacingError(
          sidecarState.error ?? '검색 엔진을 준비하지 못했습니다. 실행 로그를 확인해 주세요.',
        );
      }
      /*
       * 사용자가 직접 `지금 빌드` 를 눌렀으면 **위키를 실제로 다시 만든다.**
       *
       * 사이드카는 활성 빌드가 있으면 재시작해도 그걸 그대로 채택한다. 그래서 예전에는
       * 버튼을 눌러도 문서만 다시 변환되고 위키는 그대로였다 — 배경에서 만든 요약 13개가
       * 캐시에만 쌓이고 활성 빌드는 4개인 채 남았던 이유다. 버튼을 눌렀는데 아무것도
       * 바뀌지 않는 것이 가장 나쁘다.
       *
       * 자동 동기화(파일 변경·부팅)에서는 부르지 않는다. 그쪽은 승인된 편집 경로가 이미
       * 처리하고, 매번 전체 재빌드를 돌리면 비싸다.
       */
      if (this.knowledgeRebuildRequested) {
        this.knowledgeRebuildRequested = false;
        this.emitKnowledgeBuildState({
          status: 'assembling',
          progress: 92,
          phase: { name: 'assemble', done: 0, total: 1 },
          message: '위키를 다시 만드는 중',
        });
        await this.sidecar.rebuildKnowledge();
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

  /**
   * 수동 빌드 — 트리 하단의 `지금 빌드` 버튼이 부른다.
   *
   * 예전에는 로컬 BuildService(kordoc → enrich → assemble)를 불렀다. 그런데 그 경로는
   * kordoc 실물이 없으면 **모든 문서가 변환에 실패**하고, 누를 때마다 "변환에 성공한
   * 문서가 하나도 없습니다"만 띄웠다. 정작 답변에 쓰이는 위키는 sidecar 파이프라인
   * (doc2md → LLMWIKI)이 만들고 있었으므로, 버튼은 **실제로 도는 쪽**을 눌러야 한다.
   *
   * 폴더가 없으면 조용히 아무 일도 안 하지 않고 이유를 말한다 — 버튼을 눌렀는데
   * 아무 반응이 없으면 고장으로 보인다.
   */
  /**
   * sidecar 를 띄우되, **위키가 지금 폴더와 어긋나 못 뜨는 경우엔 스스로 고친다.**
   *
   * 활성 빌드가 참조하는 원본이 사라지면(폴더를 바꾸거나 파일을 지우면) sidecar 는 기동
   * 자체를 거부한다. 그러면 앱은 못 뜬 채로 남고, 되살릴 방법이 화면에 없다. 실제로
   * 등록 폴더를 바꿨더니 "source document is missing" 으로 죽어 손쓸 수 없는 상태가 됐다.
   *
   * 위키 빌드는 **원본에서 다시 만들 수 있는 파생물**이다. 어긋났으면 붙들고 있을 이유가
   * 없으므로 지우고 다시 만든다. 정규화 입력(source-md)은 지우지 않는다 — 그건 doc2md 로
   * 오래 걸려 만든 것이고, 사라진 문서는 다음 입력 동기화가 알아서 걷어낸다.
   *
   * 다른 이유로 실패한 것이면 **건드리지 않는다.** 원인을 모르면서 데이터를 지우지 않는다.
   */
  private async restartSidecarSelfHealing(runtime: SidecarRuntimePaths): Promise<void> {
    this.supervisor.clearRecentStderr();
    try {
      await this.supervisor.restart();
      if (['ready', 'external'].includes(this.supervisor.getState().status)) return;
    } catch (err) {
      if (!this.supervisor.failedOnStaleWiki) throw err;
    }
    if (!this.supervisor.failedOnStaleWiki) return;

    logError(
      'sidecar:stale-wiki',
      new Error('위키가 등록 폴더와 어긋나 기동하지 못했습니다. 위키를 다시 만듭니다.'),
    );
    this.emitKnowledgeBuildState({
      status: 'assembling',
      progress: 60,
      phase: { name: 'assemble', done: 0, total: 1 },
      message: '문서 목록이 바뀌어 위키를 다시 만드는 중',
    });
    await fs.rm(runtime.llmwikiStorageRoot, { recursive: true, force: true });
    await ensureDir(runtime.llmwikiStorageRoot);
    this.supervisor.clearRecentStderr();
    await this.supervisor.restart();
  }

  /** 저장 대화상자의 기본 위치로 쓸 첫 등록 폴더. 없으면 null. */
  primaryRootPath(): string | null {
    return this.store.listRoots()[0]?.path ?? null;
  }

  requestManualBuild(): void {
    if (this.store.listRoots().length === 0) {
      throw new UserFacingError('등록된 폴더가 없습니다. 폴더를 먼저 추가해 주세요.');
    }
    // 수동 빌드는 위키를 실제로 다시 만든다 — watchdog 가 놓친 변경을 되찾는 탈출구다.
    this.knowledgeRebuildRequested = true;
    this.requestKnowledgeSync('문서를 다시 확인하는 중');
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

/**
 * USD → 원 환산율.
 *
 * 고정값이 아니라 설정으로 뺀 이유는, 이 숫자가 **사용자에게 청구되는 금액**으로 보이기
 * 때문이다. 환율이 크게 움직였는데 코드를 고쳐야만 반영되면 표시가 사실과 어긋난다.
 */
function usdToKrwRate(): number {
  const configured = Number(process.env.CODEGATE_USD_KRW_RATE);
  return Number.isFinite(configured) && configured > 0 ? configured : 1_400;
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
