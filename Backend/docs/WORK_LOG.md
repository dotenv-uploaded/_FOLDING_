# 작업 로그

## 2026-07-23 — 실제 업무기록 9종의 검색·삭제·후속 빌드·Undo 검증

- 목적: 다운로드한 업무기록 묶음의 DOCX, HWP, HWPX, PDF, PPTX, XLSX를 실제 제품 경로로 변환·검색하고,
  승인 전 무변경과 승인 후 삭제·게시·Undo가 형식과 재시작에 관계없이 수렴하는지 확인
- 변경:
  - 문서 내용 편집 가능 여부와 승인 기반 원본 파일 수명주기 권한을 분리해 PDF 같은 read-only 형식도
    정확한 파일명 삭제 preview와 복원을 지원
  - SQLite schema v6의 삭제 tombstone에 승인 execution, source SHA와 삭제 전 graph를 기록하고 Undo가
    게시될 때까지 이후 모든 LLMWIKI stage·activation에 활성 tombstone 전체를 전달
  - 삭제 승인에 포함된 정확한 문서 ID의 graph edge만 제외하고, 원본 Markdown의 수동 링크·section
    anchor와 다른 깨진 링크는 Backend와 builder 양쪽에서 계속 거부
  - 단일 normalized input뿐 아니라 source-fragment 문서의 모든 조각을 사전 검증 뒤 격리·재시도·복원하고
    조각 descriptor를 restore candidate attestation에 사용
  - 승인된 삭제가 원본 이동 뒤 지식 게시에 실패해도 active knowledge를 recovery mode로 읽고, cache가
    없어도 source 부재를 허용해 quarantine 경로에서 동일 execution을 재시도할 수 있게 함
  - native pointer가 먼저 바뀌고 SQLite 완료 전에 종료된 삭제는 execution의 삭제 전 graph와 격리
    input을 다시 검증해 event만 멱등 완료하며, 삭제 target을 참조하는 enrichment는 복원 전까지 stale 처리
  - Claude locate trace는 선택·대화 이력 target도 동일 query의 검색 결과에 포함돼야 통과시키고,
    검증된 target 뒤에는 동일 query·동일 target의 evidence search만 허용. 정확한 파일명 query의 chunk
    ranking에서는 파일명 token을 제외해 요청한 사실 근거를 우선
- 영향: LLMWIKI build request와 graph validation, compatibility materialization, 다중 입력 lifecycle,
  active knowledge recovery, 삭제 outbox replay와 관련 회귀 테스트
- 검증:
  - 실제 9개 문서 모두 production input sync 변환, 정확한 파일명 검색 9/9와 HWP 본문 조회 성공
  - HWP 이름 변경 preview에서 승인 전 hash 불변, 승인 후 재parse 결과 반영과 Undo 뒤 원문 복구 확인
  - PDF 삭제 preview에서 승인 전 무변경, 승인 후 원본·검색 결과 제거, 실패 execution의 재시작 retry,
    peer normalized input hash 불변·삭제 대상 graph edge 0건과 Undo 뒤 원본 SHA·38개 관계 링크 복구 확인
  - 실제 PDF 삭제 게시 뒤 sidecar 재시작, 삭제 상태에서 무관한 HWP 수정·재빌드, PDF Undo·재빌드,
    HWP Undo까지 연속 성공. tombstone 1→0, pending/failed event 0건과 두 원본 SHA의 정확한 복구 확인
  - 실제 XLSX 파일명·`지연 일정, 위험 요소와 담당자` query가 해당 문서의 `리스크 · 2` 근거와 R-01~R-03,
    책임 팀, 08-03 변경 일정을 반환
  - 독립 최종 review에서 selected/history target의 `document_get` 단독 근거 우회를 발견해 동일 query의
    target 포함 검색을 필수화하고 generic chunk fallback을 제거. 보완 뒤 blocker/high/medium 0건 확인
  - 보완된 최종 코드로 같은 실제 XLSX 질문을 다시 실행해 `location_result`, 정확한 문서 ID와 리스크
    표 근거가 반환되는 것을 확인
  - XLSX merge metadata 기반 임시 사본 변환과 cache/input marker 마이그레이션 뒤 실제 파일의 반복
    관계 문장 8→1, 리스크 표의 R-01~R-03 각 행 1회와 source SHA 불변 확인
  - Backend Ruff format/check, mypy, pytest 275개 통과(coverage 84%); Electron typecheck, Vitest 148개
    통과·선택적 integration 1개 skip, production build 성공
  - doc2md 전체 Ruff check와 Python 3.12 pytest 117개, LLMWIKI builder Ruff check와 pytest 47개 통과
- 전달 상태: 로컬 구현과 검증 완료. 원본 ZIP은 변경하지 않았고 commit·push·배포는 수행하지 않음
- 남은 일: 앱은 ZIP 자체가 아니라 압축 해제한 폴더 등록을 지원한다. 서명된 설치본의 실제 사용자 승인
  클릭 smoke와 ZIP 직접 가져오기는 별도 범위다.

## 2026-07-22 — 승인 기반 파일 삭제·일괄 계약서 삭제와 query trace 복구

- 목적: 정확한 파일 삭제, 계약서 일괄 삭제와 직전 조회 기반 담당자 변경을 승인·복구 가능한 흐름으로
  완성
