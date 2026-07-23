import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentDeps, ApprovalRequest } from '@contracts';
import { createSidecarAgent } from '@main/agent/sidecar-agent';

afterEach(() => vi.unstubAllGlobals());

describe('sidecar real document creation', () => {
  it('turns a grounded preview into an approved, real HWPX file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codegate-sidecar-create-'));
    const markdown = '# 주간업무보고서\n\n- 실제 HWPX 생성';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            conversation_id: 'conversation-create',
            message_id: 'message-create',
            response_type: 'document_creation_preview',
            assistant_text: '근거를 바탕으로 생성 미리보기를 준비했습니다.',
            documents: [],
            change_plan: null,
            change_plans: [],
            generated_document: {
              filename: '주간업무보고서.hwpx',
              markdown,
              source_document_ids: ['REPORT-000001'],
            },
            error: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const approvals: ApprovalRequest[] = [];
    const deps: AgentDeps = {
      config: { roots: [root], backendUrl: 'http://sidecar.test/api/v1', wikiDir: root },
      auth: { getToken: async () => 'unused-by-local-sidecar', canWrite: () => true },
      approvalHandler: async (request) => {
        approvals.push(request);
        return true;
      },
      kordoc: {
        parse: async () => '',
        patch: async () => ({
          ok: true,
          exitCode: 0,
          applied: 0,
          unapplied: [],
          backupPath: '',
        }),
        generate: async () => undefined,
        render: async () => [],
      },
    };

    const events = [];
    for await (const event of createSidecarAgent(deps).send(
      '이번주 보고서를 보고 주간업무보고서.hwpx를 만들어줘',
      { conversationId: 'conversation-create' },
    )) {
      events.push(event);
    }

    const target = path.join(root, '주간업무보고서.hwpx');
    const bytes = await fs.readFile(target);
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ tool: 'create_document', target });
    expect(approvals[0]?.diff).toContain('+# 주간업무보고서');
    expect(events).toContainEqual({
      type: 'tool_start',
      name: 'create_document',
      summary: '승인된 HWPX 생성 및 재검증',
    });
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  }, 300_000);
});
