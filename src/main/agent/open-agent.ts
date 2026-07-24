/**
 * 열린 에이전트 — 도구를 가리지 않고, 매번 승인을 받는다.
 *
 * 기존 `sidecar-agent` 는 "문서 편집 한 건"을 왕복하는 단발 호출이다. 이쪽은 다르다:
 * 에이전트가 Bash·Write·WebFetch 를 몇 번이든 쓸 수 있고, **쓰기 직전마다** 멈춰서
 * 사용자에게 묻는다. 그래서 실행 중간에 이벤트가 흘러나오는 스트림(SSE)으로 돌린다.
 *
 * 승인 왕복이 두 경로로 갈라지는 점이 핵심이다:
 *   - 승인 **요청**은 스트림으로 나온다 (`approval` 이벤트)
 *   - 사용자의 **답**은 별도 HTTP 요청으로 돌아간다 (`resolveApproval`)
 * 스트림은 답을 기다리는 동안 열려 있어야 하므로 한 요청으로 왕복할 수 없다.
 *
 * 승인 UI 는 새로 만들지 않고 기존 `deps.approvalHandler`(승인 모달)를 그대로 쓴다.
 */
import type { Agent, AgentDeps, AgentEvent } from '@contracts';
import { SidecarClient, type SidecarAgentEvent } from '@main/sidecar/client';
import { logError } from '@main/util/errors';

export function createOpenAgent(
  deps: AgentDeps,
  /** 이번 호출의 비용(USD). 구독 사용량을 세는 쪽이 받아 간다. */
  onUsage?: (costUsd: number | null) => void,
): Agent {
  const client = new SidecarClient(deps.config.backendUrl);
  return {
    send(userText, options): AsyncIterable<AgentEvent> {
      return run(client, deps, userText, options.conversationId, options.signal, onUsage);
    },
  };
}

async function* run(
  client: SidecarClient,
  deps: AgentDeps,
  userText: string,
  conversationId: string,
  signal?: AbortSignal,
  onUsage?: (costUsd: number | null) => void,
): AsyncGenerator<AgentEvent> {
  /*
   * 승인 결과는 스트림이 열려 있는 채로 **따로** 보낸다. 사이드카가 그 답을 기다리며
   * 멈춰 있으므로, 이걸 보내야 스트림이 다시 흐른다.
   *
   * 전송이 실패하면 조용히 넘기지 않는다. 답이 닿지 않으면 사이드카는 타임아웃까지
   * 매달려 있다가 거부로 처리하는데, 그동안 사용자는 자기가 누른 승인이 왜 아무 일도
   * 하지 않는지 알 길이 없다. 그래서 실패를 대화에 드러낸다.
   */
  const sendDecision = async (approvalId: string, approved: boolean): Promise<string | null> => {
    try {
      const delivered = await client.resolveApproval(approvalId, approved, signal);
      if (!delivered) {
        // 사이드카가 그 승인 건을 모른다 — 이미 타임아웃으로 지웠거나 스트림이 끊긴 것.
        return '\n\n승인 결과를 전달했지만 해당 요청이 이미 만료되었습니다. 다시 요청해 주세요.';
      }
      return null;
    } catch (err) {
      logError('open-agent:resolveApproval', err);
      return '\n\n승인 결과를 전달하지 못했습니다. 요청은 실행되지 않습니다.';
    }
  };

  let reportedUsage = false;
  try {
    for await (const event of client.streamAgent(conversationId, userText, signal)) {
      const mapped = await handle(event, deps, sendDecision);
      for (const out of mapped) yield out;
      if (event.type === 'done') {
        onUsage?.(event.cost_usd);
        reportedUsage = true;
      }
    }
  } finally {
    // 스트림이 중간에 끊겨도(취소·오류) 사용량 집계가 비지 않게 한 번은 알린다.
    if (!reportedUsage) onUsage?.(null);
  }
}

async function handle(
  event: SidecarAgentEvent,
  deps: AgentDeps,
  sendDecision: (approvalId: string, approved: boolean) => Promise<string | null>,
): Promise<AgentEvent[]> {
  switch (event.type) {
    case 'text':
      return [{ type: 'text_delta', text: event.text }];

    case 'tool':
      return [{ type: 'tool_start', name: event.tool, summary: event.summary }];

    case 'approval': {
      /*
       * 쓰기 권한이 없으면 물어볼 것도 없이 거부한다. 여기서 답을 보내지 않으면
       * 사이드카가 타임아웃까지 매달려 있게 된다.
       */
      if (!deps.auth.canWrite()) {
        await sendDecision(event.approval_id, false);
        return [{ type: 'auth_error', kind: 'not_provisioned' }];
      }
      const approved = await deps.approvalHandler({
        tool: event.tool,
        target: event.summary,
        rationale: event.reason ?? undefined,
        risk: event.risk,
        summary: event.summary,
        userRequest: event.user_request,
        timeoutSeconds: event.timeout_seconds,
      });
      const failure = await sendDecision(event.approval_id, approved);
      return failure ? [{ type: 'text_delta', text: failure }] : [];
    }

    case 'done':
      // 근거(citations)는 열린 에이전트가 문서 검색에 한정되지 않아 비어 있다.
      return [{ type: 'done', citations: [] }];

    case 'error':
      return [
        { type: 'text_delta', text: `\n\n${event.message}` },
        { type: 'done', citations: [] },
      ];

    default:
      return [];
  }
}
