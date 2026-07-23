import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthService, MemoryAuthStorage } from '@main/auth';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
});

describe('Google OAuth CODEGATE session', () => {
  it('uses PKCE, verifies state, persists the session, and logs out', async () => {
    let redirectUri = '';
    let codeChallenge = '';
    let exchanged: Record<string, string> = {};
    let logoutAuthorization = '';
    const server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/v1/auth/google/start') {
        const body = await readJson(request);
        redirectUri = String(body.redirect_uri);
        codeChallenge = String(body.code_challenge);
        response.end(
          JSON.stringify({
            authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test',
            state: 'server-generated-state',
            expires_at: new Date(Date.now() + 300_000).toISOString(),
          }),
        );
        return;
      }
      if (request.url === '/api/v1/auth/google/exchange') {
        exchanged = await readJson(request);
        response.end(
          JSON.stringify({
            access_token: 'codegate-access-token',
            refresh_token: 'codegate-refresh-token',
            token_type: 'bearer',
            expires_in: 3_600,
          }),
        );
        return;
      }
      if (request.url === '/api/v1/auth/me') {
        expect(request.headers.authorization).toBe('Bearer codegate-access-token');
        response.end(
          JSON.stringify({
            authenticated: true,
            subject_id: 'google-user-123',
            tenant_id: 'google-user-123',
            email: 'operator@example.com',
            read_access: ['public', 'internal', 'restricted'],
            write_scope: 'workspace',
            writable_document_ids: [],
            provisioned: true,
            authz_source: 'google-oauth',
          }),
        );
        return;
      }
      if (request.url === '/api/v1/auth/logout') {
        logoutAuthorization = request.headers.authorization ?? '';
        response.statusCode = 204;
        response.end();
        return;
      }
      response.statusCode = 404;
      response.end('{}');
    });
    const cloudApiUrl = `${await listen(server)}/api/v1`;
    servers.push(server);
    const store = new MemoryAuthStorage();
    const auth = new AuthService({
      authMode: 'google',
      cloudApiUrl,
      store,
      openExternal: async () => {
        const callback = new URL(redirectUri);
        callback.searchParams.set('code', 'google-authorization-code');
        callback.searchParams.set('state', 'server-generated-state');
        expect((await fetch(callback)).status).toBe(200);
      },
    });

    const session = await auth.login({ provider: 'google' });

    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(exchanged).toMatchObject({
      state: 'server-generated-state',
      code: 'google-authorization-code',
    });
    expect(exchanged.code_verifier).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(session).toMatchObject({
      authenticated: true,
      subjectId: 'google-user-123',
      writeScope: 'workspace',
      provisioned: true,
    });

    const restored = await new AuthService({ authMode: 'google', cloudApiUrl, store }).restore();
    expect(restored).toMatchObject({ authenticated: true, subjectId: 'google-user-123' });

    await auth.logout();
    expect(logoutAuthorization).toBe('Bearer codegate-access-token');
    expect(await store.getItem('codegate.oauth.session.v1')).toBeNull();
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

async function readJson(request: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, string>;
}
