import { createHash } from 'node:crypto';
import path from 'node:path';
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
import { sourceUriToRelativePath } from '@main/util/vpath';
import { createHwpxFile, validatedHwpxBasename } from '@main/kordoc/create';
import { uniquePath } from '@main/kordoc/generate';

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
  /*
   * 오류 문구가 `assistant_text` 와 **같은 경우가 흔하다.** sidecar 가 사용자에게 할 말을
   * 두 필드에 같이 담아 보내기 때문인데, 그대로 이어 붙이면 화면에 같은 문장이 두 번 뜬다
   * ("수정할 문서와 변경 전후 텍스트를 명확히 적어주세요." 가 두 번 나오던 원인).
   * 이미 말한 내용이면 다시 말하지 않는다.
   */
  if (response.error && !response.assistant_text.includes(response.error.message)) {
    yield { type: 'text_delta', text: `\n\n${response.error.message}` };
  }

  if (response.response_type === 'document_creation_preview' && response.generated_document) {
    if (!deps.auth.canWrite()) {
      yield { type: 'auth_error', kind: 'not_provisioned' };
      yield { type: 'done', citations };
      return;
    }
    const root = deps.config.roots[0];
    if (!root) throw new Error('새 문서를 저장할 등록 폴더가 없습니다.');
    const requested = validatedHwpxBasename(response.generated_document.filename);
    const extension = path.extname(requested);
    const target = await uniquePath(root, requested.slice(0, -extension.length), '.hwpx');
    const diff = createDocumentDiff(path.basename(target), response.generated_document.markdown);
    yield { type: 'approval_request', diff, target: path.basename(target) };
    const approved = await deps.approvalHandler({
      tool: 'create_document',
      target,
      diff,
      rationale: `근거 문서: ${response.generated_document.source_document_ids.join(', ')}`,
    });
    if (!approved) {
      yield { type: 'text_delta', text: '\n\n문서 생성을 취소했습니다. 새 파일은 만들어지지 않았습니다.' };
      yield { type: 'done', citations };
      return;
    }
    yield { type: 'tool_start', name: 'create_document', summary: '승인된 HWPX 생성 및 재검증' };
    await createHwpxFile({
      targetPath: target,
      markdown: response.generated_document.markdown,
    });
    yield {
      type: 'text_delta',
      text: `\n\n${path.basename(target)} 파일을 만들었습니다. 문서 감시기가 새 위키 버전에 반영합니다.`,
    };
    yield { type: 'done', citations };
    return;
  }

  const plans = response.change_plans?.length
    ? response.change_plans
    : response.change_plan
      ? [response.change_plan]
      : [];
  if (response.response_type === 'change_preview' && plans.length > 0) {
    if (!deps.auth.canWrite()) {
      yield { type: 'auth_error', kind: 'not_provisioned' };
      yield { type: 'done', citations };
      return;
    }
    let lastCompleted: ExecutionResponse | undefined;
    const completedExecutions: ExecutionSummary[] = [];
    for (const plan of plans) {
      yield {
        type: 'approval_request',
        diff: plan.unified_diff,
        target: plan.source_uri.replace(/^source:\/\//, ''),
      };
      const approved = await deps.approvalHandler(approvalRequest(plan));
      if (!approved) {
        await client.reject(plan);
        const target = plan.source_uri.replace(/^source:\/\//, '');
        yield {
          type: 'text_delta',
          text:
            plan.operation.type === 'delete_file'
              ? `\n\n${target} 삭제를 거부했습니다. 원본은 유지됩니다.`
              : '\n\n변경을 거부했습니다. 원본은 수정되지 않았습니다.',
        };
        continue;
      }

      const deletingFile = plan.operation.type === 'delete_file';
      yield {
        type: 'tool_start',
        name: deletingFile ? 'delete_file' : 'approve_change',
        summary: deletingFile
          ? '승인된 파일 삭제 및 위키 동기화'
          : '승인된 변경 적용 및 위키 동기화',
      };
      const plannedExecution = plannedExecutionSummary(plan);
      yield { type: 'execution_update', execution: plannedExecution };
      let execution: ExecutionResponse;
      try {
        execution = await client.approve(plan, signal);
      } catch (error) {
        if (!signal?.aborted) throw error;
        execution = await client.approve(plan);
      }
      yield { type: 'execution_update', execution: executionSummary(execution) };
      lastCompleted = await client.waitForExecution(execution, signal);
      const completedSummary = executionSummary(lastCompleted);
      completedExecutions.push(completedSummary);
      yield { type: 'execution_update', execution: completedSummary };
      yield { type: 'text_delta', text: `\n\n${executionMessage(lastCompleted, plan)}` };
    }
    yield {
      type: 'done',
      citations,
      execution: lastCompleted ? executionSummary(lastCompleted) : undefined,
      executions: completedExecutions,
    };
    return;
  }

  yield { type: 'done', citations };
}

export function approvalRequest(plan: ChangePlanResponse) {
  return {
    tool: plan.operation.type === 'delete_file' ? 'delete_file' : 'approve_change_plan',
    target: sourceUriToRelativePath(plan.source_uri) ?? plan.source_uri,
    diff: plan.unified_diff,
    rationale: `검증할 plan_hash: ${plan.plan_hash}`,
    changePlanId: plan.change_plan_id,
    planHash: plan.plan_hash,
  };
}

export function createDocumentDiff(filename: string, markdown: string): string {
  return [
    '--- /dev/null',
    `+++ ${filename}`,
    '@@ new HWPX document @@',
    ...markdown.split('\n').map((line) => `+${line}`),
    '',
  ].join('\n');
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
      sourcePath: sourceUriToRelativePath(document.source_uri) ?? document.source_uri,
    })),
  );
}

export function executionMessage(
  execution: ExecutionResponse,
  plan: ChangePlanResponse,
): string {
  if (execution.status === 'completed') {
    return plan.operation.type === 'delete_file'
      ? '파일을 삭제하고 해당 문서를 제외한 새 위키 버전까지 게시했습니다. Undo로 복원할 수 있습니다.'
      : '변경을 적용하고 새 위키 버전까지 게시했습니다.';
  }
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

function plannedExecutionSummary(plan: ChangePlanResponse): ExecutionSummary {
  return {
    executionId: `exec_${createHash('sha256').update(plan.change_plan_id).digest('hex').slice(0, 32)}`,
    documentId: plan.document_id,
    status: 'prepared',
    stage: 'file_write',
    terminal: false,
    canRetry: false,
    canUndo: false,
  };
}
