# 트러블슈팅 기록

## 2026-07-21 — setup-uv action major tag 해석 실패

### 상황

Backend 기반을 올린 draft PR #1의 첫 GitHub Actions 실행이 job setup 단계에서 4초 만에 실패했다. 애플리케이션 설치와 테스트는 시작되지 않았다.

### 기대와 실제

- 기대: `astral-sh/setup-uv`가 uv를 설치한 뒤 lint, type check, test를 실행
- 실제: `Unable to resolve action astral-sh/setup-uv@v8, unable to find version v8`
- 영향: 코드 품질은 로컬에서 검증됐지만 원격 CI 증거를 만들 수 없었음

실패 실행: https://github.com/dotenv-uploaded/Backend/actions/runs/29809767493

### 조사와 원인

공식 GitHub release API에서 최신 릴리스 `v8.3.2`가 존재함을 확인했다. 그러나 tag 목록에는 `v8.0.0`부터 `v8.3.2`까지의 정확한 버전만 있고 `v8` 이동 tag는 없었다. Workflow가 존재하지 않는 `@v8`을 요청한 것이 직접 원인이었다.

검토한 대안은 다음과 같다.

- `@v7`로 내리기: major alias는 존재하지만 최신 릴리스 기능과 수정 사항을 사용하지 못함
- `@v8.3.2`로 고정: 현재 존재하는 최신 release를 명확히 사용하며 수정 범위가 가장 작음
- commit SHA로 고정: 공급망 관점에서 가장 강하지만 자동 업데이트와 사람이 읽는 버전 추적 비용이 늘어남

해커톤 저장소에서는 정확한 release tag인 `astral-sh/setup-uv@v8.3.2`를 선택했다.

### 해결과 검증

- workflow YAML을 로컬 parser로 다시 읽어 action 값 확인
- `astral-sh/setup-uv@v8.3.2`로 수정해 branch에 push
- 후속 GitHub Actions 실행 성공: https://github.com/dotenv-uploaded/Backend/actions/runs/29809871193

### 재발 방지와 남은 위험

- 새 major action을 쓸 때 release 이름뿐 아니라 실제 major alias ref 존재 여부를 확인한다.
- CI가 job setup에서 즉시 실패하면 애플리케이션보다 action resolution 로그를 먼저 본다.
- release tag도 저장소 관리자가 이동시킬 수 있으므로 제품화 단계에서는 commit SHA 고정과 자동 업데이트 도구를 재검토한다.

면접에서는 “로컬 통과와 원격 CI 통과가 왜 다른가”, “action tag와 commit SHA 고정의 trade-off는 무엇인가”, “setup 단계 실패를 어떻게 빠르게 분류했는가”를 설명할 수 있다.

## 2026-07-21 — 변환 뒤 canonical section anchor 유실

### 상황

파일 승인과 outbox 분리는 성공했지만 새 knowledge candidate의 validate stage가 `evidence section is absent from canonical document`로 실패했다. source file에는 변경 문장이 있었고 FTS, vector, graph stage도 끝났지만 active VERSION은 바뀌지 않았다.

### 기대와 실제

- 기대: 기존 `section_id`와 heading path를 유지한 canonical Markdown에서 quote만 새 문장으로 갱신
- 실제: local converter가 raw source bytes를 canonical path에 덮어써 변환기가 넣었던 `<a id="sec-004"></a>` anchor가 사라짐
- 영향: source write는 성공했지만 sync는 retryable failure가 되었고 이전 snapshot이 계속 서비스됨

### 조사와 원인

Raw Markdown source와 normalized canonical Markdown이 우연히 비슷하다는 가정이 원인이었다. fixture source에는 사람이 작성한 heading만 있고 canonical에는 인용을 위한 stable anchor가 추가돼 있었다. source bytes를 canonical 결과로 간주하면 변환 산출물의 구조 정보를 잃는다.

검토한 대안:

- evidence gate를 느슨하게 함: 잘못된 chunk도 인용할 수 있어 제외
- chunk ID suffix에서 section ID를 다시 추측함: canonical 원문 확인이 아니므로 제외
- local adapter는 기존 canonical에 exact operation을 적용하고, 실제 adapter는 stable anchor가 있는 변환 결과를 반환하게 함: 선택

