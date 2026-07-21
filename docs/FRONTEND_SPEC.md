# 프론트엔드 구현 스펙 v1.3

- 범위: `codegate-2026-local`(우창) + `codegate-2026-agent`(성주) — **로컬 데스크톱 앱(Electron)이 프론트엔드**
- 기준 문서: [기획안 v1.3.0](https://github.com/dotenv-uploaded/codegate-2026-backend/tree/main/docs/기획안)
- v1.1 변경: rclone/오프라인 사본 제거 · 로그인/구독 연동 추가 · 위키 빌드는 프론트가 API로 트리거
- v1.2 변경: **위키는 로컬에만 존재** (서버 무보관) — 검색이 로컬로 이동, L2에 산출물 회수 추가, zip 전송 프로토콜 확정
- v1.3 변경: **UI = CLI → 데스크톱 앱(Electron)** — 메인 프로세스가 SDK·kordoc·워처 호스트, 렌더러는 React(shadcn)

---

## 0. 기술 결정 (선행 합의)

**앱 셸: Electron + React(shadcn/Tailwind).**
- Agent SDK·kordoc이 모두 Node → **Electron 메인 프로세스가 곧 에이전트 호스트** (별도 데몬·사이드카 불필요)
- 팀의 Next.js/shadcn 경험 재사용 (렌더러 = Vite + React)
- Tauri는 Node 사이드카가 따로 필요해 프로세스 2개 관리 — 경량화가 필요해지는 제품화 시점에 재검토

**프로세스 구조:**
```
Electron 메인 (Node)                     렌더러 (React)
├─ @codegate/agent (SDK 세션·도구)  ←IPC→  채팅 화면 · 승인 diff 모달
├─ kordoc (직접 import)                    디렉터리 트리 + 빌드 진행률
└─ 워처·빌드 클라이언트 (chokidar·zip)      로그인·설정 화면
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
| L2 | **워처 + 빌드 클라이언트 (메인 프로세스)** | `chokidar` 감시 → **zip 업로드(changed/+prev_build/+files.json, multipart)** → 빌드 폴링 → **산출물 zip 회수·검증(sha256)·`builds/` 전개·current.json 갱신 → ACK**. 상태는 SQLite | 1.5일 |
| L3 | **kordoc 래퍼** | `parse/patch/generate/render(--reflow)` 함수화. 패치 전 `.bak` 백업 → 임시파일 → rename(원자적). exit 2(미적용 편집) 처리 | 0.5일 |
| L4 | **온보딩·인증 화면** | 로그인 화면(토큰 keychain 저장·구독 상태 표시), 폴더 등록 + 스캔 미리보기(포함/제외 확인) → 빌드 트리거. Electron `safeStorage` 사용 | 0.5일 |

### 성주 — `codegate-2026-agent`

| # | 컴포넌트 | 내용 | 규모 |
|---|---|---|---|
| A1 | **SDK 세션** | `query()` 래핑, 시스템 프롬프트(위키 AGENT_GUIDE 규칙: enrichment 근거 금지·인용 형식·"위키에서 확인되지 않음") | 1일 |
| A2 | **커스텀 도구 6종** | `wiki_search`(**로컬 위키 검색** — manifest 필터 + chunks/aliases, MVP는 SDK Grep/Read로 충분) · `read_original` · `render_page` · `patch_document` · `create_from_template` · `create_document`. 문서 조작 3종은 L3 주입 | 1.5일 |
| A3 | **승인 게이트** | `can_use_tool`: 읽기 허용 / patch·create → `approvalHandler` / 등록 폴더 밖 경로·파괴적 입력 거부 | 0.5일 |

> **위키는 로컬에만 존재한다** (기획안 D7 v1.3) — 검색·질의는 서버 없이 동작하고,
> 서버는 빌드할 때만 필요하다. 401/402(미인증/구독 만료)는 빌드 요청 시에만 발생하며,
> 도구가 에러로 삼키지 말고 CLI까지 올려 사용자에게 안내한다.

## 2. 레포 간 인터페이스 계약 (M0에서 확정)

`@codegate/agent`는 Electron 메인에서 임베드되고, 아래 `AgentEvent`가 **IPC 채널로 렌더러에 그대로 중계**된다
(`ipcMain` → `webContents.send('agent:event', e)`). 렌더러는 이벤트 타입별로 UI를 그린다 —
`approval_request`는 diff 모달, `tool_start`는 상태 배지, `text_delta`는 채팅 스트리밍.

```typescript
// @codegate/agent 공개 인터페이스
export interface AgentDeps {
  config: { roots: string[]; backendUrl: string; wikiDir: string };  // 로컬 위키 경로 (L2가 관리)
  auth: { getToken(): Promise<string> };              // L4 (keychain, 갱신 포함)
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

| API | 사용처 | 합의 당사자 |
|---|---|---|
| `POST /auth/login` · `GET /me/subscription` | L4 | 우창 ↔ 용휘 |
| `POST /builds` (multipart zip: changed/+prev_build/+files.json) | L2 | 우창 ↔ 민규·용휘 |
| `GET /builds/{id}` (status·progress) · `GET /builds/{id}/artifact` · `POST /builds/{id}/ack` | L2 | 우창 ↔ 용휘 |

> 검색 API는 없다 — 검색은 로컬 위키에서 A2가 직접 수행.

## 3. 데스크톱 앱 UX (화면 4개)

```
[온보딩]  로그인(플랜·만료 표시) → 폴더 등록 → 스캔 미리보기(261 포함/163 제외 확인)
          → zip 업로드 → 빌드 진행률 → 산출물 회수·전개·ACK

[메인 — 3분할]
┌─────────┬──────────────────────────────┬─────────────────┐
│ 채팅 목록 │  중앙: 채팅                    │ 우측: 트리+진행률  │
│          │  질문 → 🔍 검색중(도구 배지)     │  📁 docs/        │
│ + 새 채팅 │  답변 + 【인용】← 클릭 시        │   ├ ✓ 계약서.hwp  │
│          │        원본 열기               │   ├ ⟳ 신청서.hwp  │
│          │                              │  빌드 ▓▓▓░ 78%   │
└─────────┴──────────────────────────────┴─────────────────┘

[승인 모달]  파일 생성·수정 시: 대상 경로 + diff + 근거 → [거부] [원본 보기] [승인]
             승인 → kordoc 실행 → 트리에 새 파일 반영 → 증분 재빌드 (루프 폐쇄)

[설정]  구독 상태 · 등록 폴더 관리 · Anthropic 자격증명
```

## 4. 마일스톤

| 마일스톤 | 내용 | 담당 | 완료 기준 (DoD) |
|---|---|---|---|
| **M0** (D+1) | 인터페이스 계약 + 백엔드 API 스키마 4종 합의, 레포 스캐폴딩 | 전원 | 계약 TS 파일이 두 레포에 커밋 |
| **M1** (D+2) | Hello Agent: Electron 골격 + IPC + SDK 왕복 | 성주 A1 + 우창 L1 | 앱 채팅창에서 질문→스트리밍 답변 |
| **M2** (D+3) | 읽기 경로: 로그인+빌드 왕복(업로드→산출물 회수)+로컬 검색 | 우창 L2·L4 + 성주 A2 + 용휘 API | 실빌드 회수 후 질문 → **인용 있는 답변** (검색은 오프라인) |
| **M3** (D+4) | 쓰기 경로: kordoc 편집+승인 diff 모달 | 우창 L3·L1 + 성주 A2·A3 | 계약서 양식 채우기가 모달 승인 거쳐 동작 |
| **M4** (D+5) | 워처+루프 폐쇄+데모 시나리오 | 우창 L2 | 파일 수정 → 자동 재빌드 → 재질문 반영 |

M0 이후 mock(`KordocApi` 목·빌드 API 목·픽스처 위키)으로 병렬 진행, M2·M3에서 실물 연결.

## 5. 리스크·규칙

- **자격증명 2종 구분**: ① 백엔드 토큰(로그인) — Electron safeStorage, ② Anthropic 자격증명(SDK 추론) — MVP는 개발자 개인 키/구독, 환경변수로. 섞지 말 것
- **kordoc 제약** (기획안 §8): `fill` 사용 금지(오탐) → patch+명시 치환. `.hwp` render 불가 → md 표 구조로 판단. patch exit 2 = 부분 실패로 사용자에게 표시
- **승인 우회 금지**: A3 화이트리스트로 강제, `approvalHandler` 없이 쓰기 도구 실행 불가
- **원본 안전**: L3 백업→원자쓰기 규칙을 테스트로 고정 (패치 중 프로세스 킬 시나리오 포함)
- **401/402 UX**: 어떤 흐름에서든 로그인 만료·구독 만료가 사용자 문장으로 표시될 것 (silent fail 금지)
- **위키 전개는 원자적으로**: 새 빌드는 임시 디렉터리에 전개 후 검증(sha256) 통과 시에만 `current.json` 갱신 — 실패 시 이전 빌드 유지
- **ACK는 검증 후에만**: 산출물 무결성 확인 전 ACK 전송 금지 (서버가 삭제해버리면 복구 불가)