- 변경:
  - search target이 첫 결과가 아니어도 검증된 tool result 안에 있으면 실제 query로 안전하게 rebind
  - `delete_file`/`restore_file` typed operation, source 부재 sentinel, SHA 재검사, backup, journal,
    atomic delete/restore와 restart recovery 추가
  - LLMWIKI local/native candidate에서 문서 제거·retained snapshot 복원과 CAS publish 지원
  - ChatService의 exact filename 삭제와 최대 20개 계약서의 파일별 plan 생성, Electron의 순차 개별
    승인·거부, 삭제 전용 경고와 완료 안내 연결
- 영향: agent trace validation, chat response, change state, safe file store, LLMWIKI adapter, Electron
  sidecar contract와 승인 UI
- 검증:
  - Backend Ruff와 mypy 통과, 전체 pytest 259개 통과, line coverage 83%
  - Electron TypeScript typecheck와 Vitest 141개 통과, 1개 선택적 integration fixture skip
  - 잘못된 plan hash 무변경, 외부 edit race 보존, 승인 뒤 source·wiki 제거, 응답 유실 복구용 stable
    execution 식별, Undo 뒤 bytes·mode·wiki 복원 E2E 통과
  - 독립 보안 재검토에서 권한, 일괄 Undo, 응답 유실과 외부 edit race 보완 뒤 blocker/high 없음
- 전달 상태: 로컬 구현과 검증 완료. commit, push, PR, 배포는 수행하지 않음
- 결정: 최신 orchestration 문서를 검토했으나 LangChain/LangGraph를 추가하지 않음. 현재 Claude SDK의
  typed output과 app-owned approval/outbox/journal이 상태 소유권을 명확히 유지하며 중복 checkpoint 계층은
  운영 위험만 늘림
- 남은 일: 서명된 설치본의 실제 사용자 HWP 삭제·Undo smoke와 production 변경은 별도 명시 승인 뒤 수행

## 2026-07-22 — Claude 구조화 결정 2.1과 실제 대화 회귀 보강

- 목적: semantic field 변경과 후속 삭제가 간헐적으로 `AGENT_RESULT_INVALID`가 되는 schema·validator
  간극을 제거하고 파일 삭제 요청에는 실제 지원 범위를 분명히 안내한다.
- 변경:
  - SDK-facing output을 상태별 typed union으로 바꿔 `ready_change`에 target, source hash와 operation을
    필수화하고 non-ready 상태에서 change 필드를 제거
  - enum casing의 공식 예외만 bounded normalization하고 validation log에서 입력값과 문서 본문 제외
  - semantic field 변경과 conversation history 기반 삭제를 prompt eval corpus에 추가하고, 한국어 조사가
    붙은 stable document ID도 최근 user message에서 정확히 복원
  - 모델이 source 문맥을 넓혀 선택한 치환은 사용자 명시 replacement만 남도록 exact operation을
    축소하고, 최종 결과가 같은 문맥 확장만 prompt eval에서 동등하게 판정
  - 파일 자체 삭제와 문서 내부 항목 삭제를 앱 경계에서 먼저 구분해, 모델이 파일 삭제를 빈
    `replace_exact` 내용 변경으로 바꾸지 못하게 차단
  - 최근 history의 가장 가까운 단일 stable ID만 direct routing hint로 허용하고 복수 ID는 검색으로
    되돌리며, validation log의 임의 JSON key도 정규화해 비식별화
  - 사실상 동률인 정책 검색에서는 작은 authority prior로 규정을 우선하되, 명시적인 매뉴얼 query와
    exact filename 우선순위는 유지
- 영향: Claude Agent SDK output schema·prompt fingerprint, prompt eval, chat 오류 안내와 검색 ranking.
  기존 approval, atomic write, backup과 Undo 경계는 유지한다.
- 검증:
  - agent prompt/runtime/chat 집중 pytest 103개, 관련 Ruff와 mypy 통과
  - 실제 Claude Sonnet read-only canary에서 semantic field 변경, 대화 후속 삭제와 파일 삭제 거부
    3/3 통과
  - 전체 Ruff format/check, mypy 55개 source file, pytest 255개 통과, line coverage 85%
  - 독립 review의 blocker/high finding은 없었고 file-delete 경계, 복수 history ID, validation log 관련
    medium finding 3건을 모두 회귀 테스트와 함께 보완
  - Electron supervisor가 sidecar를 새 코드로 재기동한 뒤 health `ok`, agent와 persistence available을
    확인. 실제 HWP field 변경은 approval preview를 만들고 즉시 reject했으며 원본 hash 일치와 execution
    0건을 확인. 파일 자체 삭제 HTTP 요청은 plan 없이 `UNSUPPORTED_AGENT_REQUEST`로 종료
- 전달 상태: 로컬 구현, 검증과 실행 중 개발 앱 반영 완료. 기존 작업 트리에 다른 미커밋 변경이 함께
  있어 커밋·푸시는 수행하지 않았다.
- 결정: LangChain/LangGraph는 현재 단일 결정 schema 문제에 추가 보장을 주지 않아 도입하지 않는다.
  파일 자체 삭제는 recoverable delete journal과 승인 UI가 생길 때 별도 operation으로 설계한다.

## 2026-07-22 — Railway Google OAuth와 고정 loopback callback 활성화