### 해결과 검증

- local adapter가 기존 canonical Markdown의 exact anchor 문장만 교체하도록 변경
- configured doc2md는 source SHA와 stable metadata를 검증한 canonical Markdown을 반환하도록 연결
- candidate load barrier에서 anchor uniqueness, 전체 heading path, declared section body의 exact quote를 확인
- 다른 section에만 quote가 있는 경우, duplicate anchor, heading mismatch와 실제 doc2md adapter 호출 테스트 추가
- 전체 pytest 66개와 86% coverage 통과

### 재발 방지와 남은 위험

- source와 canonical hash는 서로 다른 versioned artifact로 취급한다.
- converter acceptance test에 stable anchor·heading hierarchy 보존을 포함한다.
- 민규의 현재 doc2md가 stable section mapping을 반환하기 전에는 실제 binary 문서 결과를 active로 발행하지 않는다.

면접에서는 “왜 검색 quote의 존재 확인만으로 부족한가”, “원본과 normalized canonical 중 무엇을 source of truth로 삼는가”, “부분 pipeline 실패 때 사용자는 어떤 version을 보게 하는가”를 설명할 수 있다.

## 2026-07-21 — file replace와 catalog reload 사이 crash gap

### 상황

Atomic replace 직후 process crash를 주입한 뒤 재시작하면 활성 knowledge package의 manifest source SHA는 이전 값이고 실제 source bytes는 새 값이었다. 일반 catalog bootstrap을 먼저 실행하면 source checksum mismatch 때문에 journal recovery와 outbox 재처리까지 도달하지 못할 수 있었다.

### 기대와 실제

- 기대: 재시작 시 durable journal의 before/after hash로 file 상태를 판별하고 outbox를 정확히 한 번 완성
- 실제: catalog가 이전 snapshot을 정상 package처럼 source까지 재검증하려 해 recovery보다 먼저 실패
- 영향: 파일은 완전한 새 bytes였지만 API startup이 중단될 수 있음

### 원인과 해결

파일시스템과 SQLite는 하나의 transaction이 아니므로 잠깐의 의도된 불일치를 recovery protocol이 먼저 해석해야 한다. Startup 순서를 `state initialize → file journal recovery → pending event 확인 → stale source 허용 catalog load → outbox sync`로 바꿨다. Knowledge CURRENT CAS는 immutable VERSION 값을 비교하며, 이전 source hash가 잠깐 stale하다는 이유로 pointer 자체를 다시 해석하지 않는다.

Crash-after-replace fault injection에서 temp file이 없고 source가 완전한 after hash이며, 재시작 후 file version·audit·outbox·new knowledge VERSION이 한 번만 완성되는 것을 검증했다.

### 재발 방지

- file journal recovery는 catalog의 live-source validation보다 항상 먼저 수행한다.
- pending journal/outbox가 없을 때만 stale source package를 invalid로 본다.
- replace, DB finalize, candidate publish 각 경계의 fault injection을 유지한다.

## 2026-07-21 — 원본 무변경 쓰기 실패가 Undo를 영구 소비

### 상황과 재현

완료된 실행을 Undo하는 동안 temp file fsync 뒤 storage 오류를 주입했다. Source는 정확히 원 실행의 after bytes로 남았지만 Undo execution과 journal은 `failed/aborted`가 됐다. 같은 idempotency key는 실패 execution만 replay했고 새 key는 `UNIQUE(undo_of_execution_id)`에 막혔다. 승인도 같은 방식으로 plan이 consumed된 뒤 재시도 UX가 끊길 수 있었다.

기대는 side effect가 0건이면 같은 논리 승인·Undo를 안전하게 다시 실행하는 것이고, 실제 영향은 원본이 온전한데도 사용자가 Undo를 끝낼 방법이 없다는 것이었다. Fault hook의 `OSError`가 path 오류로 바뀌는 부수 문제도 발견했다. `_open_parent` context manager가 `yield` 이후 body의 `OSError`까지 경로 탐색 오류로 잡던 것이 원인이었다.

### 원인과 대안

DB의 uniqueness는 중복 Undo를 막았지만 no-effect failure의 재개 상태를 표현하지 않았다. 실패 row를 삭제하고 새 execution을 만드는 대안은 감사 연속성과 idempotency 증거를 잃어 제외했다. Unique constraint를 실패 row에만 풀어 주는 대안도 같은 논리 작업에 여러 execution을 남겨 제외했다.

