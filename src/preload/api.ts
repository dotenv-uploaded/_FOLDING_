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
  chat: {
    list(): Promise<Conversation[]>;
    create(): Promise<Conversation>;
    messages(conversationId: string): Promise<ChatMessage[]>;
    send(conversationId: string, text: string): Promise<{ messageId: string }>;
    abort(conversationId: string): Promise<void>;
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
  shell: {
    openOriginal(relativePath: string): Promise<void>;
  };
}
