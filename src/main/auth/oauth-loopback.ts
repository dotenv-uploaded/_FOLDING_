import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface OAuthLoopbackReceiver {
  redirectTo: string;
  waitForCode(): Promise<string>;
  close(): Promise<void>;
}

export async function createOAuthLoopbackReceiver(
  timeoutMs = 3 * 60 * 1000,
): Promise<OAuthLoopbackReceiver> {
  const state = randomBytes(32).toString('base64url');
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method !== 'GET' || requestUrl.pathname !== `/oauth/callback/${state}`) {
      response.writeHead(404).end('Not found');
      return;
    }
    const oauthError = requestUrl.searchParams.get('error_description');
    const code = requestUrl.searchParams.get('code');
    if (oauthError || !code) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('CODEGATE sign-in did not complete. You can close this tab.');
      rejectCode(new Error(oauthError || 'OAuth callback did not include an authorization code'));
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(
      '<!doctype html><meta charset="utf-8"><title>CODEGATE</title><p>로그인이 완료되었습니다. 이 창을 닫고 CODEGATE로 돌아가세요.</p>',
    );
    resolveCode(code);
  });

  await listen(server);
  server.unref();
  const address = server.address() as AddressInfo;
  const redirectTo = `http://127.0.0.1:${address.port}/oauth/callback/${state}`;
  const timer = setTimeout(() => rejectCode(new Error('OAuth login timed out')), timeoutMs);
  timer.unref();

  return {
    redirectTo,
    waitForCode: () => codePromise,
    close: async () => {
      clearTimeout(timer);
      await close(server);
    },
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
