# 프론트엔드 구현 스펙 v1.5

- 범위: `codegate-2026-local`(우창) + `codegate-2026-agent`(성주) — **로컬 데스크톱 앱(Electron)이 프론트엔드**
- 기준 문서: [기획안 v1.5.0](https://github.com/dotenv-uploaded/codegate-2026-backend/tree/main/docs/기획안)
- 흐름도: [architecture.png (v1.5 · 번호 흐름 ⓪~⑧)](https://github.com/dotenv-uploaded/codegate-2026-backend/blob/main/docs/기획안/architecture.png)
- v1.1 변경: rclone/오프라인 사본 제거 · 로그인/구독 연동 추가 · 위키 빌드는 프론트가 API로 트리거
- v1.2 변경: **위키는 로컬에만 존재** (서버 무보관) — 검색이 로컬로 이동, L2에 산출물 회수 추가, zip 전송 프로토콜 확정
- v1.3 변경: **UI = CLI → 데스크톱 앱(Electron)** — 메인 프로세스가 SDK·kordoc·워처 호스트, 렌더러는 React(shadcn)
- v1.4 변경: **서버 = 로그인·구독만** — 변환·enrichment·빌드 전부 로컬 실행, 파일 전송 프로토콜 삭제
- v1.5 변경: **OAuth 로그인 플로우 명세** (§3) — 시스템 브라우저 + PKCE + 딥링크/루프백 콜백

---

## 0. 기술 결정 (선행 합의)

**앱 셸: Electron + React(shadcn/Tailwind).**
- Agent SDK·kordoc이 모두 Node → **Electron 메인 프로세스가 곧 에이전트 호스트** (별도 데몬·사이드카 불필요)
- 팀의 Next.js/shadcn 경험 재사용 (렌더러 = Vite + React)
- Tauri는 Node 사이드카가 따로 필요해 프로세스 2개 관리 — 경량화가 필요해지는 제품화 시점에 재검토

**프로세스 구조:**
```
Electron 메인 (Node)                          렌더러 (React)
├─ @codegate/agent (SDK 세션·도구)       ←IPC→  채팅 화면 · 승인 diff 모달
├─ kordoc (직접 import — 변환·편집)              디렉터리 트리 + 빌드 진행률
├─ 위키 빌드 파이프라인 (변환→enrichment→조립)     로그인·설정 화면
│    · enrichment = LLM API 직접 호출
│    · 빌더 코어 = 용휘 라이브러리 (사이드카/포팅)
└─ 워처 (chokidar → 증분 재빌드)
```

**패키지 경계: agent는 라이브러리, local은 Electron 앱.**
```
codegate-2026-agent   → npm 패키지 (@codegate/agent) — UI 없음, 순수 로직
codegate-2026-local   → Electron 앱 — 메인에서 @codegate/agent 임베드
```

## 1. 컴포넌트 분장

### 우창 — `codegate-2026-local`

| # | 컴포넌트 | 내용 | 규모 |
|---|---|---|---|
| L1 | **데스크톱 UI (렌더러)** | 3분할 레이아웃 — 좌: 채팅 목록 / 중앙: 채팅(스트리밍·인용 클릭 시 원본 열기) / 우: 디렉터리 트리(파일별 상태 아이콘: 대기·변환중·완료)+전체 진행률. **승인 diff 모달**. shadcn 컴포넌트 | 2일 |
| L2 | **로컬 빌드 오케스트레이터 (메인 프로세스)** | `chokidar` 감시 → 변경 문서만: **변환(민규 모듈) → enrichment(LLM API 호출, 동시성·재시도) → 빌더 코어(용휘 라이브러리) 실행** → `builds/` + `current.json` 원자 갱신. 진행률을 IPC로 렌더러에. 상태는 SQLite | 1.5일 |
| L3 | **kordoc 래퍼** | `parse/patch/generate/render(--reflow)` 함수화. 패치 전 `.bak` 백업 → 임시파일 → rename(원자적). exit 2(미적용 편집) 처리 | 0.5일 |
| L4 | **온보딩·인증** | **OAuth 로그인 (§3)** — 시스템 브라우저 + PKCE + 콜백 수신 + 토큰 safeStorage + 자동 갱신, 구독 상태 표시. 폴더 등록 + 스캔 미리보기 → 로컬 빌드 시작. **LLM API 키 설정 화면** (MVP: BYOK/팀 키) | 1일 |

### 성주 — `codegate-2026-agent`

| # | 컴포넌트 | 내용 | 규모 |
|---|---|---|---|
| A1 | **SDK 세션** | `query()` 래핑, 시스템 프롬프트(위키 AGENT_GUIDE 규칙: enrichment 근거 금지·인용 형식·"위키에서 확인되지 않음") | 1일 |
| A2 | **커스텀 도구 6종** | `wiki_search`(**로컬 위키 검색** — manifest 필터 + chunks/aliases, MVP는 SDK Grep/Read로 충분) · `read_original` · `render_page` · `patch_document` · `create_from_template` · `create_document`. 문서 조작 3종은 L3 주입 | 1.5일 |
| A3 | **승인 게이트** | `can_use_tool`: 읽기 허용 / patch·create → `approvalHandler` / 등록 폴더 밖 경로·파괴적 입력 거부 | 0.5일 |

> **위키 파이프라인 전체가 로컬이다** (기획안 D4·D7 v1.5) — 서버는 로그인·구독 확인에만 쓰인다.
> 문서·마크다운·위키는 자사 서버로 전송되지 않으며, 외부로 나가는 텍스트는
> LLM 제공자(enrichment·에이전트 추론)로 가는 것뿐이다. 구독 만료는 빌드·질의 시작 전에
> 확인해 사용자 문장으로 안내한다.

## 2. 레포 간 인터페이스 계약 (M0에서 확정)

`@codegate/agent`는 Electron 메인에서 임베드되고, 아래 `AgentEvent`가 **IPC 채널로 렌더러에 그대로 중계**된다
(`ipcMain` → `webContents.send('agent:event', e)`). 렌더러는 이벤트 타입별로 UI를 그린다 —
`approval_request`는 diff 모달, `tool_start`는 상태 배지, `text_delta`는 채팅 스트리밍.

```typescript
// @codegate/agent 공개 인터페이스
export interface AgentDeps {
  config: { roots: string[]; backendUrl: string; wikiDir: string };  // 로컬 위키 경로 (L2가 관리)
  auth: { getToken(): Promise<string> };              // L4 (safeStorage, 만료 시 자동 갱신)
  kordoc: KordocApi;                                  // L3
  approvalHandler: (req: ApprovalRequest) => Promise<boolean>;  // L1
}

export function createAgent(deps: AgentDeps): Agent;

export interface Agent {
  send(userText: string): AsyncIterable<AgentEvent>;
}

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; name: string; summary: string }
  | { type: "approval_request"; diff: string; target: string }
  | { type: "auth_error"; kind: "unauthenticated" | "subscription_expired" }
  | { type: "done"; citations: Citation[] };          // 【DOC-ID rev.N §섹션】

export interface KordocApi {                          // L3 시그니처
  parse(path: string): Promise<string>;
  patch(path: string, editedMd: string): Promise<PatchResult>;
  generate(md: string, outPath: string, preset?: string): Promise<void>;
  render(path: string, pages?: number[]): Promise<Buffer[]>;  // hwpx만
}
```

**외부 의존 (백엔드 API 스키마 — D+1까지 합의):**

| 의존 | 사용처 | 합의 당사자 |
|---|---|---|
| 서버 API (전부): `POST /auth/login` · `GET /me/subscription` | L4 | 우창 ↔ 용휘 |
| **빌더 코어 라이브러리** 호출 계약 (입력: md+enrichment / 출력: 불변 빌드) — 사이드카 or TS 포팅 | L2 | 우창 ↔ 용휘 |
| **변환 모듈** (kordoc 어댑터 → INPUT_CONTRACT md) npm 패키지 | L2 | 우창 ↔ 민규 |
| enrichment 프롬프트·스키마 (기존 wiki-builder `prompts/`·`schemas/` 재사용) | L2 | 우창 ↔ 용휘 |

> 검색·빌드 API는 없다 — 전부 로컬. 서버 API는 위 2개가 전부다.

## 3. 인증 플로우 (데스크톱 OAuth)

Supabase Auth 기준. **데스크톱 OAuth는 웹과 다르다** — 앱 내 `BrowserWindow`에 로그인 페이지를 띄우면
안 되고(구글이 embedded webview를 `disallowed_useragent`로 차단, 자격증명 탈취 위험),
**시스템 브라우저 + PKCE**가 표준이다.

```
[Electron 렌더러]        [메인 프로세스]           [시스템 브라우저]        [Supabase]
 "Google로 로그인" 클릭 ─▶ PKCE 생성
                          (code_verifier,
                           code_challenge, state)
                          shell.openExternal(url) ──▶ 구글 로그인·동의 ──▶ 인증
                                                  ◀── redirect ──────────  code 발급
                          콜백 수신 (아래 택1)
                          state 검증 (CSRF)
                          code + verifier ────────────────────────────────▶ 토큰 교환
                                                                       ◀── access + refresh
                          safeStorage 저장
 로그인 완료 ◀── IPC ────  GET /me/subscription ─────────────────────────▶ 플랜 확인
```

**콜백 수신 방식 — 택1 (M0에서 확정)**

| 방식 | 구현 | 장단점 |
|---|---|---|
| **A. 루프백 서버** (MVP 추천) | 메인에서 임시 `http://127.0.0.1:<랜덤포트>/callback` 서버 기동 → code 수신 후 즉시 종료 | 프로토콜 등록·서명 불필요, 개발 중 바로 동작. RFC 8252 권장 방식 |
| B. 커스텀 프로토콜 (딥링크) | `app.setAsDefaultProtocolClient('codegate')` → `codegate://auth/callback`. macOS는 `open-url` 이벤트, Win/Linux는 `second-instance`의 argv 파싱 | 브라우저→앱 복귀가 자연스러움. 단 OS별 분기·개발 중 등록 이슈 |

> 배포 시에는 B(딥링크)가 UX가 좋지만, **MVP는 A(루프백)로 시작**하고 패키징 단계에서 B를 추가하는 것을 권장.
> 둘 다 `redirectTo`를 Supabase 대시보드의 허용 목록에 등록해야 한다.

**필수 보안 요건**

- **PKCE 필수** — 데스크톱 앱은 public client라 client_secret을 보관할 수 없음. Supabase JS는 `flowType: 'pkce'`
- **state 파라미터 검증** — CSRF 및 콜백 하이재킹 방지
- **embedded webview 금지** — 반드시 `shell.openExternal`
- **토큰 저장은 `safeStorage`** — macOS Keychain / Windows DPAPI / Linux libsecret에 위임. 평문 파일 저장 금지
- **refresh 토큰 자동 갱신** — `auth.getToken()`이 만료를 감지해 갱신하고, 실패 시 `auth_error` 이벤트로 재로그인 유도

**이메일/비밀번호 로그인**도 Supabase가 동시 지원하므로, OAuth 프로바이더 설정 전이라도
개발·데모용으로 병행 제공한다 (같은 `getToken()` 인터페이스 뒤에 숨김).

## 4. 데스크톱 앱 UX (화면 4개)

```
[온보딩]  로그인(Google OAuth / 이메일 → 브라우저 왕복 → 플랜·만료 표시)
          → LLM API 키 설정 → 폴더 등록 → 스캔 미리보기
          → 로컬 빌드: 변환 ▸ enrichment(LLM 호출) ▸ 조립 — 단계별 진행률

[메인 — 3분할]
┌─────────┬──────────────────────────────┬─────────────────┐
│ 채팅 목록 │  중앙: 채팅                    │ 우측: 트리+진행률  │
│          │  질문 → 🔍 검색중(도구 배지)     │  📁 docs/        │
│ + 새 채팅 │  답변 + 【인용】← 클릭 시        │   ├ ✓ 계약서.hwp  │
│          │        원본 열기               │   ├ ⟳ 신청서.hwp  │
│          │                              │  빌드 ▓▓▓░ 78%   │
└─────────┴──────────────────────────────┴─────────────────┘

[승인 모달]  파일 생성·수정 시: 대상 경로 + diff + 근거 → [거부] [원본 보기] [승인]
             승인 → kordoc 실행 → 트리에 새 파일 반영 → 로컬 증분 재빌드 (루프 폐쇄)

[설정]  구독 상태 · 등록 폴더 관리 · Anthropic 자격증명
```

## 5. 마일스톤

| 마일스톤 | 내용 | 담당 | 완료 기준 (DoD) |
|---|---|---|---|
| **M0** (D+1) | 인터페이스 계약 + 서버 API 2종 + **빌더 코어 실행 방식(사이드카/포팅)** + **OAuth 콜백 방식(루프백/딥링크) 결정** | 전원 | 계약 TS 파일 커밋 + 빌더 실행 PoC + Supabase 프로바이더·redirectTo 등록 |
| **M1** (D+2) | Hello Agent: Electron 골격 + IPC + SDK 왕복 | 성주 A1 + 우창 L1 | 앱 채팅창에서 질문→스트리밍 답변 |
| **M2** (D+3) | 읽기 경로: **OAuth 로그인** + **로컬 빌드 파이프라인**(변환→enrichment→조립) + 로컬 검색 | 우창 L2·L4 + 민규 변환 + 용휘 빌더·API | 로컬 빌드 완료 후 질문 → **인용 있는 답변** |
| **M3** (D+4) | 쓰기 경로: kordoc 편집+승인 diff 모달 | 우창 L3·L1 + 성주 A2·A3 | 계약서 양식 채우기가 모달 승인 거쳐 동작 |
| **M4** (D+5) | 워처+루프 폐쇄+데모 시나리오 | 우창 L2 | 파일 수정 → 자동 재빌드 → 재질문 반영 |

M0 이후 mock(`KordocApi` 목·enrichment 목·픽스처 위키)으로 병렬 진행, M2·M3에서 실물 연결.

## 6. 리스크·규칙

- **자격증명 3종 구분**: ① 백엔드 토큰(OAuth access/refresh) — safeStorage, ② enrichment LLM 키(Gemini 등) — 설정 화면 입력·safeStorage, ③ Anthropic 자격증명(SDK 추론). 섞지 말 것
- **OAuth 보안 (§3)**: PKCE·state 필수, embedded webview 금지, 토큰 평문 저장 금지 — 리뷰 체크리스트로 고정
- **kordoc 제약** (기획안 §8): `fill` 사용 금지(오탐) → patch+명시 치환. `.hwp` render 불가 → md 표 구조로 판단. patch exit 2 = 부분 실패로 사용자에게 표시
- **승인 우회 금지**: A3 화이트리스트로 강제, `approvalHandler` 없이 쓰기 도구 실행 불가
- **원본 안전**: L3 백업→원자쓰기 규칙을 테스트로 고정 (패치 중 프로세스 킬 시나리오 포함)
- **401/402 UX**: 어떤 흐름에서든 로그인 만료·구독 만료가 사용자 문장으로 표시될 것 (silent fail 금지)
- **위키 갱신은 원자적으로**: 새 빌드는 임시 디렉터리에 조립·스키마 검증 통과 시에만 `current.json` 갱신 — 실패 시 이전 빌드 유지
- **enrichment 비용 통제**: 변경 문서만 재-enrichment (해시 비교), LLM 호출 동시성 제한·재시도·부분 실패 시 해당 문서만 보류
- **구독 검사 시점**: 빌드 시작 전 + 앱 시작 시. 클라이언트 검사임을 인지 (제품화 시 LLM 프록시로 강화)
