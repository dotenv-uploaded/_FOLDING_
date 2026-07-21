# 프론트엔드 구현 스펙 v1.1

- 범위: `codegate-2026-local`(우창) + `codegate-2026-agent`(성주) — 웹 UI 없음, **CLI가 프론트엔드**
- 기준 문서: [기획안 v1.2.0](https://github.com/dotenv-uploaded/codegate-2026-backend/tree/main/docs/기획안)
- v1.1 변경: rclone/오프라인 사본 제거 · 로그인/구독 연동 추가 · 위키 빌드는 프론트가 API로 트리거

---

## 0. 기술 결정 (선행 합의)

**런타임: TypeScript/Node 18+ 단일 런타임.**
- kordoc이 Node 라이브러리 → subprocess 없이 직접 import
- Claude Agent SDK TS 정식 지원
- 런타임 하나 = 설치·배포 단순

**패키지 경계: agent는 라이브러리, local은 실행파일.**
```
codegate-2026-agent   → npm 패키지 (@codegate/agent) — UI 없음, 순수 로직
codegate-2026-local   → CLI 앱 — @codegate/agent 의존
```

## 1. 컴포넌트 분장

### 우창 — `codegate-2026-local`

| # | 컴포넌트 | 내용 | 규모 |
|---|---|---|---|
| L1 | **CLI REPL** | 채팅 입력/스트리밍 출력, 승인 프롬프트, 빌드 진행률 표시 | 1일 |
| L2 | **데몬 + 빌드 API 클라이언트** | `chokidar` 폴더 감시 → 변경 원본 업로드 → **위키 빌드 API 호출 → 상태 폴링**(진행률을 L1에 전달). 상태는 SQLite | 1일 |
| L3 | **kordoc 래퍼** | `parse/patch/generate/render(--reflow)` 함수화. 패치 전 `.bak` 백업 → 임시파일 → rename(원자적). exit 2(미적용 편집) 처리 | 0.5일 |
| L4 | **온보딩·인증** | `codegate login`(백엔드 로그인 → 토큰 keychain 저장, **구독 상태 확인·표시**), `codegate init`(폴더 등록, 스캔 미리보기 → 업로드+빌드 트리거) | 0.5일 |

### 성주 — `codegate-2026-agent`

| # | 컴포넌트 | 내용 | 규모 |
|---|---|---|---|
| A1 | **SDK 세션** | `query()` 래핑, 시스템 프롬프트(위키 AGENT_GUIDE 규칙: enrichment 근거 금지·인용 형식·"위키에서 확인되지 않음") | 1일 |
| A2 | **커스텀 도구 6종** | `wiki_search`(검색 API, **토큰 필수**) · `read_original` · `render_page` · `patch_document` · `create_from_template` · `create_document`. 문서 조작 3종은 L3 주입받아 호출 | 1.5일 |
| A3 | **승인 게이트** | `can_use_tool`: 읽기 허용 / patch·create → `approvalHandler` / 등록 폴더 밖 경로·파괴적 입력 거부 | 0.5일 |

> 위키 접근은 검색 API가 유일한 경로다 (로컬 사본·오프라인 모드 없음 — 기획안 D7).
> 401/402(미인증/구독 만료) 응답은 도구가 에러로 삼키지 말고 CLI까지 올려 사용자에게 안내한다.

## 2. 레포 간 인터페이스 계약 (M0에서 확정)

```typescript
// @codegate/agent 공개 인터페이스
export interface AgentDeps {
  config: { roots: string[]; backendUrl: string };
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
| 로그인 (토큰 발급·갱신) + 구독 상태 | L4 | 우창 ↔ 용휘 |
| 원본 업로드 | L2 | 우창 ↔ 민규 |
| **위키 빌드 트리거 + 빌드 상태(진행률)** | L2 | 우창 ↔ 용휘 |
| 검색 | A2 | 성주 ↔ 용휘 |

## 3. CLI UX 흐름

```
$ codegate login                      ← L4
  이메일/비밀번호 → ✓ 로그인됨 (플랜: Pro, 만료 2026-12-31)

$ codegate init                       ← L4 → L2
  📁 폴더: ~/Documents/사업 [등록]
  스캔: 261개 포함 · 163개 제외 → 확인? [Y/n]
  업로드 → 위키 빌드 요청... ▓▓▓░░ 62% (폴링)

$ codegate chat                       ← L1
  ● 빌드 62% — 아는 범위에서 답변합니다
  > 사업계획서의 콜라겐 주장 근거가 뭐야?
  🔍 위키 검색 중... → 원문 확인 중...
  답변... 【PMC10300442 rev.1 §Results 2】

  > 계약서 양식으로 자문계약서 만들어줘, 계약자는 하드사이언스
  ✏️  파일 생성 승인 요청
  ┌ 대상: docs/자문계약서_2026-08.hwp (양식 복제)
  │ - 수혜기업 ㅇㅇㅇ(이하 "계약자")
  │ + 수혜기업 ㈜하드사이언스(이하 "계약자")
  └ 승인? [y/N]
  ✓ 생성됨 → 재업로드 + 빌드 재호출 (루프 폐쇄)
```

## 4. 마일스톤

| 마일스톤 | 내용 | 담당 | 완료 기준 (DoD) |
|---|---|---|---|
| **M0** (D+1) | 인터페이스 계약 + 백엔드 API 스키마 4종 합의, 레포 스캐폴딩 | 전원 | 계약 TS 파일이 두 레포에 커밋 |
| **M1** (D+2) | Hello Agent: CLI ↔ SDK 왕복 | 성주 A1 + 우창 L1 | `codegate chat` 질문→스트리밍 답변 |
| **M2** (D+3) | 읽기 경로: 로그인+빌드 트리거+검색 | 우창 L2·L4 + 성주 A2 + 용휘 API | 실빌드에 질문 → **인용 있는 답변** |
| **M3** (D+4) | 쓰기 경로: kordoc 편집+승인 게이트 | 우창 L3 + 성주 A2·A3 | 계약서 양식 채우기가 승인 거쳐 동작 |
| **M4** (D+5) | 워처+루프 폐쇄+데모 시나리오 | 우창 L2 | 파일 수정 → 자동 재빌드 → 재질문 반영 |

M0 이후 mock(`KordocApi` 목·검색 API 목)으로 병렬 진행, M2·M3에서 실물 연결.

## 5. 리스크·규칙

- **자격증명 2종 구분**: ① 백엔드 토큰(로그인) — keychain 저장, ② Anthropic 자격증명(SDK 추론) — MVP는 개발자 개인 키/구독, 환경변수로. 섞지 말 것
- **kordoc 제약** (기획안 §8): `fill` 사용 금지(오탐) → patch+명시 치환. `.hwp` render 불가 → md 표 구조로 판단. patch exit 2 = 부분 실패로 사용자에게 표시
- **승인 우회 금지**: A3 화이트리스트로 강제, `approvalHandler` 없이 쓰기 도구 실행 불가
- **원본 안전**: L3 백업→원자쓰기 규칙을 테스트로 고정 (패치 중 프로세스 킬 시나리오 포함)
- **401/402 UX**: 어떤 흐름에서든 로그인 만료·구독 만료가 사용자 문장으로 표시될 것 (silent fail 금지)