### 해결과 검증

- aborted journal payload, event ID, execution·source·before/after hash를 다시 검증한다.
- Source가 before hash면 기존 execution을 원자적으로 `prepared`로 되돌리고 같은 key 또는 새 key를 그 execution에 결박한다.
- Source가 after hash면 누락된 DB finalize만 수행하고, 둘 다 아니면 conflict로 닫는다.
- 승인과 Undo 모두 새 row를 만들지 않고 같은 execution ID로 재개한다.
- Path 탐색의 `OSError` 범위를 `yield` 이전으로 좁혀 실제 storage 오류 code를 보존한다.
- approval·Undo 각각 temp-fsync 실패 뒤 새 key로 재개하고 최종 publish/byte 복구하는 fault-injection test가 통과했다.

재발 방지를 위해 write journal 상태 전이와 uniqueness constraint를 함께 검토하고, 모든 durable side effect에는 `before`, `after`, `unknown` 세 crash 상태와 no-effect retry test를 둔다. 면접에서는 “멱등성과 재시도 가능성이 왜 같은 개념이 아닌가”, “감사 row를 재사용한 이유”, “filesystem과 DB 사이 crash gap을 어떻게 수렴시키는가”를 설명할 수 있다.

## 2026-07-21 — outbox worker 잔류와 unknown-kid JWKS refresh 폭주

### 상황과 영향

Worker의 `pending_events()` 또는 pipeline 진입 직전 일시적 DB 예외는 event를 failed로 전환하지 못한다. 기존 worker는 retry delay 기본값이 비어 있어 예외 뒤 wake 신호를 지우고 영구 대기했으며 task 자체는 살아 있어 health가 정상으로 보일 수 있었다. 별도 인증 점검에서는 임의 JWT `kid`마다 PyJWT client가 JWKS를 refresh할 수 있고 chat 외 endpoint에는 pre-auth 제한이 없어 외부 조회와 thread 사용량을 공격자가 증폭할 수 있었다.

### 해결

- Worker에 bounded delay를 반복하는 재-wake loop를 두고 마지막 오류·오류 시각·진행 시각을 기록한다.
- 짧은 정상 pending은 허용하되 설정 시간보다 오래된 pending/processing count를 health readiness에 반영한다.
- Immutable release의 index readiness는 load/publish 때 한 번 검증하고 `/health`에서는 cached boolean만 읽는다.
- JWT header의 algorithm과 bounded `kid`를 network 조회 전에 검사한다.
- Known key TTL cache, bounded unknown-`kid` negative cache, process-wide 최소 refresh 간격과 3초 기본 timeout을 둔다.
- 모든 Authorization 요청에 header 크기 제한과 pre-auth IP fixed-window limit을 적용한다.

### 검증과 남은 위험

Pipeline state 전이 전 첫 호출만 실패시키고 별도 notify 없이 다음 시도에서 publish되는 test, stale health test, 두 개의 서로 다른 unknown `kid`가 한 번만 JWKS client를 호출하는 test, Authorization header 431과 인증 IP 429 test가 통과했다. In-process limit은 여러 replica를 합산하지 않고 proxy IP 신뢰 설정에 의존하므로 production gateway/WAF limit은 여전히 필요하다. 면접에서는 “task liveness와 queue progress를 왜 분리해 관측하는가”, “key rotation을 허용하면서 unknown-kid refresh storm을 어떻게 제한하는가”를 설명할 수 있다.

## 2026-07-21 — 실제 LLMWIKI 호환과 승인 경계 회귀

### 상황과 영향

Local runtime 통합을 마친 뒤 LLMWIKI `fb0f8c7`의 50문서 샘플을 fresh build해 Backend compatibility cache로 읽었다. 합성 단일 문서 fixture와 정적 gate는 통과했지만 실제 산출물은 처음에 `multiple anchors precede one heading`, 이어서 `evidence text is not unique in its canonical section`으로 load되지 않았다. 별도 crash 전이에서는 publish 전 실패 뒤 Undo가 normalized input을 복구하지 못했고, mutable input이나 live source에 승인 밖 변경을 넣어도 build 직전까지 진행할 수 있었다.