- 목적: Electron 앱이 Railway Backend의 실제 Google OAuth를 사용하고 callback을
  `http://127.0.0.1:47821/auth/callback`으로 고정한다.
- 변경: Railway Backend를 `auth_mode=google`로 전환하고 Google credential과 별도 session pepper를
  secret 변수로 설정했다. `codegate_cloud_api@a0553b5` 소스를 Backend package에 포함해 private Git
  clone과 build credential 의존성을 제거하고, runtime image에는 build tool을 남기지 않는 multi-stage
  Docker build로 전환했다. Electron `.env`는 Railway API와 고정 loopback redirect를 사용한다.
- 검증: Docker image build, Ruff format/check, mypy 54개 source file, pytest 220개가 통과했고 coverage는
  85%다. Railway deployment `87a5ec2d-1f07-4e5b-8e91-14238e458336`이 성공했다. 공개 health는
  `status=ok`, `auth_mode=google`, converter·agent·persistence available을 반환했고 OAuth start 응답은
  Google host, 정확한 redirect URI, PKCE S256과 1회용 state를 포함했다.
- 전달 결과: Railway 데모는 `development + google`로 실행한다. 기존 demo knowledge package에 production
  필수 index artifacts가 없어 `production` readiness는 의도대로 503을 반환했으며 이를 완화하지 않았다.
- 남은 작업: 검증된 FTS·vector·graph index artifacts가 있는 knowledge release를 volume에 배치한 뒤
  `CODEGATE_ENVIRONMENT=production`으로 전환한다.

## 2026-07-22 — Claude 공급자 오류 분류 수정

- 목적: API 크레딧 부족이 구조화 결과 실패로 표시되는 오진을 제거한다.
- 변경: SDK ResultMessage의 크레딧, 인증, rate limit, 5xx, 실행 예산과 실제 구조화 결과 실패를
  서로 다른 안전한 오류 코드로 분류하고 비밀값 없는 진단 로그와 회귀 테스트를 추가했다.
- 영향: Claude Agent SDK gateway와 사용자 오류 안내.
- 검증: 실제 최소 SDK 호출로 HTTP 400의 원인이 크레딧 부족임을 확인했고, 실행 중 sidecar HTTP가
  `AGENT_CREDIT_EXHAUSTED`를 반환했다. Ruff format/check, mypy 48개 source file, pytest 220개 통과.
- 전달 결과: 로컬 수정과 실행 검증 완료. 커밋·푸시는 하지 않았다.
- 남은 작업: 크레딧이 있는 키를 적용한 뒤 구조화 응답과 승인 기반 파일 수정 E2E를 다시 실행한다.

## 2026-07-22 — Railway Backend·doc2md 통합 데모 배포

- 목적: Claude Sonnet Backend와 doc2md v0.2를 하나의 공개 API 뒤에서 Railway로 검증
- 변경:
  - Railway `codegate-backend/backend` 서비스와 `/data` 영구 volume 구성
  - 같은 project에 private `doc2md` service를 추가하고 authenticated bytes transport로 연결
  - development/demo auth, Claude Sonnet, 프런트 CORS, 읽기 전용 문서 권한을 환경변수로 설정
  - Railway start command가 `$PORT`를 literal로 전달하던 문제를 `sh -c`와 `${PORT:-8000}`으로 수정
  - 외부 Swagger CDN 없이 endpoint를 보여주는 자체 `/docs`와 root redirect 추가
  - start command, docs 화면과 배포 topology 회귀 테스트·장애 기록 추가
- 검증: Railway 두 image build와 healthcheck, doc2md synthetic bytes 변환의 SHA·section·version,
  Backend `converter_available=true`, `/docs` 200, anonymous 401, demo read-only scope와 실제 Sonnet
  근거 요약 HTTP 200을 확인했다. Ruff format/check, mypy와 pytest 211개도 통과했고 coverage는 85%다.
- 전달 상태: `backend`와 `doc2md` 모두 `SUCCESS`/`RUNNING`이다. 공개 주소는
  `https://backend-production-724c.up.railway.app` 하나이고 doc2md public domain은 제거했다.
- 결정: 운영 형태는 Backend public gateway + private Converter process로 두되 사용자에게는 단일
  API로 제공한다. Supabase·실 corpus가 준비되기 전에는 development/demo auth와 write 0건을 유지한다.
- 남은 일: Supabase custom claims와 실제 volume knowledge release를 준비한 뒤 production fail-closed
  설정으로 전환하고 대형 PDF/HWP CPU 성능을 측정한다.

## 2026-07-22 — Claude Agent SDK prompt contract와 근거 검증 강화

- 목적: Claude Agent SDK의 문서 routing·exact change prompt를 현재 turn의 실제 도구 근거와 결박하고,
  prompt injection·stale session·모호한 실패가 변경 preview 경계까지 통과하지 못하게 강화
