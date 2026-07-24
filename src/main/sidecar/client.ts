import { randomUUID } from 'node:crypto';
import type { ToolRisk } from '@contracts';
import { httpJson, httpRequest, joinUrl } from '@main/net/http';

/** 열린 에이전트 스트림이 흘려보내는 이벤트 (사이드카 `agent/stream` 의 SSE 페이로드). */
export type SidecarAgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; tool: string; summary: string }
  | {
      type: 'approval';
      approval_id: string;
      tool: string;
      risk: ToolRisk;
      reason: string | null;
      summary: string;
      /** 사용자가 원래 시킨 일 — 도구와 어긋나는지 사람이 판단할 재료 */
      user_request?: string;
    }
  | { type: 'done'; cost_usd: number | null }
  | { type: 'error'; code: string; message: string };

export interface EvidenceResponse {
  chunk_id: string;
  section_id: string;
  section: string;
  heading_path: string[];
  quote: string;
}

export interface DocumentResponse {
  document_id: string;
  revision: string;
  display_path: string;
  source_uri: string;
  graph_version: string;
  evidence: EvidenceResponse[];
  can_write: boolean;
}

export interface ChangePlanResponse {
  change_plan_id: string;
  document_id: string;
  source_uri: string;
  unified_diff: string;
  plan_hash: string;
}

export interface ChatResponse {
  conversation_id: string;
  message_id: string;
  response_type: 'location_result' | 'target_selection' | 'change_preview' | 'error';
  assistant_text: string;
  documents: DocumentResponse[];
  change_plan: ChangePlanResponse | null;
  /** 이번 호출이 실제로 쓴 비용. 구독 사용량을 세는 근거다. */
  usage?: { cost_usd: number | null } | null;
  error: { code: string; message: string; retryable: boolean } | null;
}

export interface ExecutionResponse {
  execution_id: string;
  document_id: string;
  status: string;
  sync_status: string;
  terminal: boolean;
  stage: string;
  recommended_poll_after_ms: number | null;
  error: { code: string; message: string; retryable: boolean } | null;
}

export interface HealthResponse {
  status: string;
  knowledge_version: string;
  worker_available: boolean;
  agent_available: boolean;
  persistence_available: boolean;
}

export class SidecarClient {
  constructor(private readonly baseUrl: string) {}

  health(signal?: AbortSignal): Promise<HealthResponse> {
    return httpJson(joinUrl(this.baseUrl, 'health'), {
      signal,
      failureMessage: '로컬 Folding 서비스 상태를 확인하지 못했습니다.',
    });
  }

  /**
   * 현재 입력·요약으로 위키를 **다시 만들어 활성화**한다.
   *
   * 자동 경로는 승인된 문서 편집만 반영하므로, 문서 편집이 아닌 변화(새로 만든 요약,
   * watchdog 가 놓친 파일 수정)는 이 호출로만 위키에 닿는다.
   *
   * 요약을 처음 만들 때는 문서당 몇 초씩 걸린다 — 타임아웃을 넉넉히 둔다.
   */
  rebuildKnowledge(signal?: AbortSignal): Promise<{ knowledge_version: string }> {
    return httpJson(joinUrl(this.baseUrl, 'knowledge/rebuild'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      failureMessage: '위키를 다시 만들지 못했습니다.',
    });
  }

  chat(conversationId: string, message: string, signal?: AbortSignal): Promise<ChatResponse> {
    return httpJson(joinUrl(this.baseUrl, 'chat/messages'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({ conversation_id: conversationId, message }),
      signal,
      failureMessage: '로컬 문서 에이전트가 답변하지 못했습니다.',
    });
  }

