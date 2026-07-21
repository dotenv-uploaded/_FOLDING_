import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentDeps } from '@contracts';
import { createOAuthLoopbackReceiver } from '@main/auth/oauth-loopback';
import { createSidecarAgent } from '@main/agent/sidecar-agent';
import { MIGRATIONS } from '@main/db/schema';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
});

describe('sidecar execution persistence', () => {
  it('adds an execution column in the next SQLite migration', () => {
    expect(MIGRATIONS.at(-1)).toContain('ALTER TABLE messages ADD COLUMN execution TEXT');
  });
});

describe('OAuth loopback receiver', () => {
  it('rejects the wrong state and accepts the pending callback once', async () => {
    const receiver = await createOAuthLoopbackReceiver(2_000);
    try {
      const callback = new URL(receiver.redirectTo);
      const wrong = new URL(callback);
      wrong.pathname = '/oauth/callback/attacker';
      wrong.searchParams.set('code', 'stolen-code');
      expect((await fetch(wrong)).status).toBe(404);

      callback.searchParams.set('code', 'valid-code');
      expect((await fetch(callback)).status).toBe(200);
      await expect(receiver.waitForCode()).resolves.toBe('valid-code');
    } finally {
      await receiver.close();
    }
  });
});

describe('Python sidecar agent bridge', () => {
  it('sends no bearer token and approves the exact plan hash', async () => {
    const requests: { path: string; authorization?: string; idempotency?: string; body: unknown }[] = [];
    const server = createServer(async (request, response) => {
      const body = await readJson(request);
      requests.push({
        path: request.url ?? '',
        authorization: request.headers.authorization,
        idempotency: request.headers['idempotency-key'] as string | undefined,
        body,
      });
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/v1/chat/messages') {
        response.end(
          JSON.stringify({
            conversation_id: 'conversation-1',
            message_id: 'message-1',
            response_type: 'change_preview',
            assistant_text: '변경안을 확인해 주세요.',
            documents: [
              {
                document_id: 'REG-000001',
                revision: '3',
                display_path: 'regulations/REG-000001.md',
                source_uri: 'source://regulations/REG-000001.md',
                graph_version: 'build-0123456789abcdefabcd',
                can_write: true,
                evidence: [
                  {
                    chunk_id: 'REG-000001@3#sec-004',
                    section_id: 'sec-004',
                    section: '제4조',
                    heading_path: ['규정', '제4조'],
                    quote: '5년간 보관한다.',
                  },
                ],
              },
            ],
            change_plan: {
              change_plan_id: 'plan-1',
              document_id: 'REG-000001',
              source_uri: 'source://regulations/REG-000001.md',
              unified_diff: '-5년\n+3년',
              plan_hash: 'a'.repeat(64),
            },
            error: null,
          }),
        );
        return;
      }
      if (request.url === '/api/v1/change-plans/plan-1/approve') {
        response.statusCode = 202;
        response.end(
          JSON.stringify({
            execution_id: 'execution-1',
            document_id: 'REG-000001',
            status: 'completed',
            sync_status: 'published',
            terminal: true,
            stage: 'published',
            recommended_poll_after_ms: null,
            error: null,
          }),
        );
        return;
      }
      response.statusCode = 404;
      response.end('{}');
    });
    const baseUrl = await listen(server);
    servers.push(server);

    const approvals: string[] = [];
    const deps: AgentDeps = {
      config: { roots: [], backendUrl: `${baseUrl}/api/v1`, wikiDir: '/tmp/wiki' },
      auth: { getToken: async () => 'must-not-be-used', canWrite: () => true },
      approvalHandler: async (request) => {
        approvals.push(request.planHash ?? '');
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
    for await (const event of createSidecarAgent(deps).send('5년을 3년으로 바꿔줘', {
      conversationId: 'conversation-1',
    })) {
      events.push(event);
    }

    expect(approvals).toEqual(['a'.repeat(64)]);
    expect(requests.map((request) => request.authorization)).toEqual([undefined, undefined]);
    expect(requests.every((request) => Boolean(request.idempotency))).toBe(true);
    expect(requests[1]?.body).toEqual({ plan_hash: 'a'.repeat(64) });
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      citations: [
        {
          docId: 'REG-000001',
          rev: '3',
          graphVersion: 'build-0123456789abcdefabcd',
          chunkId: 'REG-000001@3#sec-004',
          sectionId: 'sec-004',
        },
      ],
    });
  });
});

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