- 변경:
  - 역할, instruction hierarchy, trust, current-turn evidence, tool workflow, failure, 경계 예시와
    structured output을 분리한 prompt contract 2.0 도입
  - `ready`, `needs_clarification`, `not_found`, `tool_error`, `unsupported` outcome과 source SHA-256,
    cross-field Pydantic validator 추가
  - MCP 도구 설명·input schema·read-only annotation과 versioned untrusted provenance envelope 보강
  - SDK가 반환한 `UserMessage` tool result만 수집하고 query, 검색 결과 target, `document_get`, source read,
    graph version, source kind·hash·payload를 구조화 결정과 대조
  - assistant-authored tool result, 근거 없는 `not_found`·`tool_error`, selected/verified target 불일치,
    사용자 요청에 없는 replacement, stale source hash를 preview 전에 거부
  - prompt/model/SDK/tool/output schema/AgentGuide/graph/authorization fingerprint와 TTL이 같고 최신 run이
    성공한 session만 resume하도록 SQLite schema v5와 자동 migration 추가
  - 고정 7-case corpus, model-pinned read-only canary runner, production model ID 필수 설정과 ADR 추가
- 영향 범위: agent prompt·gateway·MCP tool server, chat application boundary, session state, production config,
  prompt eval·테스트·배포 문서
- 검증:
  - Ruff format/check 통과
  - mypy strict 46개 source file 통과
  - pytest 206개 통과, line coverage 85%
  - prompt corpus 7개를 API 호출 없이 load·list하고 wheel·sdist build 성공
  - v4 agent run schema의 session 보존 v5 migration, failed/running session rotation, tool trace/result 위조·순서·
    provenance·빈 검색·source hash 회귀 테스트 통과
  - 독립 최종 diff review에서 blocker/high finding 없음
- 전달 상태: 구현 commit `e878bf5`를 `feat/claude-prompt-hardening`에 push하고
  https://github.com/dotenv-uploaded/codegate-2026-agent/pull/9로 전달했다. GitHub Actions run
  `29852666362`가 성공한 뒤 `main`의 `852f450`으로 squash merge했다. 공유 `main` checkout과 Production
  migration·배포는 건드리지 않았다.
- 결정:
  - prompt 문구만 신뢰하지 않고 구조화 schema, current-turn tool trace, application hash·approval 경계로
    같은 계약을 중복 검증
  - SDK 내부 `StructuredOutput`만 별도 control tool로 허용하고 네 개 read-only CODEGATE 도구 외 built-in
    file·shell·web 도구는 계속 차단
  - session 연속성보다 prompt·권한·graph snapshot 일치와 실패 뒤 회전을 우선
- 남은 일:
  - 현재 환경에 Anthropic API key와 고정 model ID가 없어 live canary는 미실행. credential이 준비되면
    고정 corpus를 지정 model로 실행하고 latency·cost·tool sequence 결과를 기록
  - SDK transcript 물리 삭제와 보존 기간은 사용자 동의가 필요한 별도 lifecycle 정책으로 결정

## 2026-07-22 — 최신 민규 converter·성주 Backend·용휘 LLMWIKI 실제 연결

- 목적: 팀 GitHub와 로컬 checkout을 전부 대조하고 민규의 최신 변환기와 용휘의 최신
  LLMWIKI를 Backend 승인·재발행·Undo 경로에 실제 process로 연결
- 기준:
  - `codegate-2026-convert@30e6814`
  - `LLMWIKI@acf94f7`
  - Backend branch `fix/llmwiki-server-v2-compat`
- 변경:
  - `server-v1` legacy ingest와 `server-v2` aggregate/fragments ingest를 strict parser 하나로
    정규화하고 mode·path·chunk number·fragment SHA를 candidate 승인 증거에 결박
  - `sections` 단일 fragment만 승인·retry·Undo 쓰기를 허용하고 `source-fragments`는 검색 전용으로
    materialize하며 직접 queued event도 실패 폐쇄
  - doc2md body의 정확히 하나인 선행 H1을 활성 LLMWIKI title로 정규화하고 누락·중복 H1 거부
  - compatibility cache suffix를 `codegate-v3`로 올리고 실제 v2 ingest, aggregate 변조, path 변경,
    다중 fragment read-only와 H1 회귀 테스트 추가
  - 현재 pin과 동기·비동기 converter 경계, 쓰기 가능 범위를 README·통합 계약·handoff·ADR에 반영
- 검증:
  - converter Python 3.12 격리 환경에서 pytest 104개 통과
  - LLMWIKI wiki-builder pytest 39개, local-runtime pytest 14개와 각 Ruff gate 통과
  - Backend focused Ruff·mypy와 pytest 33개 통과
  - Backend 전체 Ruff format/check, mypy, pytest 152개 통과, line coverage 84%
  - 독립 diff review에서 server-v2 계약·candidate 승인 경계 blocker/high finding 없음
  - 세 컴포넌트 실제 runtime 연결에서 `ingest checksum is invalid`, 보완 뒤 H1/title 불일치를 각각 재현
  - 같은 실패 execution을 retry해 `build-99801fba8b94ffc5f1a2`에서
    `build-4147f2b0ed2a29246605`로 공개하고 `3년` 근거 재검색 성공
  - Undo execution `exec_308416a4ca9e4ba19f662b09aaf1e2e5`가
    `build-465cd13e13f397a818d7`을 공개하고 원본 backup SHA와 `1년` 근거를 복구
  - Undo 뒤 `/health`는 `status=ok`, pending/failed/stale sync event 모두 0
- 전달 상태: branch `fix/llmwiki-server-v2-compat`를 push하고 PR #8을 생성했다. 구현 commit 기준
  GitHub Actions CI가 성공했으며, 이 전달 기록 commit의 required check를 다시 확인한 뒤 squash
  merge한다. production 배포는 수행하지 않는다.
