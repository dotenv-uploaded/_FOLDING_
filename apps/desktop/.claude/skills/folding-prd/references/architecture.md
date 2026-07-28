# 아키텍처 — 데이터가 어디서 와서 어디로 가나

## 목차
1. [프로세스 지도](#프로세스-지도)
2. [문서가 위키가 되는 길](#문서가-위키가-되는-길)
3. [질문이 답이 되는 길](#질문이-답이-되는-길)
4. [문서를 고치는 길](#문서를-고치는-길)
5. [계약 경계](#계약-경계)
6. [캐시와 판 번호](#캐시와-판-번호)
7. [인증](#인증)
8. [구독 사용량](#구독-사용량)

## 프로세스 지도

`pnpm dev:integrated` 가 네 프로세스를 띄운다(`scripts/dev-integrated.mjs`).

| 프로세스 | 포트 | 무엇 |
|---|---|---|
| doc2md | 동적 | 문서 → 마크다운 |
| cloud-api | 8000 | Google OAuth (없으면 로그인만 실패, 스택은 산다) |
| Electron | — | 앱 (메인 + 렌더러) |
| 사이드카 | 동적 | 메인이 `SidecarSupervisor` 로 띄우고 감시 |

사이드카는 스크립트가 아니라 **앱이** 띄운다 — 등록 폴더가 정해져야 인자를 줄 수 있기
때문이다. 크래시하면 supervisor 가 되살린다.

## 문서가 위키가 되는 길

```
등록 폴더 파일
   ↓ indexRoot()          파일 목록·해시
   ↓ syncNormalizedInputs()   doc2md 호출 → source-md/DOC-xxx.md
   ↓ applyCrossLinks()    본문의 문서번호를 [..](DOC-x.md) 링크로
   ↓ 사이드카 재기동
   ↓ LLMWIKI stage()      청크·링크·매니페스트
   ↓ activate()           current.json 원자적 교체
활성 빌드
```

**중요한 성질 셋:**

- `source-md/*.md` 는 **앱이 소유**한다(`.codegate-input-owner.json`). 사이드카가 아니다.
- 위키 빌드는 `enrichment/approved/*.json` 을 **담을 뿐 만들지 않는다.** 요약을 만드는 건
  별도 단계다(`catalog.enrich_in_background()`).
- 사이드카는 활성 빌드가 있으면 **재시작해도 새로 만들지 않는다.** 그래서 수동 재빌드는
  `POST /api/v1/knowledge/rebuild` 로 명시적으로 요청한다.

## 질문이 답이 되는 길

```
렌더러 useChat.send()
   ↓ IPC chat:send
메인 sendChat()  ← 여기서 사용량 한도를 검사한다(보내기 전에)
   ↓ ChatService.stream()
   ↓ createFormFillAgent → 양식 요청이면 가로챈다
   ↓ createSidecarAgent  → 그 외
   ↓ POST /api/v1/chat/messages
사이드카 ChatService → AgentGateway → Claude Agent SDK
   ↓ 도구: knowledge_search · document_get · knowledge_document_read · source_file_read
   ↓ 구조화 출력(AgentDecision)
응답(단일 JSON, 스트리밍 아님) → AgentEvent 로 변환해 IPC 중계
```

**스트리밍은 아직 진짜가 아니다.** 사이드카가 단일 JSON 을 돌려주고, 앱이 그걸 한 번에
`text_delta` 로 내보낸다. UI 의 캐럿·점은 실제 토큰 흐름이 아니다.

## 문서를 고치는 길

```
에이전트 결정(intent=change, replace_exact 연산)
   ↓ 변경 계획 생성 — plan_hash 로 document_id·file_version_id·base_sha256 를 봉인
   ↓ 승인 모달 (ApprovalRequest) — 사용자가 diff 를 보고 결정
   ↓ 승인 시 plan_hash 를 그대로 되돌려 보낸다
   ↓ .bak 백업 → 임시파일 → rename(원자적)
   ↓ 위키 재동기화(pending event → process_pending)
```

한글은 이 경로에서 `kordoc` 을 쓴다 — `parseHwp` 로 마크다운을 얻어 앵커를 찾고,
`patchHwp` 로 되먹인다. `skipped` 가 하나라도 있으면 **실패로 올린다**(일부만 반영된
파일을 남기지 않는다).

## 계약 경계

`packages/contracts/src/index.ts` 하나가 세 경계를 정의한다. **두 저장소에 같은 파일이
커밋된다** — 여기를 고치면 양쪽을 맞춰야 한다.

1. `AgentDeps` / `Agent` / `AgentEvent` — 메인 ↔ 에이전트
2. `IPC` / `IPC_EVENTS` — 메인 ↔ 렌더러 (채널 이름이 곧 핸들러 목록)
3. 도메인 모델 — `Root` · `FileNode` · `BuildState` · `ChatMessage` · `UsageStatus` 등

IPC 를 추가할 때 손대야 하는 곳은 넷이다: `contracts`(채널) → `ipc.ts`(핸들러) →
`preload/index.ts`(구현) + `preload/api.ts`(타입) → 렌더러. **웹 데모 브리지
(`renderer/src/web/bridge.ts`)도 같은 인터페이스를 만족해야 한다** — 빠뜨리면 웹 빌드가
타입 오류로 깨진다.

## 캐시와 판 번호

출력이 달라지는 변경을 하면 해당 번호를 올린다. 안 올리면 **고친 코드가 실행되지 않는다.**

| 캐시 | 키 | 판 번호 위치 |
|---|---|---|
| doc2md 변환 결과 | 경로·mtime·크기 + 판 | `doc2md/app/cache.py` `_PIPELINE_VERSION` |
| 위키 입력(source-md) | 원본 sha256 + 판 | `input-sync.ts` `CONVERTER_GENERATION` |
| 위키 호환 렌더 | build_id + 판 | `llmwiki.py` `COMPAT_RENDER_VERSION` |
| enrichment | doc_id·sha·model·prompt_version | 빌더 설정 |

## 인증

```
앱 → cloud-api /auth/google/start   (PKCE challenge 생성은 앱이)
  → 브라우저에서 구글 로그인
  → 고정 콜백 http://127.0.0.1:47821/auth/callback
  → cloud-api /auth/google/exchange (code + verifier)
  → access/refresh 토큰 → safeStorage 에 보관
```

- 콜백은 **고정 포트·고정 경로**다. 구글 콘솔의 등록값과 정확히 같아야 한다.
- 로그인은 **한 번에 하나만** 진행한다. 새 시도가 이전 것을 걷어낸다(포트 점유 때문).
- `client_secret` 은 cloud-api 의 `.env` 에 있다. Desktop 클라이언트라도 구글 토큰
  엔드포인트는 이 값을 요구한다.

## 구독 사용량

```
사이드카 ResultMessage.total_cost_usd
  → ChatMessageResponse.usage.cost_usd
  → sidecar-agent onUsage 콜백
  → services.recordUsage() → SQLite usage_events
  → usageStatus() 가 원으로 환산해 계산
```

- 저장은 **USD**(제공자가 계산해 준 값), 환산은 표시 직전 한 곳에서만.
- 금액을 모르면 **기록하지 않는다.** 0 으로 적으면 사용량이 조용히 샌다.
- 한도 검사는 `sendChat()` 에서 **보내기 전에** 한다.
- 한도 ₩20,000(`USAGE_LIMIT_KRW`), 환율은 `CODEGATE_USD_KRW_RATE`(기본 1,400).
- 실측: 채팅 1회 ≈ $0.082 ≈ 115원 → 한도로 약 174회.
