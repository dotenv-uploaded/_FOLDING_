# 프론트엔드 구현 스펙 v2.3 — 실제 구현 정합

- 담당: 우창 · 레포 `codegate-2026-local` (Electron + React/shadcn, pnpm 워크스페이스)
- 이 문서는 **현재 코드베이스를 서술**한다. 코드와 다르면 코드가 우선이며 이 문서를 고친다.
- 팀 계약(성주 레포): [`INTEGRATION_CONTRACT.md`](https://github.com/dotenv-uploaded/codegate-2026-agent/blob/main/docs/INTEGRATION_CONTRACT.md) · [`ADR 0004`](https://github.com/dotenv-uploaded/codegate-2026-agent/blob/main/docs/adr/0004-local-agent-llmwiki-and-auth-boundaries.md) · [`LOCAL_RUNTIME.md`](https://github.com/dotenv-uploaded/codegate-2026-agent/blob/main/docs/LOCAL_RUNTIME.md)

> **v2.2 정정 공지**: v2.0/v2.1은 팀 계약만 보고 kordoc·로컬 빌드 파이프라인·enrichment 직접 호출을
> "폐기"로 표기했으나 **과잉 수정이었다.** 이들은 v1.4/v1.5 스펙대로 실제 구현돼 동작 중이다
> (`src/main/kordoc/`, `src/main/build/`). v2.2는 실제 구현인 **하이브리드**를 서술한다:
> Electron이 변환·빌드·인증·워처를 소유하고, 대화·승인·실행은 Python sidecar에 위임한다.
>
> **v2.3 정정**: 빌더가 두 곳(Electron `build/` · sidecar `WikiBuildService`)에 있는 것을 "중복"으로
> 본 것을 정정한다 — **공존이 정상**이다(§0 하단). 같은 코어를 다른 트리거로 부르는 구조이고
> ADR 0004도 "외부 build"를 상정한다. 실제 과제는 저장소 루트·레이아웃 통일과 승격 규약이다.
> 다이어그램(`기획안/architecture.png`)도 실제 모듈 구조로 다시 그렸다.

---

## 0. 구조 (실제)

```
┌─ Electron 앱 〔codegate-2026-local〕 ──────────────────────────┐
│                                                              │
│  렌더러 (React + shadcn)  src/renderer/                       │
│    screens: Login · Onboarding · Main · Settings             │
│    components: ChatList · MessageBubble · CitationChip        │
│                ApprovalModal                                 │
│              ↕ IPC (contracts의 IPC / IPC_EVENTS)             │
│  메인 (Node)  src/main/                                       │
│    auth/     Supabase OAuth · 루프백 · safeStorage            │
│    build/    ① convert → ② enrich(LLM 직접) → ③ assemble      │
│    kordoc/   real · mock · atomic (변환·편집)                  │
│    watcher/  변경 감지 → 증분 재빌드                            │
│    db/       SQLite (파일 상태·대화)                            │
│    agent/    loader → sidecar-agent | mock-agent              │
│    sidecar/  Python 백엔드 HTTP 클라이언트                      │
│    tree.ts · net/ · util/                                     │
└───────┬───────────────────────────────┬──────────────────────┘
        │ sidecar client (loopback)     │ cloud client (Bearer)
        ▼                               ▼
┌─ codegate-local (Python) 〔성주〕 ─┐   ┌─ 로그인·구독 〔Supabase/성주〕 ─┐
│  chat · change-plan · execution   │   │  Supabase Auth · /auth/me     │
│  Claude Agent SDK · 승인 · Undo    │   └───────────────────────────────┘
└───────────────────────────────────┘
                                        Anthropic API — 모델 추론
                                        LLM 제공자 — enrichment
```

**소유 경계**: 문서는 자사 서버로 나가지 않는다. 서버에 묻는 것은 로그인·구독뿐이고 빌드 시작 전에
한 번 확인한다. 대화·변경 승인·실행은 sidecar에 위임한다.

### 빌더 2개는 공존이 정상이다

Electron `build/`는 로직 재구현이 아니라 **오케스트레이터**다 — 변환은 `@codegate/convert`(민규),
조립은 `@codegate/wiki-builder`(용휘)를 동적 import 한다(환경변수로 교체 가능). sidecar의
`WikiBuildService`도 같은 용휘 빌더다. **같은 코어, 다른 트리거**다.

| 트리거 | 소유 | 이유 |
|---|---|---|
| 초기·대량 빌드 (온보딩·폴더 추가) | **Electron** | 진행률 UI, enrichment 동시성·재시도·비용 통제가 여기 있음 |
| 승인 편집 후 재빌드 (문서 1건) | **sidecar** | backup→atomic replace→재변환→빌드→outbox/Undo가 한 트랜잭션 |

ADR 0004도 이를 상정한다 — *"**외부 build가 CAS에서 먼저 이기거나** publish 뒤 process가 중단돼도
native current를 다시 읽고 이미 반영된 event를 멱등 완료할 수 있다."* 경합은 CAS 빌드 ID +
current 재읽기 + 멱등 완료로 흡수된다.

**공존 조건 3가지**: ① 같은 저장소 루트·레이아웃 ② `current.json` 승격 규약(CAS ID 비교 후 재읽기)
③ enrichment 해시 캐시(`PreviousBuild.reusable`) 공유 — sidecar 재빌드도 존중해야 비용 중복이 없다.

## 1. 모듈 현황

| 모듈 | 경로 | 상태 |
|---|---|---|
| **인증** | `main/auth/` — `index.ts` `oauth-loopback.ts` `secret-store.ts` `llm-key.ts` | ✅ 구현 (§3) |
| **빌드 파이프라인** | `main/build/` — `service.ts` `convert.ts` `enrich.ts` `assemble.ts` `manifest.ts` `current.ts` `cache.ts` | ✅ 구현 |
| **kordoc** | `main/kordoc/` — `real.ts` `mock.ts` `atomic.ts` `base.ts` | ✅ 구현 |
| **워처** | `main/watcher/` | ✅ 구현 |
| **에이전트** | `main/agent/` — `loader.ts` `sidecar-agent.ts` `mock-agent.ts` `approval.ts` `host.ts` | ✅ 구현 |
| **sidecar 클라이언트** | `main/sidecar/client.ts` | ✅ 구현 |
| **상태 저장** | `main/db/` — `schema.ts` `store.ts` (SQLite) | ✅ 구현 |
| **공유 계약** | `packages/contracts/src/index.ts` | ✅ 구현 |
| **UI** | `renderer/src/screens|components|state` | ✅ 구현 |

### 빌드 파이프라인 (`build/service.ts`)

```
변경 감지 → ① 변환(kordoc/민규 모듈) → ② enrichment(LLM 직접 호출)
         → ③ 조립(용휘 빌더 코어) → 임시 디렉터리 검증 → 원자적 승격 → current.json
```

`BuildPhase = 'convert' | 'enrich' | 'assemble'`, 상태는 `BuildState`로 렌더러에 스트리밍.
**enrichment가 파이프라인에서 유일하게 비용이 발생하는 지점**이라 `enrich.ts`에 3중 안전장치가 있다:
동시성 제한(기본 4, `CODEGATE_ENRICH_CONCURRENCY`) · 429/5xx/네트워크만 지수 백오프 재시도 ·
부분 실패 격리(해당 문서만 deferred). **해시가 같은 문서는 호출하지 않는다**(`PreviousBuild.reusable`).

### 에이전트 선택 (`agent/loader.ts`)

`CODEGATE_MOCK=1` → 내장 목 에이전트, 그 외 → `createSidecarAgent`. **조용한 폴백 금지** — 어느 쪽이
선택됐는지 로그로 남긴다.

`sidecar-agent.ts`는 sidecar 응답을 `AgentEvent` 스트림으로 변환한다:
`tool_start` → `text_delta` → (`change_preview`면) `approval_request` → `done{citations}`.
쓰기 전 `deps.auth.canWrite()`를 확인하고 아니면 `auth_error{kind:'not_provisioned'}`.

## 2. 계약 (`packages/contracts`)

렌더러·메인이 공유하는 타입. 주요 항목:

```ts
Citation · PatchResult · KordocApi · ApprovalRequest · AgentDeps · AgentEvent · CreateAgent
Root · ScanPreview · FileStatus · FileNode
BuildPhase · BUILD_PHASE_LABEL · BuildStatus · BuildState
Session · Subscription · SubscriptionResponse · OAuthProvider · LoginRequest
Conversation · ChatMessage · ExecutionSummary
IPC · IPC_EVENTS · AgentEventEnvelope · ApprovalEnvelope
```

`AgentEvent`는 IPC로 렌더러에 중계된다(`AgentEventEnvelope`). 렌더러는 타입별로 UI를 그린다 —
`approval_request`→ApprovalModal, `tool_start`→상태 배지, `text_delta`→스트리밍, `done`→CitationChip.

## 3. 인증 (구현 완료)

**Supabase Auth + 시스템 브라우저 + PKCE + 루프백 콜백.** ADR 0004대로 로그인은 프론트가 직접
수행하고, 백엔드는 JWKS로 검증만 한다(자체 OAuth 엔드포인트 없음).

```ts
// main/auth/index.ts
createClient(supabaseUrl, supabasePublishableKey, {
  auth: { flowType: 'pkce', autoRefreshToken: true, persistSession: true,
          detectSessionInUrl: false, storage: safeStorageBackedStore },
});
// login()
const receiver = await createOAuthLoopbackReceiver();
await client.auth.signInWithOAuth({ provider,
  options: { redirectTo: receiver.redirectTo, skipBrowserRedirect: true } });
await shell.openExternal(data.url);
```

**루프백 수신기** (`oauth-loopback.ts`) — state를 콜백 **경로에 박아** CSRF를 라우팅으로 차단:

```ts
const state = randomBytes(32).toString('base64url');
// http://127.0.0.1:<임의포트>/oauth/callback/<state>
if (req.method !== 'GET' || url.pathname !== `/oauth/callback/${state}`) → 404
```

3분 타임아웃 · `server.unref()`/`timer.unref()`(앱 종료 비차단) · `no-store`·`nosniff` ·
`error_description` 처리 · 완료 안내 HTML 응답.

**토큰 저장** (`secret-store.ts`) — `SafeStorageAuthStorage`가 PKCE verifier와 세션을 OS 키체인
(`safeStorage`)으로 암호화해 `auth.bin`에 원자적으로 쓴다. 테스트용 `MemoryAuthStorage` 병행.
Supabase 미설정 시 `client=null`로 앱은 계속 동작한다.

`restore()`가 앱 시작 시 세션을 복원하고 `/auth/me`로 신원·권한을 갱신한다.
`write_scope`가 `none`이면 승인 UI를 막는다.

**자격증명 3종 분리** (`llm-key.ts`가 ②를 별도 보관):
① Supabase 토큰 ② enrichment LLM 키 ③ Anthropic 자격증명(sidecar).

## 4. UX

```
[온보딩] 로그인(Google OAuth → 시스템 브라우저) → 폴더 선택 → 스캔 미리보기
         → 빌드: 변환 ▸ enrichment ▸ 조립 (단계별 진행률)

[메인 3분할] 좌 대화목록 │ 중앙 채팅(인용 칩·클릭 시 원본) │ 우 트리(파일 상태)+빌드 진행률

[승인 모달] change_preview → 대상·exact diff·plan_hash·근거 → [거부][원본][승인]
            → execution 폴링 → 완료/실패 → Undo
```

실패는 **한국어 문장**으로 `BuildState.error`에 담는다 (silent fail 금지).

## 5. 남은 작업 · 미해결

| 항목 | 내용 |
|---|---|
| **빌드 저장소 정합** ⚠️ | 두 빌더는 **공존이 맞다**(§0 하단). 다만 현재 저장 경로가 달라 서로 다른 위키를 만든다 — Electron `~/.codegate/wiki/{builds,current.json}` vs sidecar `<llmwiki-storage-root>/tenants/<t>/wikis/<w>/current.json`. **루트·레이아웃 통일 + 승격 규약 합의 필요** (성주) |
| README 갱신 | 아직 "codegate-2026-web / Next.js 풀스택" — Electron 앱으로 수정 |
| 계약 표기 | 팀 계약 v0.3의 "우창 = Next.js UI" → Electron으로 갱신 협의 |
| 옛 레포명 핀 | 계약·ADR이 `codegate-2026-api@360ff41` 참조 → `codegate-2026-convert` |
| 바이너리 쓰기 | 계약상 md/txt만. HWP는 §7 검증 결과로 완화 제안 가능 |

## 6. 규칙

- **승인 무결성**: 화면에 보인 exact `plan_hash`만 전송
- **인용 원문성**: canonical quote 그대로 렌더 — 요약·말줄임 금지. `embedding_text`는 quote로 노출 안 함
- **enrichment 비근거**: 근거는 canonical section의 exact quote만
- **클라이언트 분리**: cloud Bearer client와 local sidecar client를 섞지 않음 (ADR 0004)
- **경로 규칙**: `source/` `source-md/` `llmwiki-storage/` `app-data/` 비중첩. source=source-md 금지
- **원자성**: kordoc 패치는 `.bak` → 임시파일 → rename. 빌드는 임시 디렉터리 검증 후 `current.json` 승격
- **표현**: 모델 추론이 API 호출이므로 "완전 오프라인"으로 표현하지 않음
- **성주 레포 불변**: 인증·에이전트 백엔드는 기존 구현을 소비만 한다

## 7. 부록 — HWP 왕복 검증 (2026-07-21, kordoc 4.2.4, M4 Pro)

실제 프로젝트 hwp 3종 검증: 파싱 0.25초 · **서식 보존 패치 0.3초에 2.5MB 파일 바이트 동일**
(2,636,288) · 패치 후 재파싱 자기검증 통과(미적용 시 exit 2) · md→hwpx 생성 구조 검증 통과 ·
`render --reflow` SVG 렌더 가능 · `fill`은 오탐 있어 명시적 find/replace 권장.
→ 계약의 "verified round-trip writer" 후보로 제안 가치 있음 (성주·민규 협의).

## 8. 부록 — enrichment 비용 실측 (2026-07-21, M4 Pro 24GB)

코퍼스 424파일/508MB = **10.75M 토큰**. gemma3:4b decode 66 tok/s가 병목이라 로컬 LLM 전량 추출은
**59~102시간**(병렬 무효 — 메모리 대역폭). GLiNER(전용 NER)는 **1.42 청크/s → 전량 1.9시간**, CPU 거의
미사용. → enrichment 비용 최적화 시 엔티티 추출만 GLiNER로 분리하면 비용 1/20.