- 결정:
  - format 검사를 제거하지 않고 pin과 allowlist를 함께 유지
  - aggregate-only 비교를 거부하고 단일 fragment 쓰기만 기존 journal의 원자성 범위로 인정
  - LLMWIKI local-runtime `/convert/async` 최초 수집과 Backend `/v2/convert` outbox writer는 desktop
    orchestration에서 직렬화
- 남은 일:
  - 다중 source-fragment 편집이 필요해지면 fragment-set snapshot·생성/삭제 journal·원자 Undo 구현
  - pinned schema digest와 input dirfd immutable snapshot으로 app-owned storage/input 신뢰 경계 강화
  - 우창 desktop orchestration에서 converter writer 직렬화와 설치 bundle smoke 적용

## 2026-07-21 — Backend 저장소 기반과 read-only 수직 기능

- 목적: 성주 담당 FastAPI 저장소를 독립 실행 가능하게 만들고, 팀 산출물이 오기 전에도 `llm-wiki` 계약과 위치 검색을 검증
- 변경:
  - Python 3.12, uv, FastAPI 프로젝트와 Docker/Railway 설정 추가
  - 합성 문서 5개, manifest/chunks/links/schema/checksum fixture 추가
  - `source://` allowlist resolver와 경로 이탈 차단 추가
  - knowledge package 무결성 검사와 metadata 우선 검색 추가
  - checksum coverage와 제한된 TOML schema를 검증한 `AGENT_GUIDE.md` 정책을 Claude session 시작 지침으로 정규화
  - Claude Code용 `CLAUDE.md`에서 개발 계약 `AGENTS.md` import
  - public-only anonymous ACL과 relation ACL, source·chunk SHA-256 검증 추가
  - Claude local config 격리와 auto memory·prompt history 비활성화
  - health, chat location, document detail API 추가
  - Claude Agent SDK dependency, deny-by-default client options, read-only MCP tools와 `PreToolUse` hook 추가
  - 역할·통합 계약·기술 결정·CI·CODEOWNERS 추가
  - 원본 `source://` 참조, 증분 변환 뒤 병렬 index fan-out, 검증 barrier와 graph version 원자적 공개를 ADR로 확정
  - setup-uv action tag 해석 실패 원인과 수정·검증을 트러블슈팅 기록으로 남김
- 검증:
  - Ruff format/check 통과
  - mypy strict 통과
  - pytest 18개 통과, line coverage 91%
  - Claude Agent SDK가 포함된 Python 3.12 Docker image build와 container import 통과
  - 컨테이너 health와 `개인정보 보관 기간 문서 어디 있어?` 검색 HTTP 요청 성공
  - draft PR #1의 GitHub Actions 성공
- 전달 상태: `agent/backend-foundation` branch push, https://github.com/dotenv-uploaded/Backend/pull/1 draft PR 생성. merge·배포는 수행하지 않음
- 결정:
  - Python-heavy agent/KG/file workflow이므로 FastAPI를 별도 backend로 유지
  - `llm-wiki`를 검색 source of truth로 사용하고 pgvector 중복 적재는 보류
  - LangGraph와 MCP는 단일 agent/tool 흐름이 부족할 때만 추가
  - OS shortcut·symlink 대신 manifest source URI를 사용하고 부분 index update는 active version으로 공개하지 않음
- 남은 일: Claude model session의 API 연결과 실제 allow/deny 통합 검증, Supabase JWT ACL adapter, diff preview, approval/write/Undo, converter·graph sync, Supabase/Railway runtime 결정

## 2026-07-21 — 승인·원본 수정·비동기 knowledge publish 수직 기능

- 목적: 성주 담당 전체 범위를 합성 fixture로 끝까지 실행하고, 받은 전체 흐름도의 원문 근거·동시 색인·승인 후 write 조건을 코드로 강제
- 변경:
  - conversation, message, agent run, immutable change plan, approval, execution, file version, audit, idempotency, journal, outbox, sync task, knowledge version SQLite 상태 추가
  - Claude Agent SDK 실제 async client, Pydantic structured output, principal·conversation 기반 server-owned session과 timeout·disconnect 검증 추가
  - Supabase JWKS JWT 검증과 custom access token hook migration, tenant/read/write claim mapping 추가
  - exact diff와 domain-separated plan hash, ACL·base hash 재검사, dirfd/O_NOFOLLOW atomic replace, immutable backup, crash recovery와 Undo 추가
  - source symlink 대신 checksummed `references/*.source.json` 추가
  - manifest status·효력 기간·ACL filter와 alias expansion 추가
  - chunk의 `section_id`, 전체 `heading_path`, `embedding_text`, file version 검증과 canonical section exact quote evidence gate 추가
  - `[document_id rev.N §section_id]` 구조화 citation과 model 문장 대신 canonical quote 기반 답변 추가
  - 변경 outbox 뒤 converter, FTS, vector, graph 병렬 fan-out, candidate barrier, immutable release, CURRENT CAS와 request snapshot pinning 추가
  - `codegate-2026-api/services/doc2md` v0.1.0 read-only audit 후 stable ID·source URI override와 stale source hash 거부 adapter 연결
  - approve·Undo를 `202 + Location`으로 바꾸고 lifespan sync worker, execution polling field와 retry-sync 추가
  - 외부 watcher가 전체 본문·base hash·단일 exact operation으로 변경 계획만 만들고 표준 승인/outbox 흐름을 재사용하는 source-sync API 추가
  - source 무변경 storage 오류 뒤 consumed plan·Undo row를 새로 만들지 않고 기존 execution journal을 same/new idempotency key로 재개하도록 보완
  - 일시적 state/pipeline 예외를 bounded backoff로 재처리하고 stale pending을 health에 노출하며 immutable index readiness를 load 시 cache
  - Supabase JWT unknown-`kid` negative cache·JWKS 최소 refresh 간격/timeout과 Authorization header·pre-auth IP 제한 추가
  - Claude session UUID 생성·resume 검증, anonymous session 비지속, 실제 chunked body 크기 제한 추가
  - candidate 전체 file/directory fsync 뒤 release rename, revision-bound multi-chunk ID와 link evidence 동시 갱신 추가
  - Railway volume 자동 경로 mapping과 writable probe, production Supabase·Claude·doc2md·no-demo fail-closed validation 추가
  - `.env.example`, README, 역할·팀 handoff·통합·배포 계약과 ADR 0003 갱신
