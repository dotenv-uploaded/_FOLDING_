# 프론트엔드 구현 스펙 v2.1 (팀 계약 정합 개정판)

- 담당: 우창 · 레포 `codegate-2026-local`
- **정본 문서**: 성주 레포의 [`INTEGRATION_CONTRACT.md` v0.3](https://github.com/dotenv-uploaded/codegate-2026-agent/blob/main/docs/INTEGRATION_CONTRACT.md) · [`ADR 0004`](https://github.com/dotenv-uploaded/codegate-2026-agent/blob/main/docs/adr/0004-local-agent-llmwiki-and-auth-boundaries.md) · [`LOCAL_RUNTIME.md`](https://github.com/dotenv-uploaded/codegate-2026-agent/blob/main/docs/LOCAL_RUNTIME.md)
- 이 문서와 위 계약이 다르면 **계약과 실행 중인 Backend `/openapi.json`이 우선**한다.

> **v2.0 전면 개정 사유**: v1.x는 "Electron 메인(Node)이 Claude Agent SDK와 kordoc을 직접 호스트"한다고
> 가정했으나, 팀 실제 구현은 **Python sidecar(`codegate-local`)** 가 Agent SDK·LLMWIKI·doc2md를
> 담당한다. 프론트는 UI와 sidecar 수명주기·인증·OS capability를 맡는다.
> 폐기된 가정: TS 단일 런타임 · `@codegate/agent` npm 패키지 · SDK 내장 도구 사용 · kordoc 파이프라인 ·
> 프론트의 enrichment 직접 호출.
>
> **v2.1**: 인증(§3)을 성주 레포의 **실제 구현 기준**으로 정정. 데스크톱 MVP는 `auth_mode=local`로
> 동작하므로 **로그인 UI 없이 핵심 흐름이 완결**된다. Supabase/OAuth는 클라우드 계정이 필요할 때의
> 선택 경로다. 성주 레포는 수정하지 않고 있는 그대로 소비한다.

---

## 0. 구조

**UI = Electron 데스크톱 앱. 두뇌 = 로컬 Python sidecar.**

```
┌─ Electron 앱 〔우창〕 ─────────────────────────────────────────┐
│                                                              │
│  렌더러 (React + shadcn/Tailwind)                             │
│    3분할 UI · 근거 인용 · diff 승인 · execution 폴링 · Undo      │
│              ↕ IPC                                           │
│  메인 (Node — 얇게 유지, 비즈니스 로직 없음)                      │
│    · sidecar 프로세스 수명주기 (spawn / health / shutdown)      │
│    · 폴더 선택 다이얼로그 → workspace capability                │
│    · 원본 파일 열기 (shell.openPath)                           │
│    · (클라우드 전환 시) OAuth 콜백 + safeStorage                 │
│              ↓ HTTP · local sidecar client (loopback + CORS)   │
└──────────────┬───────────────────────────────────────────────┘
               ▼
┌─ codegate-local sidecar (Python) 〔성주〕 ─────────────────────┐
│  auth_mode=local → LocalAuthenticator (로그인 불필요)           │
│  Claude Agent SDK — app-owned read tools                      │
│    ❌ 내장 Read/Edit/Write/Bash 비활성 + PreToolUse allowlist    │
│  LLMWIKI WikiBuildService 〔용휘〕 in-process                   │
│  doc2md 클라이언트 〔민규〕                                      │
│  승인·backup·atomic replace·outbox·Undo·SQLite journal        │
└───────────────────────────────────────────────────────────────┘

    ┈┈ 클라우드 계정 도입 시에만 추가되는 경로 (선택) ┈┈
    메인 → cloud client (Bearer) → 배포 Backend (JWKS 검증)
    메인 → Supabase Auth (OAuth · PKCE · 시스템 브라우저)
```

**프론트는 파일을 직접 쓰지 않는다.** 모든 원본 변경은 sidecar의 승인 경로(exact diff →
`plan_hash` → approve → backup → atomic replace → outbox → Undo)를 통과한다.

## 1. 우창 컴포넌트

| # | 컴포넌트 | 내용 | 규모 |
|---|---|---|---|
| **L1** | **렌더러 UI** | 3분할(좌 대화목록 / 중앙 채팅 / 우 문서·상태). `response_type` 4종 분기 렌더링, **인용 배지** `[document_id rev.N §section_id]` 클릭 → 원본 열기, **diff 승인 모달(plan_hash 표시)**, execution 폴링 진행 표시, **Undo 버튼** | 2.5일 |
| **L2** | **sidecar 수명주기 (메인)** | 앱 시작 시 `codegate-local` spawn(포트 할당·`--cors-origin` 전달), `GET /api/v1/health` 준비 대기, 비정상 종료 감지·재기동, 앱 종료 시 graceful shutdown. **겹치지 않는 4개 루트 준비**: `source/` `source-md/` `llmwiki-storage/` `app-data/` | 1.5일 |
| **L3** | **인증 연동 (메인+렌더러)** | **MVP: `GET /auth/me` 신원·권한 표시 + `write_scope` 기반 UI 게이팅만** (로그인 UI 불필요 — sidecar가 `auth_mode=local`). 클라우드 전환 시에만 Supabase OAuth(§3.2) 추가 | **0.5일** (클라우드 전환 시 +1일) |
| **L4** | **workspace capability (메인)** | 폴더 선택 다이얼로그 → source root 지정(OS 권한 경계), 스캔 미리보기, 원본 열기(`shell.openPath`), 4개 루트 비중첩 검증 | 0.5일 |

**제거된 항목** (v1.x 잔재): kordoc 래퍼 · 로컬 빌드 오케스트레이터 · enrichment LLM 직접 호출 — 전부 sidecar 소관.

## 2. sidecar API 계약 (프론트가 소비)

Base: `http://127.0.0.1:<port>/api/v1` — 정본은 실행 중인 `/openapi.json`.

| 엔드포인트 | 프론트 사용처 |
|---|---|
| `GET /health` | L2 준비 대기·헬스체크 |
| `GET /auth/me` | L3 신원·권한 snapshot (`no-store`) |
| `POST /chat/messages` | L1 질문·변경 요청 (`Idempotency-Key` 필수) |
| `GET /documents/{document_id}` | L1 문서 상세 |
| `POST /documents/{id}/source-sync-plans` | 원본 동기화 계획 |
| `POST /change-plans/{id}/approve` \| `/reject` | L1 승인 모달 — **화면에 보인 exact `plan_hash`를 그대로 전송** |
| `GET /executions/{execution_id}` | L1 폴링 (`recommended_poll_after_ms` 사용, `terminal`까지) |
| `POST /executions/{id}/retry-sync` \| `/undo` | L1 재시도·Undo |

**Chat `response_type` 4종 → UI 분기**

| 타입 | 렌더링 |
|---|---|
| `location_result` | 근거 답변 — canonical quote 그대로 + 인용 배지. **quote 임의 요약·변형 금지** |
| `target_selection` | 대상 문서 후보 선택 UI |
| `change_preview` | **diff + `plan_hash` 승인 모달** |
| `error` | 오류 문장 (silent fail 금지) |

approve·undo는 `202 Accepted` + `Location` → **execution 폴링으로 전환**. 실행 상태는 chat 응답에 없다.

필수 citation 5종: `document_id` · `revision` · `graph_version` · `chunk_id` · `section_id`.

## 3. 인증 — 성주 구현(`auth.py`) 소비

Backend는 `TokenAuthenticator` Protocol로 인증자를 **모드별로 플러그인**한다. 프론트는 이를
구현하지 않고 선택·소비만 한다. (성주 레포는 수정하지 않는다.)

| `CODEGATE_AUTH_MODE` | 인증자 | 쓰임 |
|---|---|---|
| **`local`** | `LocalAuthenticator` | **데스크톱 sidecar 기본값.** loopback 전용 단일 사용자 capability — `provisioned=true`, `allow_all_writes=true`, `authz_source="local-workspace"` |
| `supabase` | `SupabaseJwtAuthenticator` | 클라우드 멀티테넌트. JWKS 검증 + 커스텀 클레임(tenant·read_access·write_documents) |
| `demo` | `DemoTokenAuthenticator` | 개발용 고정 bearer 토큰 |

### 3.1 MVP: 로그인 없이 동작

데스크톱 앱의 sidecar는 `CODEGATE_ENVIRONMENT=local` + `CODEGATE_AUTH_MODE=local`로 기동한다.
**질문·검색·수정·승인·Undo 전 흐름에 로그인 UI가 필요 없다.** 권한은 Supabase 신원이 아니라
사용자가 OS 다이얼로그로 고른 workspace 범위에서 생긴다 (ADR 0004의 capability 분리 원칙).

프론트가 할 일은 `GET /api/v1/auth/me`로 신원·권한 snapshot을 읽어 UI에 반영하는 것뿐이다:

```json
{ "subject_id": "local-user", "tenant_id": "...", "write_scope": "workspace",
  "provisioned": true, "authz_source": "local-workspace" }
```

`write_scope`가 `none`이면 승인 버튼을 비활성화한다.

### 3.2 클라우드 계정이 필요해질 때 (선택)

계정·구독·다기기 동기화가 필요해지면 `auth_mode=supabase`로 전환한다. ADR 0004에 따라
**로그인은 프론트가 Supabase Auth와 직접** 수행하고, Backend는 password·refresh token·
service-role key를 받지 않고 JWKS로 access token만 검증한다. Backend에 자체 OAuth 엔드포인트를
만들지 않는다 (ADR이 secret 보관 중복을 이유로 기각한 대안).

데스크톱 OAuth는 **시스템 브라우저 + PKCE**가 표준이다 — 앱 내 `BrowserWindow`에 로그인 페이지를
띄우면 구글이 `disallowed_useragent`로 차단한다.

```
렌더러 로그인 클릭 ─▶ 메인: supabase-js(flowType:'pkce') signInWithOAuth
                       ({ skipBrowserRedirect: true }) → authUrl
                     shell.openExternal(authUrl) ─▶ 시스템 브라우저 ─▶ 구글/Supabase
                     루프백 콜백(127.0.0.1:<고정후보포트>/callback)에서 code 수신
                     exchangeCodeForSession(code) → safeStorage 저장
                     cloud client(Bearer)로 GET /auth/me
```

**필수 요건**: PKCE · embedded webview 금지 · 토큰은 `safeStorage`(평문 저장 금지) · refresh 자동 갱신 ·
Supabase 대시보드 Redirect URLs에 루프백 후보 포트 등록 · 앱에는 **anon key만**(service_role 금지).
저장소 어댑터는 `localStorage`가 없는 메인 프로세스용으로 `safeStorage` 기반 커스텀 구현이 필요하다.

**클라이언트 2개 분리 (ADR 0004)**: cloud Bearer client와 local sidecar client를 절대 섞지 않는다.

## 4. UX 흐름

```
[온보딩] 폴더 선택(workspace) → sidecar 기동(auth_mode=local) → 초기 변환·빌드 진행률
         ※ MVP는 로그인 단계 없음. 클라우드 계정 도입 시 앞단에 추가

[메인 3분할]
┌──────────┬────────────────────────────────┬──────────────────┐
│ 대화 목록  │ 채팅                            │ 문서·상태          │
│          │ Q: 개인정보 보관 기간 어디 있어?    │ 📁 source/       │
│ + 새 대화 │ A: "…5년간 보관한다"             │  ├ ✓ REG-000001  │
│          │    [REG-000001 rev.3 §sec-004]  │  └ ⟳ MAN-000002  │
│          │    ↑ 클릭 → 원본 열기             │ graph_version    │
│          │                                │ 빌드 ▓▓▓░ 78%    │
└──────────┴────────────────────────────────┴──────────────────┘

[승인 모달]  change_preview 수신 시
  대상 · exact diff · plan_hash(표시) · 근거 인용
  [거부] [원본 보기] [승인] → 202 → execution 폴링 → 완료/실패 → [Undo]
```

**표기 주의**: 모델 추론은 Anthropic API 호출이므로 UI·홍보 문구에서 "완전 오프라인"·"로컬 전용"으로
표현하지 않는다 (ADR 0004).

## 5. 마일스톤

| M | 내용 | 완료 기준 |
|---|---|---|
| **M0** (D+1) | 계약 확정: sidecar 실행 인자·포트 규약·CORS origin·`auth_mode=local` 기동, Electron 스캐폴딩 | 앱에서 sidecar spawn → `/health` 200 → `/auth/me` 응답 |
| **M1** (D+2) | 읽기 경로: `GET /auth/me` + `POST /chat/messages` → `location_result` 렌더 | 질문 → **인용 배지 있는 답변** 표시 |
| **M2** (D+3) | 쓰기 경로: `change_preview` → diff·plan_hash 승인 → approve → execution 폴링 | md 파일 수정이 승인 후 실제 반영 |
| **M3** (D+4) | Undo·retry-sync·오류 UX·문서 트리·진행률 | 수정 → Undo로 원상복구 확인 |
| **M4** (D+5) | 패키징(sidecar 번들·LLMWIKI bundle 고정)·데모 시나리오 | 설치본에서 전 흐름 동작 |

sidecar 준비 전에는 성주 레포의 합성 fixture·`--deterministic-agent` 모드로 UI를 병렬 개발한다.

## 6. 리스크·규칙

- **쓰기 범위 제한**: 실제 write는 **UTF-8 Markdown/TXT만**. PDF·DOCX·HWP는 verified round-trip
  writer 전까지 read-only — UI에서 편집 불가를 명확히 표시
- **승인 무결성**: 화면에 보인 exact `plan_hash`만 전송. 사용자가 본 diff와 다른 계획이 승인되면 안 됨
- **인용 원문성**: `location_result`의 quote는 canonical 원문 그대로 렌더 — 요약·말줄임 금지.
  `embedding_text`는 검색 전용이라 quote로 노출하지 않음
- **enrichment 비근거**: 근거는 canonical section에 연결된 exact quote만. enrichment는 후보 확장용이며
  현재 Backend 검색 adapter가 로드하지 않으므로 근거로 표시하지 않음
- **클라이언트 분리**: cloud Bearer client와 local sidecar client를 절대 섞지 않음 (ADR 0004)
- **경로 규칙**: 4개 루트는 서로 겹칠 수 없음. 특히 source와 source-md 동일 경로 금지(자기 SHA 순환)
- **LLMWIKI bundle**: 앱과 함께 배포·검증된 고정 bundle만 실행. 사용자가 고른 임의 폴더를 project root로 실행 금지
- **자격증명 분리**: ① `ANTHROPIC_API_KEY`(sidecar 환경변수) ② (클라우드 전환 시) Supabase 토큰(safeStorage) — 섞지 말 것
- **성주 레포 불변**: 인증은 기존 `TokenAuthenticator` 구현을 모드 선택으로만 소비. Backend에 자체 OAuth 엔드포인트를 추가하지 않음
- **멱등성**: `POST /chat/messages`에 `Idempotency-Key`, execution은 `event_id` 기준 재시도 안전

## 부록 — 팀에 제안할 검증 결과 (참고)

계약상 HWP는 read-only이나, **kordoc 4.2.4로 실제 hwp 3종 왕복 검증**을 수행했다
(2026-07-21, M4 Pro): 파싱 0.25초, **서식 보존 패치 0.3초에 2.5MB 파일 바이트 크기 동일**,
패치 후 자동 재파싱 자기검증 통과(미적용 편집 시 exit 2). "verified round-trip writer" 후보로
검토할 가치가 있으며, `render --reflow`는 양식·레이아웃 확인용 비전 경로로 쓸 수 있다.
채택 여부는 성주·민규와 협의 사항.
