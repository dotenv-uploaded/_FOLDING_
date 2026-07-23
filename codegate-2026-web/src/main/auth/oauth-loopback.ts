import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface OAuthCallback {
  code: string;
  state: string;
}

export interface OAuthLoopbackReceiver {
  redirectTo: string;
  waitForCode(): Promise<OAuthCallback>;
  close(): Promise<void>;
}

export class OAuthCancelledError extends Error {
  constructor() {
    super('로그인이 취소되었습니다.');
    this.name = 'OAuthCancelledError';
  }
}

/** This value must exactly match the redirect URI registered in Google Cloud Console. */
export const DEFAULT_OAUTH_REDIRECT_URI = 'http://127.0.0.1:47821/auth/callback';

const OAUTH_SUCCESS_HTML = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>로그인 완료 · Folding</title>
  <style>
    :root {
      color: #0d1630;
      font-family: Pretendard, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f7f8fa;
    }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      padding: 24px;
      overflow: hidden;
      background:
        radial-gradient(circle at 18% 12%, rgba(92, 134, 254, .18), transparent 34%),
        radial-gradient(circle at 84% 88%, rgba(43, 93, 253, .12), transparent 32%),
        #f7f8fa;
    }
    .card {
      width: min(100%, 440px);
      padding: 28px 30px 30px;
      text-align: center;
      border: 1px solid #eef0f4;
      border-radius: 18px;
      background: rgba(255, 255, 255, .94);
      box-shadow: 0 16px 36px rgba(13, 22, 48, .10), 0 4px 8px rgba(13, 22, 48, .05);
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 9px;
      margin-bottom: 30px;
      font-size: 21px;
      font-weight: 800;
      letter-spacing: -.04em;
    }
    .brand-mark { width: 25px; height: 30px; display: block; }
    .status {
      width: 58px;
      height: 58px;
      margin: 0 auto 20px;
      display: grid;
      place-items: center;
      border-radius: 18px;
      color: #fff;
      background: linear-gradient(150deg, #5c86fe 0%, #2b5dfd 55%, #1e48e0 100%);
      box-shadow: 0 10px 26px rgba(43, 93, 253, .30);
    }
    .status svg { width: 27px; height: 27px; }
    h1 {
      margin: 0;
      font-size: 24px;
      line-height: 1.25;
      letter-spacing: -.03em;
    }
    .message {
      margin: 10px 0 0;
      color: #5b6480;
      font-size: 14px;
      line-height: 1.65;
    }
    .closing {
      margin-top: 26px;
      padding: 13px 15px 12px;
      border-radius: 10px;
      color: #465172;
      background: #f7f8fa;
      font-size: 13px;
      line-height: 1.5;
    }
    .progress {
      height: 3px;
      margin-top: 11px;
      overflow: hidden;
      border-radius: 999px;
      background: #dce6ff;
    }
    .progress::after {
      content: "";
      display: block;
      width: 100%;
      height: 100%;
      border-radius: inherit;
      background: #2b5dfd;
      transform-origin: left;
      animation: closing 3s linear forwards;
    }
    @keyframes closing { to { transform: scaleX(0); } }
    @media (prefers-reduced-motion: reduce) {
      .progress::after { animation: none; }
    }
  </style>
</head>
<body>
  <main class="card" aria-labelledby="title">
    <div class="brand" aria-label="Folding">
      <svg class="brand-mark" viewBox="0 0 50 60" aria-hidden="true">
        <defs>
          <linearGradient id="brand-gradient" x1="8" y1="3" x2="42" y2="57" gradientUnits="userSpaceOnUse">
            <stop stop-color="#8daefe"/>
            <stop offset=".55" stop-color="#2b5dfd"/>
            <stop offset="1" stop-color="#1e48e0"/>
          </linearGradient>
        </defs>
        <path fill="url(#brand-gradient)" d="M4 12a7 7 0 0 1 7-7h10l5 7h13a7 7 0 0 1 7 7v29a7 7 0 0 1-7 7H11a7 7 0 0 1-7-7V12Z"/>
        <path fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round" stroke-width="4" d="m16 34 6 6 13-15"/>
      </svg>
      <span>folding</span>
    </div>

    <div class="status" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none">
        <path d="m5 12.5 4.25 4.25L19 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
    <h1 id="title">로그인이 완료되었습니다</h1>
    <p class="message">Google 계정이 안전하게 연결되었습니다.<br>이제 Folding에서 작업을 이어갈 수 있어요.</p>

    <div class="closing" aria-live="polite">
      <span id="closing-label">3초 후 창이 자동으로 닫힙니다.</span>
      <div class="progress" aria-hidden="true"></div>
    </div>
  </main>
  <script>
    (() => {
      const label = document.getElementById('closing-label');
      let seconds = 3;
      const countdown = window.setInterval(() => {
        seconds -= 1;
        if (seconds > 0) label.textContent = seconds + '초 후 창이 자동으로 닫힙니다.';
      }, 1_000);
      const closeWindow = () => {
        window.clearInterval(countdown);
        label.textContent = 'Folding으로 돌아가는 중…';
        window.close();
        window.setTimeout(() => {
          label.textContent = '창이 닫히지 않으면 직접 닫고 Folding으로 돌아가세요.';
        }, 250);
      };
      window.setTimeout(closeWindow, 3_000);
    })();
  </script>
</body>
</html>`;

function configuredRedirectUri(env: NodeJS.ProcessEnv): string {
  return env.CODEGATE_OAUTH_REDIRECT_URI?.trim() || DEFAULT_OAUTH_REDIRECT_URI;
}

/**
 * Opens the fixed loopback callback used by Google OAuth.
 * Port 0 remains available to tests that need an ephemeral port.
 */
export async function createOAuthLoopbackReceiver(
  timeoutMs = 3 * 60 * 1000,
  redirectUri: string = configuredRedirectUri(process.env),
): Promise<OAuthLoopbackReceiver> {
  const target = new URL(redirectUri);
  const wantedPort = Number(target.port);
  const callbackPath = target.pathname;

  let resolveCode!: (callback: OAuthCallback) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<OAuthCallback>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // A failed start can close the receiver before login() awaits this promise.
  codePromise.catch(() => undefined);

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method !== 'GET' || requestUrl.pathname !== callbackPath) {
      response.writeHead(404).end('Not found');
      return;
    }

    const oauthError = requestUrl.searchParams.get('error_description');
    const code = requestUrl.searchParams.get('code');
    const state = requestUrl.searchParams.get('state');
    if (oauthError || !code || !state) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Folding sign-in did not complete. You can close this tab.');
      rejectCode(new Error(oauthError || 'OAuth callback did not include code and state'));
      return;
    }

    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
    });
    response.end(OAUTH_SUCCESS_HTML);
    resolveCode({ code, state });
  });

  await listen(server, wantedPort, redirectUri);
  server.unref();
  const port = wantedPort === 0 ? (server.address() as AddressInfo).port : wantedPort;
  const timer = setTimeout(() => rejectCode(new Error('OAuth login timed out')), timeoutMs);
  timer.unref();

  return {
    redirectTo: `http://127.0.0.1:${port}${callbackPath}`,
    waitForCode: () => codePromise,
    close: async () => {
      clearTimeout(timer);
      rejectCode(new OAuthCancelledError());
      await close(server);
    },
  };
}

function listen(server: Server, port: number, redirectUri: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(
              `로그인 콜백 포트 ${port} 를 다른 프로그램이 쓰고 있습니다. ` +
                `그 프로그램을 끄고 다시 시도해 주세요. (Google에 등록된 주소: ${redirectUri})`,
            )
          : error,
      );
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
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