- 검증:
  - Ruff format/check 통과
  - mypy strict 통과
  - pytest 88개 통과, line coverage 86%
  - wrong hash, stale plan, ACL revoke, symlink, concurrent plan, crash-after-replace, fan-out failure/retry, Undo conflict와 byte 복구 검증
  - alias/effective filter, duplicate anchor, wrong section quote, heading/file version mismatch, configured doc2md 호출 검증
  - production unsafe mode, volume 밖 path, missing mount와 Supabase migration 정적 권한 계약 검증
  - OpenAPI 10개 path, mutation idempotency header, response enum과 stale health schema 검증
  - Claude Agent SDK가 포함된 Docker image build, container health와 canonical citation 검색 HTTP smoke test 통과
  - approval·Undo no-effect write failure 재개, transient worker self-wake, stale health, unknown-`kid` refresh throttle 회귀 검증
- 전달 상태: `80ba647`을 `agent/backend-foundation`에 push하고 기존 draft PR #1을 전체 범위로 갱신. GitHub Actions run `29817682242` 성공. merge·Supabase/Railway 적용·production 배포는 수행하지 않음
- 결정:
  - 인용 문장은 model 생성이 아니라 검증된 canonical quote로 조립해 사실 근거를 fail-closed로 유지
  - browser shortcut/symlink 대신 portable source reference JSON 사용
  - polling-first로 HTTP timeout과 converter latency를 분리하고 WebSocket은 실제 UI 필요가 생길 때만 추가
  - single-volume Railway MVP는 SQLite를 유지하고 multi-replica 전에는 Postgres·외부 artifact store 전환을 필수화
  - HWP/PDF/DOCX는 parse 가능 여부와 무관하게 verified round-trip writer 전까지 read-only
- 남은 일:
  - 민규의 stable `section_id`·원본 위치 mapping·파일별 read/write capability를 포함한 실제 converter 결과를 받고 adapter 교체
  - path-only `doc2md`를 Backend와 같은 filesystem namespace에 둘지, authenticated bytes/object URI를 받는 v0.2 계약으로 바꿀지 확정
  - 용휘의 실제 vector·Kuzu·LanceDB·enrichment/update adapter를 연결하고 immutable publish barrier까지 통합 검증
  - 우창의 chat·diff 승인/거절·Undo UI와 local watcher를 OpenAPI 및 `source-sync-plans` 승인 흐름에 연결
  - Anthropic server key로 Claude Agent SDK session·structured output·deny-by-default tool 정책을 실제 호출 smoke test
  - 팀 Supabase project에 migration과 Custom Access Token Hook을 적용하고 실제 JWT·tenant ACL·권한 회수 시나리오 검증
  - Railway persistent volume과 production 환경변수를 설정하고 single-replica 배포 후 source write·재기동 복구·health smoke test
  - 실제 팀 산출물로 검색 근거, 승인 전 무변경, 승인 후 원본·FTS·vector·graph 동시 반영, 부분 실패 비공개, retry·Undo·stale 거부 E2E 검증
  - 통합 결과를 draft PR에 반영하고 전체 CI·배포 smoke 통과 후 review-ready 전환, 팀 검토와 merge 진행

## 2026-07-21 — 로컬 Claude·LLMWIKI runtime과 로그인 경계 통합