기대는 승인된 exact operation과 현재 source hash만 native build에 들어가고, publish 전 실패와 Undo도 같은 active build로 수렴하는 것이다. 실제 영향은 로컬 앱이 팀의 LLMWIKI 산출물을 읽지 못하거나, 승인하지 않은 내용이 candidate에 섞이거나, execution 상태가 영구 retry 또는 잘못된 완료로 끝날 수 있다는 것이었다.

### 증거와 원인

- Upstream은 기존 `art-*` anchor를 보존한 채 H2 바로 앞에 `sec-*` anchor를 추가한다. Backend evidence parser는 한 heading 앞 anchor를 하나만 허용했다.
- Upstream chunker는 H1과 첫 H2 사이의 상태 경고 blockquote를 첫 section evidence에 포함한다. Backend section index는 H2 뒤 본문만 포함했다. 실제로 `MAN-000019`, `MAN-000020`, `REG-000018`, `REG-000020`의 첫 chunk가 이 차이로 거부됐다.
- Native pipeline은 active manifest의 `ingest.sha256`와 mutable input bytes를 비교하지 않아 기존 input의 임의 내용을 승인된 교체와 함께 보존했다.
- `_apply_inputs`가 normalized input을 먼저 쓴 뒤 native publish가 실패하면 input만 다음 revision에 남는다. Undo final hash가 active source hash와 같다는 이유로 no-op 경로에 들어가면서 이 상태를 복구하지 못했다.
- 기존 local pipeline의 `SafeSourceFileStore.snapshot()` 검사가 native pipeline에는 없어 승인 뒤 외부 source 변경을 build 직전과 직후에 차단하지 못했다.

Evidence uniqueness를 완화하거나 mutable input을 다시 신뢰하는 대안은 잘못된 인용과 승인 우회를 허용해 제외했다. Upstream 파일을 Backend에서 직접 수정하는 대안도 소유권 경계를 깨므로 제외했다.

### 해결과 검증

- Compatibility cache에서 legacy fragment target은 `<span id>`로 보존하고 evidence용 `sec-*` anchor만 section index가 해석하도록 변환했다.
- 첫 section index가 upstream과 동일하게 pre-H2 preamble을 포함하도록 맞춰 상태 경고가 검색 evidence에서 빠지지 않게 했다.
- Active canonical에서 generated section anchor만 제거한 trusted baseline을 만들고, active `ingest.sha256` 또는 같은 active build에 대해 기록한 승인-derived input hash만 다음 변환 입력으로 허용했다.
- 승인-derived input hash를 write 전에 SQLite에 기록해 crash retry를 식별하고, Undo가 active canonical baseline으로 normalized input을 복구하도록 했다.
- Native pipeline에도 symlink-safe source snapshot을 주입하고 input 적용 전, build 직전, build 직후에 final source hash를 다시 확인했다.
- Anchor, 임의 input 혼입, live source race, publish 전 실패 뒤 Undo 회귀 테스트를 추가했다.
- Ruff format/check, mypy와 pytest 108개가 통과했다.
- LLMWIKI `fb0f8c7` fresh build의 문서 50개, chunk 148개, link 38개를 compatibility cache로 materialize하고 `KnowledgeRepository.load(validate_sources=False)`까지 통과했다. Section anchor 148개가 모두 일치했고 legacy anchor 3개도 보존됐다.

### 재발 방지와 남은 위험

Native fixture에는 legacy anchor, pre-heading 경고, crash 뒤 dirty input과 source race를 계속 포함한다. Compatibility cache format suffix를 `codegate-v2`로 올려 이전 변환 결과를 재사용하지 않는다. LLMWIKI sample에 실제 source PDF와 일치 hash가 없어서 50문서 smoke의 live source hash 검증은 제외했다. 실제 팀 원본을 받은 뒤 source hash, 승인 write, native publish, 재시작, Undo까지 같은 corpus로 다시 검증해야 한다.

면접에서는 “서로 다른 canonical section 의미를 어떻게 맞췄는가”, “승인과 publish 사이 파일시스템 crash를 어떻게 식별하는가”, “mutable local input을 신뢰하지 않으면서 retry를 지원하는 방법은 무엇인가”를 설명할 수 있다.