  /**
   * 열린 에이전트를 **스트리밍**으로 돌린다 (SSE).
   *
   * 단발 `chat` 과 달리 도구를 여러 번 쓰고 그때마다 승인을 받으므로, 실행 중간에
   * 이벤트가 흘러나와야 한다. 승인 요청도 이 스트림으로 나오고, 사용자의 답은
   * `resolveApproval` 로 **따로** 돌아간다 — 한 요청으로 왕복할 수 없다.
   */
  async *streamAgent(
    conversationId: string,
    message: string,
    signal?: AbortSignal,
  ): AsyncGenerator<SidecarAgentEvent> {
    const response = await httpRequest(joinUrl(this.baseUrl, 'agent/stream'), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      json: { conversation_id: conversationId, message },
      signal,
      failureMessage: '에이전트를 실행하지 못했습니다.',
    });
    if (!response.body) {
      throw new Error('에이전트 스트림이 비어 있습니다.');
    }
    yield* parseSseEvents(response.body, signal);
  }

  /** 사용자의 승인/거부를 사이드카의 대기소로 전달한다. */
  async resolveApproval(
    approvalId: string,
    approved: boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const result = await httpJson<{ delivered: boolean }>(
      joinUrl(this.baseUrl, `agent/approvals/${approvalId}`),
      {
        method: 'POST',
        json: { approved },
        signal,
        failureMessage: '승인 결과를 전달하지 못했습니다.',
      },
    );
    return result.delivered;
  }

  approve(plan: ChangePlanResponse, signal?: AbortSignal): Promise<ExecutionResponse> {
    return httpJson(joinUrl(this.baseUrl, `change-plans/${plan.change_plan_id}/approve`), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({ plan_hash: plan.plan_hash }),
      signal,
      failureMessage: '문서 변경을 승인하지 못했습니다.',
    });
  }

  reject(plan: ChangePlanResponse, signal?: AbortSignal): Promise<void> {
    return httpJson(joinUrl(this.baseUrl, `change-plans/${plan.change_plan_id}/reject`), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({ plan_hash: plan.plan_hash, reason: '사용자가 승인 화면에서 거부함' }),
      signal,
      failureMessage: '문서 변경 거부를 기록하지 못했습니다.',
    }).then(() => undefined);
  }

  execution(executionId: string, signal?: AbortSignal): Promise<ExecutionResponse> {
    return httpJson(joinUrl(this.baseUrl, `executions/${executionId}`), {
      signal,
      failureMessage: '문서 변경 상태를 확인하지 못했습니다.',
    });
  }

  retry(executionId: string, signal?: AbortSignal): Promise<ExecutionResponse> {
    return httpJson(joinUrl(this.baseUrl, `executions/${executionId}/retry-sync`), {
      method: 'POST',
      signal,
      failureMessage: '문서 동기화를 다시 시작하지 못했습니다.',
    });
  }

  undo(executionId: string, signal?: AbortSignal): Promise<ExecutionResponse> {
    return httpJson(joinUrl(this.baseUrl, `executions/${executionId}/undo`), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      signal,
      failureMessage: '문서 변경을 되돌리지 못했습니다.',
    });
  }

  async waitForExecution(
    initial: ExecutionResponse,
    signal?: AbortSignal,
  ): Promise<ExecutionResponse> {
    let current = initial;
    const deadline = Date.now() + 5 * 60 * 1000;
    while (!current.terminal) {
      if (Date.now() >= deadline) throw new Error('문서 동기화 상태 확인 시간이 초과되었습니다.');
      await delay(
        Math.min(Math.max(current.recommended_poll_after_ms ?? 500, 100), 5_000),
        signal,
      );
      current = await this.execution(current.execution_id, signal);
    }
    return current;
  }
}

/**
 * SSE 바이트 스트림을 이벤트로 푼다.
 *
 * 한 이벤트는 `data: {json}` 다음 **빈 줄**로 끝난다. 청크는 이벤트 경계와 무관하게
 * 잘려 오므로(한 이벤트가 두 청크에 걸치거나, 한 청크에 여러 이벤트가 들어온다) 버퍼에
 * 모아 두고 빈 줄이 나올 때마다 하나씩 꺼낸다. 경계를 무시하고 청크마다 파싱하면
 * 긴 이벤트에서 JSON 이 깨진다.
 */
export async function* parseSseEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SidecarAgentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseBlock(block);
        if (event) yield event;
        boundary = buffer.indexOf('\n\n');
      }
    }
    // 스트림이 끝날 때 마지막 이벤트가 빈 줄 없이 남아 있을 수 있다.
    const tail = parseSseBlock(buffer);
    if (tail) yield tail;
  } finally {
    // 소비 측이 중간에 멈춰도(승인 거부 후 이탈 등) 소켓을 놓아 준다.
    await reader.cancel().catch(() => undefined);
  }
}

function parseSseBlock(block: string): SidecarAgentEvent | null {
  const line = block
    .split('\n')
    .find((candidate) => candidate.startsWith('data:'));
  if (!line) return null;
  const payload = line.slice('data:'.length).trim();
  if (!payload) return null;
  try {
    return JSON.parse(payload) as SidecarAgentEvent;
  } catch {
    // 깨진 한 줄 때문에 대화 전체를 죽이지 않는다. 다음 이벤트로 넘어간다.
    return null;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