- 목적: 다운로드한 사용자 PC에서 Claude Agent SDK와 LLMWIKI를 함께 실행하고, 파일 읽기·승인 수정·지식 재발행을 로컬 경계 안에서 끝내며 Frontend 로그인 계약을 확정
- 변경:
  - `codegate-local` CLI, loopback bind, 고정 origin CORS, 로컬 data/source/input/storage root 격리와 실행 가이드 추가
  - Frontend가 Supabase Auth를 직접 처리하고 Backend가 asymmetric JWKS access token만 검증하는 경계와 `GET /api/v1/auth/me` bootstrap API 추가
  - 미등록 사용자의 write를 fail-closed로 막는 `codegate_provisioned` claim과 local OS file grant를 별도 권한으로 분리
  - Claude built-in file/shell tool은 계속 끄고 ACL·document ID·hash·size로 제한한 knowledge/source read MCP tool 추가
  - LLMWIKI `WikiBuildService`를 subprocess 없이 호출하고 native `current.json`만 active pointer로 사용하는 build-ID compatibility cache와 update pipeline 추가
  - LLMWIKI document type/ID/status, manifest/chunk/link/alias schema를 Backend read 계약으로 변환
  - Active normalized input checksum, 승인-derived input state, live source hash 재검증과 publish 실패 뒤 Undo 복구 추가
  - Legacy `art-*`와 generated `sec-*` anchor 공존, 첫 H2 앞 상태 경고 evidence를 실제 upstream 의미에 맞게 변환
  - local runtime, 인증, LLMWIKI 경계 ADR과 팀 handoff·배포·통합 문서 갱신
- 검증:
  - Ruff format/check 통과
  - mypy strict 통과
  - pytest 108개 통과, line coverage 84%
  - 승인 밖 normalized input, live source race, sync 실패 뒤 Undo와 legacy/preamble anchor 회귀 테스트 통과
  - LLMWIKI `fb0f8c7` fresh 50문서 build의 문서 50개, chunk 148개, link 38개 materialize/load 성공
  - Section anchor 148개 일치, legacy anchor 3개 보존, compatibility index artifact 확인
- 전달 상태: 로컬 검증 완료. 기존 PR #1에 반영해 review-ready 전환, GitHub Actions와 merge를 진행한다. Production 배포와 Supabase 운영 migration은 적용하지 않는다.
- 결정:
  - 사용자의 원본, normalized input, native active build, Backend compatibility cache를 단방향 artifact로 분리
  - Mutable input은 active ingest hash 또는 같은 active build의 승인-derived hash만 허용
  - Frontend 로그인 session과 Backend authorization을 분리하고 다운로드 앱에 JWT signing secret을 포함하지 않음
  - Compatibility cache는 read model일 뿐 별도 active pointer가 아니며 native build CAS가 유일한 publish 경계
- 남은 일:
  - Frontend의 Supabase sign-in/up/reset/OAuth, refresh/logout, `/auth/me`, Bearer 주입과 401 재인증 연결
  - 팀 Supabase project에 access token hook을 적용하고 실제 JWT provisioning·권한 회수·JWKS rotation E2E 검증
  - 실제 Anthropic credential로 Claude Agent SDK session과 제한된 read tool 호출 smoke test
  - 민규의 실제 원본 PDF/HWP/DOCX와 doc2md location mapping으로 source hash·round-trip write capability 검증
  - 용휘의 실제 vector·graph adapter를 native publish barrier에 연결
  - 우창의 chat·diff 승인/거절·Undo UI를 execution polling 계약에 연결
  - Production migration·volume·single-replica 배포는 별도 명시 승인 뒤 실행

## 2026-07-21 — 성주 역할 전수 감사와 doc2md v0.2 계약 정합화

- 목적: 현재 아키텍처에서 성주가 소유한 sidecar·agent·승인·파일 변경·지식 동기화·인증 경계를
  구현과 테스트로 다시 확인하고, 협업 문서를 실행 코드와 일치시킴
- 변경:
  - Claude read-only tool, exact `plan_hash` 승인, atomic replace·Undo, outbox와 실제 LLMWIKI
    `current.json` publish가 역할 계약을 충족하는지 전수 대조
  - README, 로컬 runtime, 통합 계약, 배포 runbook, 팀 handoff와 역할 로드맵을 실제
    `codegate-2026-convert/services/doc2md@fa88f15` v0.2 adapter에 맞게 갱신
  - `/v2/convert`, `path|bytes` transport, Bearer 인증, 32 MiB 상한, source/canonical SHA와
    stable section·diagnostic 검증을 환경변수 예시와 배포 조건에 반영
- 검증:
  - Ruff format/check 통과
  - mypy strict 46개 source file 통과
  - pytest 144개 통과, line coverage 84%
  - wheel·sdist build와 `codegate-local --help` 진입점 확인
  - Docker image build 후 container `/health`와 canonical citation 위치 검색 HTTP smoke 성공
- 전달 상태: `777b758`, `41edf57`을 `docs/role-contract-audit`에 push하고 draft PR #7 생성.
  GitHub Actions run `29841686245` 성공
- 결정:
  - 사진의 Electron main 임베드·agent write tool·kordoc 구조는 폐기된 v1.x로 유지하지 않고,
    Python sidecar와 application-owned deterministic write 경계를 정본으로 사용
  - 성주 코드 범위는 완료 상태이며 외부 credential·팀 UI·운영 환경이 필요한 검증은 내부 완료와 분리
- 남은 일:
  - 실제 Anthropic credential로 Claude Agent SDK read-tool smoke
  - 팀 Supabase project hook과 실제 JWT provisioning·권한 회수 검증
  - 우창 UI의 sidecar lifecycle·diff 승인·execution polling·Undo 연결
  - 용휘 enrichment/vector 확장 adapter 연결
  - production migration·volume·deploy·restart는 별도 명시 승인 뒤 수행

## 2026-07-22 — Electron 통합 Claude 안정화와 간결한 근거 응답

