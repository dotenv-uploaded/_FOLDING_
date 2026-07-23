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
  UsageStatus,
  WikiGraph,
} from '@contracts';

export interface CodegateApi {
  auth: {
    login(request: LoginRequest): Promise<Session>;
    logout(): Promise<void>;
    session(): Promise<Session>;
    onChanged(callback: (session: Session) => void): () => void;
  };
  roots: {
    list(): Promise<Root[]>;
    pickDialog(): Promise<string | null>;
    /** 여러 폴더를 한 번에 선택. 취소하면 빈 배열. (초기 설정용) */
    pickDialogMulti(): Promise<string[]>;
    scanPreview(path: string): Promise<ScanPreview>;
    add(path: string): Promise<Root>;
    remove(id: string): Promise<void>;
  };
  build: {
    trigger(): Promise<void>;
    state(): Promise<BuildState>;
    cancel(): Promise<void>;
    onChanged(callback: (state: BuildState) => void): () => void;
  };
  llmKey: {
    status(): Promise<LlmKeyStatus[]>;
    set(input: LlmKeyInput): Promise<LlmKeyStatus[]>;
    clear(provider: LlmProvider): Promise<LlmKeyStatus[]>;
  };
  tree: {
    get(): Promise<FileNode[]>;
    onChanged(callback: (tree: FileNode[]) => void): () => void;
  };
  usage: {
    /** 지금까지 쓴 금액·한도·남은 금액 */
    status(): Promise<UsageStatus>;
    /** 크레딧 추가. **결제는 아직 붙지 않았다** — 화면과 한도 해제 흐름만 잇는다. */
    purchase(amountKrw: number): Promise<UsageStatus>;
    onChanged(callback: (status: UsageStatus) => void): () => void;
  };
  chat: {
    list(): Promise<Conversation[]>;
    create(): Promise<Conversation>;
    messages(conversationId: string): Promise<ChatMessage[]>;
    send(conversationId: string, text: string): Promise<{ messageId: string }>;
    abort(conversationId: string): Promise<void>;
    /** 대화와 그 안의 메시지를 지운다. 되돌릴 수 없다. */
    remove(conversationId: string): Promise<void>;
    onAgentEvent(callback: (event: AgentEventEnvelope) => void): () => void;
  };
  execution: {
    retry(messageId: string, executionId: string): Promise<ExecutionSummary>;
    undo(messageId: string, executionId: string): Promise<ExecutionSummary>;
  };
  approval: {
    onRequest(callback: (request: ApprovalEnvelope) => void): () => void;
    respond(id: string, approved: boolean): Promise<void>;
  };
  wiki: {
    /** 활성 빌드의 지식 그래프 (그래프 탭) */
    graph(): Promise<WikiGraph>;
  };
  document: {
    /** 답변을 한글 문서(HWPX)로 저장. 취소하면 null, 저장하면 그 경로. */
    saveHwpx(markdown: string): Promise<string | null>;
    /** 한글 양식을 복사해 채운 사본을 만든다. 원본 양식은 건드리지 않는다. */
    fillTemplate(markdown: string): Promise<string | null>;
  };
  shell: {
    openOriginal(relativePath: string): Promise<void>;
    /** 파일 탐색기에서 선택된 채로 보여주기 — 옆의 `.bak` 백업을 찾을 때 쓴다 */
    revealOriginal(relativePath: string): Promise<void>;
  };
}
