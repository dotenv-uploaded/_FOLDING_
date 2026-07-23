# CODEGATE Cloud API

Electron 앱의 Google OAuth 로그인과 CODEGATE 자체 세션을 담당하는 FastAPI 서비스다.
Supabase를 사용하지 않는다.

## 인증 흐름

1. Electron이 임의 loopback 포트를 열고 PKCE verifier/challenge를 만든다.
2. `POST /api/v1/auth/google/start`에 loopback `redirect_uri`와 challenge를 보낸다.
3. 응답의 `authorization_url`을 시스템 브라우저로 연다.
4. Google이 loopback으로 보낸 `code`, `state`를 Electron이 받는다.
5. `POST /api/v1/auth/google/exchange`에 code, state, verifier를 보낸다.
6. Backend가 state·PKCE를 검증하고 Google token endpoint에서 code를 교환한다.
7. Google ID token의 signature, issuer, audience, expiry, nonce, verified email을 검증한다.
8. Google token은 저장하지 않고 CODEGATE opaque access/refresh token만 발급한다.

OAuth state는 1회용이며 5분 후 만료된다. Refresh token은 사용할 때마다 access token과 함께
회전한다. 이미 사용한 refresh token이 다시 들어오면 탈취 가능성이 있는 같은 token family를
모두 폐기한다. 데이터베이스에는 원문 session token 대신 `CODEGATE_SESSION_PEPPER`를 사용한
HMAC-SHA256 digest만 저장한다.

## API

| Method | Path | 설명 |
|---|---|---|
| `POST` | `/api/v1/auth/google/start` | Google authorization URL과 1회용 state 생성 |
| `POST` | `/api/v1/auth/google/exchange` | authorization code를 CODEGATE session으로 교환 |
| `POST` | `/api/v1/auth/refresh` | refresh token 회전 |
| `GET` | `/api/v1/auth/me` | 현재 사용자 확인 |
| `POST` | `/api/v1/auth/logout` | 현재 session 폐기 |
| `GET` | `/api/v1/health` | OAuth 구성 상태 확인 |

`redirect_uri`는 포트가 명시된 `http://127.0.0.1:<port>/...` 또는
`http://[::1]:<port>/...`만 허용한다. Google 로그인은 embedded webview가 아니라 시스템
브라우저에서 진행한다.

## Google 설정

Google Cloud Console에서 OAuth consent screen을 설정하고 `Desktop app` client를 만든다.
로그인에 필요한 scope는 `openid email profile`뿐이며 Google API 장기 접근 권한이나 offline
access를 요청하지 않는다. Desktop client는 public client이므로 client secret에 보안을
의존하지 않는다. Web client로 전환할 경우 정확한 HTTPS redirect URI와
`CODEGATE_GOOGLE_CLIENT_SECRET`을 별도 secret store에 설정해야 한다.

## 실행

Python 3.12와 `uv`가 필요하다.

```bash
cd cloud-api
cp .env.example .env
# GOOGLE_CLIENT_ID와 SESSION_PEPPER를 실제 값으로 설정한다.
uv sync --extra dev
uv run codegate-cloud-api
```

검증:

```bash
uv run ruff format --check src tests
uv run ruff check src tests
uv run pytest
```

Production에서는 `CODEGATE_ENVIRONMENT=production`, 명시적 CORS allowlist, HTTPS Google
endpoint, Google client ID와 session pepper가 모두 없으면 기동하지 않는다. `.env`, OAuth
credential, 실제 session DB는 커밋하지 않는다.

OAuth start와 refresh는 client IP별 in-process rate limit을 적용한다. Pending flow 수와 한
refresh-token family의 총 rotation 수도 제한한다. Production gateway에도 IP·connection rate
limit을 별도로 둬야 한다. 현재 SQLite store는 한 deployment가 공유하는 단일 DB 파일을
전제로 한다. 여러 replica로 확장할 때는 OAuth state와 session rotation을 같은 transaction으로
처리하는 공유 PostgreSQL adapter가 먼저 필요하다.

만료된 OAuth flow, refresh-token family와 사용 완료 token digest는 시작 시, 인증 상태 변경
시, 그리고 기본 5분 주기의 background cleanup에서 정리한다. 마지막 유효 session이 사라진
사용자의 email, name, picture도 함께 삭제한다.

Google의 web-server OAuth 문서는 callback의 state 확인과 credential의 저장소 외부 보관을
요구한다. Desktop 앱에는 PKCE와 시스템 브라우저 사용이 권장된다.

- https://developers.google.com/identity/protocols/oauth2/web-server
- https://developers.google.com/identity/protocols/oauth2/resources/best-practices
