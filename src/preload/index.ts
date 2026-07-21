import { contextBridge, ipcRenderer } from 'electron';
import { IPC, IPC_EVENTS } from '@contracts';
import type {
  AgentEventEnvelope,
  ApprovalEnvelope,
  BuildState,
  ChatMessage,
  Conversation,
  ExecutionSummary,
  FileNode,
  LlmKeyInput,
  LlmKeyStatus,
  LlmProvider,
  LoginRequest,
  Root,
  ScanPreview,
  Session,
} from '@contracts';

/** `on*` 구독자는 해제 함수를 돌려준다 — 렌더러의 useEffect cleanup 에서 호출. */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: Electron.IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = {
  auth: {
    login: (req: LoginRequest): Promise<Session> => ipcRenderer.invoke(IPC.authLogin, req),
    logout: (): Promise<void> => ipcRenderer.invoke(IPC.authLogout),
    session: (): Promise<Session> => ipcRenderer.invoke(IPC.authSession),
    onChanged: (cb: (s: Session) => void) => subscribe<Session>(IPC_EVENTS.sessionChanged, cb),
  },

  roots: {
    list: (): Promise<Root[]> => ipcRenderer.invoke(IPC.rootsList),
    /** 네이티브 폴더 선택 다이얼로그. 취소하면 null. */
    pickDialog: (): Promise<string | null> => ipcRenderer.invoke(IPC.rootsPickDialog),
    /** 등록 전 포함/제외 미리보기 (스펙 v1.3 §3 온보딩) */
    scanPreview: (path: string): Promise<ScanPreview> =>
      ipcRenderer.invoke(IPC.rootsScanPreview, path),
    add: (path: string): Promise<Root> => ipcRenderer.invoke(IPC.rootsAdd, path),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.rootsRemove, id),
  },

  build: {
    /** 로컬 빌드(변환→enrichment→조립)를 시작한다. 증분이면 변경분만 돈다. */
    trigger: (): Promise<void> => ipcRenderer.invoke(IPC.buildTrigger),
    state: (): Promise<BuildState> => ipcRenderer.invoke(IPC.buildState),
    /** 진행 중인 빌드 중단 — enrichment LLM 호출 비용을 멈추려면 필요하다. */
    cancel: (): Promise<void> => ipcRenderer.invoke(IPC.buildCancel),
    onChanged: (cb: (s: BuildState) => void) => subscribe<BuildState>(IPC_EVENTS.buildState, cb),
  },

  /** L4 — enrichment LLM 키 (자격증명 ②). 원문 키는 오직 메인 프로세스만 안다. */
  llmKey: {
    status: (): Promise<LlmKeyStatus[]> => ipcRenderer.invoke(IPC.llmKeyStatus),
    set: (input: LlmKeyInput): Promise<LlmKeyStatus[]> => ipcRenderer.invoke(IPC.llmKeySet, input),
    clear: (provider: LlmProvider): Promise<LlmKeyStatus[]> =>
      ipcRenderer.invoke(IPC.llmKeyClear, provider),
  },

  tree: {
    get: (): Promise<FileNode[]> => ipcRenderer.invoke(IPC.treeGet),
    onChanged: (cb: (t: FileNode[]) => void) => subscribe<FileNode[]>(IPC_EVENTS.treeChanged, cb),
  },

  chat: {
    list: (): Promise<Conversation[]> => ipcRenderer.invoke(IPC.chatList),
    create: (): Promise<Conversation> => ipcRenderer.invoke(IPC.chatCreate),
    messages: (conversationId: string): Promise<ChatMessage[]> =>
      ipcRenderer.invoke(IPC.chatMessages, conversationId),
    /** 전송만 하고 즉시 반환한다. 응답은 onAgentEvent 로 스트리밍된다. */
    send: (conversationId: string, text: string): Promise<{ messageId: string }> =>
      ipcRenderer.invoke(IPC.chatSend, conversationId, text),
    abort: (conversationId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.chatAbort, conversationId),
    onAgentEvent: (cb: (e: AgentEventEnvelope) => void) =>
      subscribe<AgentEventEnvelope>(IPC_EVENTS.agentEvent, cb),
  },

  execution: {
    retry: (messageId: string, executionId: string): Promise<ExecutionSummary> =>
      ipcRenderer.invoke(IPC.executionRetry, messageId, executionId),
    undo: (messageId: string, executionId: string): Promise<ExecutionSummary> =>
      ipcRenderer.invoke(IPC.executionUndo, messageId, executionId),
  },

  approval: {
    /** 승인 diff 모달을 띄워야 할 때 호출된다. */
    onRequest: (cb: (e: ApprovalEnvelope) => void) =>
      subscribe<ApprovalEnvelope>(IPC_EVENTS.approvalRequest, cb),
    respond: (id: string, approved: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.approvalRespond, id, approved),
  },

  shell: {
    /** 인용 클릭 → OS 기본 앱으로 원본 문서 열기 */
    openOriginal: (relPath: string): Promise<void> =>
      ipcRenderer.invoke(IPC.openOriginal, relPath),
  },
};

export type CodegateApi = typeof api;

contextBridge.exposeInMainWorld('codegate', api);
