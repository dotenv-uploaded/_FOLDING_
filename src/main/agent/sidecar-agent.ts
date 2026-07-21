import {
  type Agent,
  type AgentDeps,
  type AgentEvent,
  type Citation,
  type ExecutionSummary,
} from '@contracts';
import {
  SidecarClient,
  type ChangePlanResponse,
  type ChatResponse,
  type ExecutionResponse,
} from '@main/sidecar/client';

export function createSidecarAgent(deps: AgentDeps): Agent {
  const client = new SidecarClient(deps.config.backendUrl);
  return {
    send(userText, options): AsyncIterable<AgentEvent> {
      return run(client, deps, userText, options.conversationId, options.signal);
    },
  };
}

async function* run(
  client: SidecarClient,
  deps: AgentDeps,
  userText: string,
  conversationId: string,
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  yield { type: 'tool_start', name: 'sidecar_chat', summary: '로컬 위키에서 근거 검색' };
  const response = await client.chat(conversationId, userText, signal);
  const citations = citationsFrom(response);

  if (response.assistant_text) {
    yield { type: 'text_delta', text: response.assistant_text };
  }
  if (response.error) {
    yield { type: 'text_delta', text: `\n\n${response.error.message}` };
  }

  const plan = response.change_plan;
  if (response.response_type === 'change_preview' && plan) {
    if (!deps.auth.canWrite()) {
      yield { type: 'auth_error', kind: 'not_provisioned' };
      yield { type: 'done', citations };
      return;
    }
    yield {
      type: 'approval_request',
      diff: plan.unified_diff,
      target: plan.source_uri.replace(/^source:\/\//, ''),
    };
    const approved = await deps.approvalHandler(approvalRequest(plan));
    if (!approved) {
      await client.reject(plan);
      yield { type: 'text_delta', text: '\n\n변경을 거부했습니다. 원본은 수정되지 않았습니다.' };
      yield { type: 'done', citations };
      return;
    }

    yield { type: 'tool_start', name: 'approve_change', summary: '승인된 변경 적용 및 위키 동기화' };
    const execution = await client.approve(plan, signal);
    const completed = await client.waitForExecution(execution, signal);
    yield { type: 'text_delta', text: `\n\n${executionMessage(completed)}` };
    yield { type: 'done', citations, execution: executionSummary(completed) };
    return;
  }

  yield { type: 'done', citations };
}

function approvalRequest(plan: ChangePlanResponse) {
  return {
    tool: 'approve_change_plan',
    target: plan.source_uri.replace(/^source:\/\//, ''),
    diff: plan.unified_diff,
    rationale: `검증할 plan_hash: ${plan.plan_hash}`,
    changePlanId: plan.change_plan_id,
    planHash: plan.plan_hash,
  };
}

function citationsFrom(response: ChatResponse): Citation[] {
  return response.documents.flatMap((document) =>
    document.evidence.map((evidence) => ({
      docId: document.document_id,
      rev: document.revision,
      section: evidence.section,
      sectionId: evidence.section_id,
      chunkId: evidence.chunk_id,
      graphVersion: document.graph_version,
      sourcePath: document.source_uri.replace(/^source:\/\//, ''),
    })),
  );
}

function executionMessage(execution: ExecutionResponse): string {
  if (execution.status === 'completed') return '변경을 적용하고 새 위키 버전까지 게시했습니다.';
  if (execution.status === 'undone') return '변경을 되돌렸습니다.';
  if (execution.error) return `변경 처리에 실패했습니다: ${execution.error.message}`;
  return `변경 처리가 ${execution.stage} 단계에서 종료되었습니다.`;
}

export function executionSummary(execution: ExecutionResponse): ExecutionSummary {
  return {
    executionId: execution.execution_id,
    documentId: execution.document_id,
    status: execution.status,
    stage: execution.stage,
    terminal: execution.terminal,
    error: execution.error ?? undefined,
    canRetry: execution.stage === 'sync_retryable',
    canUndo: execution.status === 'completed',
  };
}