- 목적: 실제 사용자 문서 corpus에서 Claude Agent SDK 대화가 연속 질문에도 유지되고, 검색 답변이
  원문 표 조각이나 무관 문서를 섞지 않는 짧은 요약으로 표시되게 함
- 변경:
  - SDK 내부 `StructuredOutput` 제출 도구를 read-only allowlist에 포함하되 `Bash`, `Edit`, `Write`는
    계속 차단
  - app-owned JSONL session store를 추가하고 transcript가 없는 legacy resume ID는 새 세션으로 복구
  - locate 결과를 한 문서, 한 근거로 제한하고 Claude structured output의 실제 답변을 최대 480자로
    검증하며 prompt에서 2~3문장·320자·단일 대상 요약을 강제
  - 본문 안의 중복 citation과 raw table dump를 제거하고 Electron의 기존 citation chip 계약은 유지
- 검증:
  - Ruff와 mypy 통과
  - pytest 154개 통과, line coverage 84%
  - 실제 Sonnet 호출에서 `StructuredOutput` permission denial 0건과 구조화 결과 반환 확인
  - Electron sidecar HTTP로 `지난달 제출한 신청서 요약해줘`를 실행해 `서식 1` 한 문서와 2문장
    금액·기간 요약 반환 확인
- 전달 상태: 테스트 완료. GitHub branch와 PR에 함께 전달
- 결정: Claude에는 직접 파일 도구를 열지 않고 검색·읽기와 구조화 응답만 허용하며, 최종 출처는
  Backend가 검증한 document/evidence를 Electron citation chip으로 별도 전달
- 남은 일: 서명된 설치본과 임의 사용자 corpus의 최초 OCR·재시작 E2E는 release 단계에서 검증

## 2026-07-22 — 희소 근거 검색과 HWP 조회·승인 편집 복구

- 목적: 실제 corpus에서 희소 주장의 근거 검색, 정확한 HWP 파일명 기반 필드 조회, 필드 변경과
  후속 삭제가 일반 재질문으로 끝나는 문제를 원인부터 해결함
- 변경:
  - filename metadata·exact priority, 문서 단위 TF/IDF와 희소 term 선택, 한국어 조사 정규화 추가
  - 실제 successful search trace와 구조화 응답 query를 lexical alignment로 결박
  - locate clarification도 원문 희소 token이 ACL-filtered 최상위 evidence에 직접 있을 때만 결정론적
    근거 응답으로 복구
  - 현재 message 기록 전 conversation history 복원과 명시적·후속 삭제 해석 추가
  - 검증된 Kordoc entry·전체 dependency graph를 사용하는 HWP/HWPX parse·patch 경계 추가
  - 승인 hash, immutable backup, atomic replace, skipped=0, 재parse equality와 exact Undo 유지
  - HWP 수정 뒤 normalized input을 실제 원본 재parse에서 만들고 attested same-SHA repair와 durable
    restart recovery 뒤 LLMWIKI를 stage·validate·CAS publish
- 영향: agent prompt·trace enforcement, retrieval repository, conversation state, source codec·atomic writer,
  change workflow, LLMWIKI adapter와 Electron sidecar runtime 계약
- 검증:
  - agent·change·retrieval·LLMWIKI 집중 회귀 테스트와 source codec 테스트 6개 통과
  - 실제 설치 Kordoc entry와 117-package dependency graph가 Electron과 Python에서 같은 digest로 검증됨
  - 임시 HWP 복사본의 patch·재parse·exact restore 통과, 실제 원본 SHA 전후 동일
  - 요청한 네 대화 흐름은 로컬 sidecar HTTP에서 근거/조회/변경 preview/후속 삭제 preview를 반환했고
    두 preview는 reject해 원본을 변경하지 않음
- 전달 상태: 로컬 구현과 검증만 완료. commit, push, PR, 배포는 수행하지 않음
- 결정: HWP/HWPX는 local verified codec이 있을 때만 write capability를 노출하고, 모델에는 파일·shell
  write 권한을 주지 않음. 서명된 설치본의 resource/ASAR smoke는 release gate로 유지
- 남은 일: 서명된 installer에서 Kordoc resource와 standalone Node bundle 실행 확인. 광범위 full suite와
  production build는 이번 집중 검증 범위에서 다시 실행하지 않음

## 2026-07-23 — Agent-routed 파일 삭제와 HWPX 생성 계약

- 목적: 자연어 파일 삭제와 기존 보고서 기반 새 HWPX 생성 요청이 `unsupported`로 끝나는 채팅 routing
  결함을 실제 승인·생성 경로까지 해결함
- 변경: `ready_delete_file`, `ready_create_file` typed decision과 current-turn tool trace를 추가했다. 삭제는
  Backend가 ACL·원본 hash를 재검증해 기존 `plan_hash`와 Undo 흐름으로 연결하고, 생성은 검증된 source
  document ID·안전한 HWPX basename·근거 기반 Markdown만 Electron에 전달한다.
- 영향: agent prompt/schema/trace, ChatService response, prompt eval corpus, Electron sidecar 생성 계약
- 검증: Ruff, mypy와 Backend 전체 pytest 278개 통과, line coverage 84%. Electron의 실제 생성·승인
  경로 검증은 web 저장소 작업 로그에 별도로 기록함.
- 전달 결과: 전용 monorepo commit `228f17f`로 push하고 PR #1을 통해 main 병합 절차를 실행함.
