import { describe, expect, it } from 'vitest';
import { approvalRequest, createDocumentDiff, executionMessage } from '@main/agent/sidecar-agent';
import type { ChangePlanResponse, ExecutionResponse } from '@main/sidecar/client';

const deletePlan: ChangePlanResponse = {
  change_plan_id: 'plan-delete',
  document_id: 'REG-000001',
  source_uri: 'source://regulations/REG-000001.md',
  unified_diff: '--- source\n+++ /dev/null',
  plan_hash: 'a'.repeat(64),
  operation: { type: 'delete_file' },
};

describe('sidecar file deletion approval', () => {
  it('labels deletion distinctly and keeps the exact plan hash', () => {
    expect(approvalRequest(deletePlan)).toMatchObject({
      tool: 'delete_file',
      target: 'regulations/REG-000001.md',
      planHash: 'a'.repeat(64),
      changePlanId: 'plan-delete',
    });
  });

  it('reports published deletion as recoverable with Undo', () => {
    const execution: ExecutionResponse = {
      execution_id: 'execution-delete',
      document_id: 'REG-000001',
      status: 'completed',
      sync_status: 'published',
      terminal: true,
      stage: 'published',
      recommended_poll_after_ms: null,
      error: null,
    };

    expect(executionMessage(execution, deletePlan)).toContain('Undo로 복원');
  });
});

describe('sidecar document creation approval', () => {
  it('shows the complete generated Markdown as a new-file diff', () => {
    const diff = createDocumentDiff('주간업무보고서.hwpx', '# 주간업무보고서\n\n- 완료 업무');

    expect(diff).toContain('--- /dev/null');
    expect(diff).toContain('+++ 주간업무보고서.hwpx');
    expect(diff).toContain('+# 주간업무보고서');
    expect(diff).toContain('+- 완료 업무');
  });
});
