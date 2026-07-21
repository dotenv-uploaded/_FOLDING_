# CODEGATE 2026 — 제품 기획 개요 v2.0 (팀 계약 정합 개정판)

- 작성: 우창 · 위치: `codegate-2026-local/docs/기획안/`
- 성격: **파생 문서**. 팀의 정본은 성주 레포의 계약 문서다.
  - [`INTEGRATION_CONTRACT.md` v0.3](https://github.com/dotenv-uploaded/codegate-2026-agent/blob/main/docs/INTEGRATION_CONTRACT.md)
  - [`ADR 0004` 로컬 Agent·LLMWIKI와 로그인 권한 경계](https://github.com/dotenv-uploaded/codegate-2026-agent/blob/main/docs/adr/0004-local-agent-llmwiki-and-auth-boundaries.md)
  - [`LOCAL_RUNTIME.md`](https://github.com/dotenv-uploaded/codegate-2026-agent/blob/main/docs/LOCAL_RUNTIME.md)
- 충돌 시 **계약과 실행 중인 Backend `/openapi.json`이 우선**한다.

> **v2.0 개정 사유**: v1.x는 팀 계약을 확인하기 전에 이 대화 안에서만 작성돼,
> 런타임·도구 경계·컴포넌트 소유권이 실제 구현과 어긋나 있었다. 전면 개정했다.
> 폐기: TS 단일 런타임 · SDK 내장 도구 사용 · kordoc 파이프라인 · 프론트의 enrichment 직접 호출 ·
> "서버=로그인·구독만" · "오프라인 동작" 표현.

---

## 1. 제품

**흩어진 업무 문서를 자연어로 찾고, 지원되는 원본 파일을 안전하게 수정하는 지식 그래프 기반 파일 에이전트.**

핵심 원칙 (llm-wiki 설계):

> LLM 생성 정보(enrichment)로 후보를 넓히고, 보존된 원문(canonical exact quote)으로 검증하고,
> 문서 ID·revision·섹션으로 인용한다.

## 2. 사용자 흐름 2가지

| # | 흐름 | 내용 |
|---|---|---|
| 1 | **위치 찾기** | 질문 → ACL·status·효력기간 필터 → alias·chunk·verified relation 검색 → canonical quote 근거 → `[document_id rev.N §section_id]` 인용 답변 |
| 2 | **실제 수정** | 변경 요청 → exact diff preview + `plan_hash` → **사용자 승인** → backup → atomic replace → 재변환 → 재빌드 → 새 knowledge VERSION 공개 → Undo 가능 |

**승인 전 원본 write는 0건**이며, approve는 화면에 표시된 exact `plan_hash`만 받는다.

## 3. 아키텍처

### 3.1 배치

```
사용자 기기
├─ Electron 앱 〔우창 · codegate-2026-local〕
│    렌더러(React/shadcn) — UI · 인용 · diff 승인 · execution 폴링 · Undo
│    메인(Node, 얇음) — sidecar 수명주기 · OAuth 콜백 · safeStorage · 폴더 capability
│
└─ codegate-local sidecar (Python) 〔성주 · codegate-2026-agent〕  ← loopback bind
     Claude Agent SDK (app-owned read tools, 내장 Read/Edit/Write/Bash 비활성)
     LLMWIKI WikiBuildService 〔용휘 · codegate-2026-backend〕 in-process
     doc2md 클라이언트 〔민규 · codegate-2026-convert〕
     승인·backup·atomic replace·outbox·Undo·SQLite journal

클라우드
├─ Supabase Auth — 프론트가 직접 로그인 (OAuth/이메일)
├─ 배포 Backend 〔성주〕 — JWKS로 access token 검증, GET /auth/me
└─ Anthropic API — 모델 추론 (사용자 소유 ANTHROPIC_API_KEY)
```

### 3.2 로컬 디렉터리 (서로 겹칠 수 없음)

```
source/            사용자가 허용한 원본 파일 — 업무 데이터의 단일 정본
source-md/         doc2md가 만든 LLMWIKI 입력 Markdown — 파생 데이터
llmwiki-storage/   tenant/wiki current.json + 불변 build-<20 hex>
app-data/          SQLite · backup · Claude session · compatibility cache
```

source와 source-md를 같은 경로로 두면 frontmatter의 source SHA가 자기 자신을 참조하므로 금지.

### 3.3 한 번의 변경 (LOCAL_RUNTIME 기준)

```
사용자 명령
→ Claude가 app-owned read tools로 LLMWIKI와 현재 원본 확인
→ exact diff preview → 사용자 plan_hash 승인
→ 원본 backup + atomic replace
→ 정규화 Markdown 재변환 · source.sha256 + revision 갱신
→ WikiBuildService CAS build → native current.json 공개
→ build-ID compatibility cache 검증 → 새 근거 검색
```

## 4. 역할 (INTEGRATION_CONTRACT v0.3)

| 담당 | 레포 | 소유 |
|---|---|---|
| **우창** | `codegate-2026-local` | **Electron UI** — chat, 근거, diff, approve/reject, execution polling, retry, Undo. sidecar 수명주기·인증·OS capability |
| **성주** | `codegate-2026-agent` | FastAPI·Claude Agent SDK·side effect — 인증·ACL, agent, 승인, 실제 file write, 상태·outbox·version publish |
| **용휘** | `codegate-2026-backend` | `llm-wiki`·검색·지식 그래프 — 불변 manifest/chunks/links/enrichment와 index build |
| **민규** | `codegate-2026-convert` | 문서 변환 — source→canonical Markdown/assets/section mapping (doc2md) |

**다른 담당자의 저장소는 직접 수정하지 않는다.** Backend는 adapter와 계약 테스트로만 연결한다.

> UI는 계약 v0.3 표기로 "Next.js UI"였으나 **Electron 데스크톱 앱으로 확정**(2026-07-21).
> 계약서 표기 갱신을 성주와 협의 필요.

## 5. 핵심 설계 결정

| # | 결정 | 근거 |
|---|---|---|
| D1 | 단일 에이전트 루프 + 행위 시점 승인 게이트 (인텐트 라우터 없음) | 판단 이중화 제거. 안전은 의도 추측이 아닌 실제 도구 호출 시점에 강제 |
| D2 | enrichment는 보조, 근거는 canonical exact quote만 | RAG 환각을 구조로 차단. 인용 `[document_id rev.N §section_id]` |
| D3 | Claude Agent SDK를 **사용자 장치에서 실행** | 원본과 에이전트가 같은 기기. 단 모델 추론은 Anthropic API 호출 |
| D4 | **SDK 내장 Read/Edit/Write/Bash/Web 비활성** + `PreToolUse` allowlist | 내장 도구는 승인·ACL·Undo 경계를 우회 (ADR 0004) |
| D5 | 쓰기는 **exact diff → plan_hash → 승인 → backup → atomic replace → outbox → Undo** 경로만 | 결정적·감사 가능·복구 가능 |
| D6 | 실제 write는 **UTF-8 Markdown/TXT만**. PDF·DOCX·HWP는 verified round-trip writer 전까지 read-only | 무손실 왕복이 검증되지 않은 포맷의 파괴적 변경 방지 (§8 제안 참조) |
| D7 | 원본이 정본, 정규화 Markdown은 파생 | 책임이 한 방향으로 흐름 |
| D8 | LLMWIKI `current.json`이 **유일한 활성 포인터**, `build-<hex>`는 불변 | split-brain 방지. Backend는 build ID별 read cache만 |
| D9 | **로그인은 프론트가 Supabase Auth와 직접** 수행, Backend는 JWKS 검증만 | Backend가 password·refresh·service-role key를 보관하지 않음 |
| D10 | UI = **Electron 데스크톱 앱** (렌더러 React/shadcn) | 로컬 파일 capability·sidecar 관리·OAuth 콜백을 네이티브로 처리 |
| D11 | **Supabase 신원과 로컬 파일 capability 분리** | 로그인만으로 폴더 권한이 생기지 않음. capability는 OS 다이얼로그 범위에서 발생 |
| D12 | sidecar는 **loopback만 bind**, 명시적 CORS origin, 클라이언트 2개 분리 | cloud identity와 local capability 경계 유지 |
| D13 | LLMWIKI bundle은 **앱과 함께 배포·검증된 고정 bundle**만 실행 | 사용자 임의 폴더를 project root로 실행 금지 (신뢰 구성요소) |
| D14 | **"오프라인·로컬 전용"으로 표현하지 않음** | 모델 추론이 Anthropic API 호출이므로 정직한 표현 유지 |

## 6. MVP 범위

**포함**: 로그인(OAuth) → 폴더 선택 → doc2md 변환 → LLMWIKI 빌드 → 질문·인용 답변(위치 찾기)
→ 변경 요청·diff·plan_hash 승인 → md/txt 실제 수정 → 재빌드 → Undo

**제외**: 바이너리 포맷 쓰기, 멀티디바이스, 웹 UI, enrichment 기반 검색 확장(계약상 아직 로드 안 함),
구독·과금 강제

**리스크**

| 리스크 | 상태 | 완화 |
|---|---|---|
| 계약 문서가 옛 레포명(`codegate-2026-api@360ff41`) 핀 | 미해결 | 성주·민규와 갱신 협의 |
| 계약서 "Next.js UI" 표기 ↔ Electron 확정 | 미해결 | 계약 v0.4에서 갱신 |
| 바이너리 포맷 read-only 제약 | 완화안 있음 | §8 kordoc 검증 결과 제안 |
| 데모 교차연결 빈약 | 미해결 | 데모 질문 확정 후 코퍼스 큐레이션 |

## 7. 부록 — enrichment 비용 실측 (2026-07-21, M4 Pro 24GB)

로컬 LLM으로 지식 추출을 시도한 실측. enrichment 비용·방식 판단의 근거다.

- 테스트 코퍼스: 424파일/508MB, 실텍스트 **10.75M 토큰** (PMC 논문 XML 144개가 89%)
- gemma3:4b (Ollama): prefill 690 tok/s, **decode 66 tok/s**(병목), 출력/입력 1.22
- LLM 전량 추출: **59~102시간** — 병렬해도 메모리 대역폭 병목으로 무효 → 비현실적
- GLiNER(전용 NER): **1.42 청크/s → 전량 1.9시간**, CPU 거의 미사용, 교차파일 연결 실증
- **결론**: 생성(decode)을 없애는 구조가 유일한 해법. enrichment 비용 최적화 시
  엔티티 추출만 GLiNER로 분리하면 비용 1/20 (용휘 참고용)

## 8. 부록 — HWP 왕복 검증 제안 (2026-07-21, kordoc 4.2.4)

D6에 따라 HWP는 현재 read-only이나, 실제 프로젝트 hwp 3종으로 왕복을 검증했다.

| 테스트 | 결과 |
|---|---|
| 파싱 hwp → md | ✅ 조·항 구조·표 정확, 0.25초 |
| 서식 보존 패치 | ✅ **2.5MB 파일 바이트 크기 완전 동일**(2,636,288), 0.3초 |
| 패치 자기검증 | ✅ 패치 후 재파싱해 편집 md와 일치 확인, 미적용 시 exit 2 |
| md → hwpx 생성 | ✅ 구조 검증 통과 |
| `render --reflow` | ✅ SVG 렌더 (양식·레이아웃 비전 확인 경로) |
| `fill` 자동 채우기 | 🔶 오탐 있음 — 명시적 find/replace 권장 |

**제안**: "verified round-trip writer" 후보로 검토 가치가 있다. 채택 시 D6의 read-only 제약을
HWP/HWPX에 한해 완화할 수 있다. 성주·민규와 협의 사항.
