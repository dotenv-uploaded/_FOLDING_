# 트러블슈팅 기록

## 2026-07-23 — XLSX 위치 조회가 현재 turn 도구 계약 오류로 종료

### 상황, 기대와 영향

`GBX-ONB-003_일정_리스크_추적표.xlsx에서 지연 일정, 위험 요소와 담당자를 찾아줘`라고 물으면
해당 XLSX의 리스크 표를 답해야 하지만 `Claude가 현재 turn의 위치 검색 도구 계약을 지키지
않았습니다`라는 일반 오류로 종료됐다. 원본 변경이나 권한 우회는 없었지만, 문서를 올바르게 찾은
turn도 후단 검증에서 버려져 사용자가 필요한 근거를 받지 못했다.

### 재현, 증거와 원인

- 위치 조회 trace 검증은 `knowledge_search → document_get`만 허용하고 검증된 target의
  `document_get`이 마지막 도구 호출이어야 한다고 가정했다. Claude가 같은 query로 같은 target의 표
  근거를 한 번 더 검색하면 안전한 보강임에도 전체 결과를 거부했다.
- 정확한 파일명 token이 문서 선택뿐 아니라 문서 안의 chunk ranking에도 큰 가중치로 반복 적용돼,
  `지연 일정`, `위험 요소`, `담당자`가 있는 리스크 표 대신 파일명 주변의 일반 `문서관계` section이
  선택됐다.
- ChatService는 Claude가 target ID를 반환하면 이미 검색된 target의 상위 근거를 버리고
  `document_get`의 첫 일반 chunk로 바꿨다.

검증을 없애거나 target 이후의 임의 검색을 허용하는 방식은 다른 query 또는 다른 문서의 근거를 최종
응답에 섞을 수 있어 제외했다. 파일명 가중치를 전부 없애는 방식도 정확한 문서 routing을 약화하므로
제외했다.

### 해결과 검증

- 모든 ready locate는 선택·대화 이력 target도 구조화 `search_query`와 byte-for-byte 같은 검색 결과에
  포함돼야 한다. 검증된 target 뒤에는 같은 query·같은 target의 `knowledge_search`만 근거 보강으로
  허용하고 query 변경, 다른 target, source/canonical 재조회는 계속 거부한다.
- 정확한 파일명은 문서 선택에는 그대로 사용하되, 요청 사실 token이 실제 chunk에 있으면 문서 내부
  ranking에서만 파일명 token을 제외한다.
- ChatService는 선택된 target의 검색 근거를 보존하고, 검색 결과에 target이 없으면 일반
  `document_get` chunk로 대체하지 않고 근거 없음으로 종료한다.
- 정확한 XLSX 질문의 허용 trace와 query를 넓힌 거부 trace, ChatService의 target 검색 근거 보존을
  회귀 테스트로 고정했다. agent runtime 테스트 37개와 Backend 전체 pytest 275개가 통과했다.
- 실제 9종 업무기록 corpus에서 같은 질문이 XLSX 문서의 `리스크 · 2` 근거를 선택하고 R-01~R-03의
  지연 요소, 제품팀·CX팀·PMO 담당과 pilot 일정 08-03 변경을 반환했다.

### 재발 방지와 남은 위험

도구 순서 자체보다 query, target과 결과 membership을 검증하는 bounded state machine을 유지한다.
정확한 파일명 routing과 요청 사실 chunk ranking을 각각 독립 회귀 테스트한다. 이번 실문서 검증은
격리된 deterministic agent로 수행했고 실제 Claude 호출은 provider credit이 있는 환경에서 별도 live
canary가 필요하다.

- 왜 마지막 검색을 모두 허용하지 않나? 다른 query나 문서의 근거가 구조화 응답에 섞이는 trace drift를
  다시 열기 때문이다.
- 왜 파일명 token을 완전히 제거하지 않나? 문서 선택에는 정확한 파일명이 가장 강한 사용자 의도이지만,
  선택된 문서 안에서는 요청한 사실이 근거 section을 결정해야 하기 때문이다.
- prompt만 수정하지 않은 이유는? 모델 행동과 무관하게 app boundary가 안전한 trace를 인정하고 올바른
  근거를 보존해야 하기 때문이다.

## 2026-07-23 — PDF 승인 삭제 뒤 깨진 문서 링크로 게시가 실패하고 재시작도 막힘

### 상황, 기대와 영향

실제 업무기록 corpus에서 PDF를 정확한 파일명으로 삭제하면 처음에는 read-only 문서라는 이유로 삭제
preview 자체가 만들어지지 않았다. 권한을 바로잡은 뒤에는 승인된 원본 이동까지 성공했지만 LLMWIKI
candidate가 삭제된 문서를 향한 내부 링크를 포함해 validation에서 실패했다. 이 상태로 sidecar를
재시작하면 active manifest의 사라진 source도 강제 검증해 outbox retry에 도달하지 못했다.

기대 동작은 승인 전 원본 무변경, 승인 후 원본과 검색 문서의 일관된 제거, 어느 단계에서 중단돼도 같은
execution의 안전한 재시도, Undo 시 원본 bytes와 지식 관계의 복원이다. 장애 중 승인되지 않은 삭제는
발생하지 않았지만, 승인된 원본이 quarantine에 있고 지식 버전은 이전 상태인 부분 완료가 남았다.

### 재현, 증거와 원인

- materialized manifest의 `write_access`가 source `editability`를 그대로 따라 PDF·DOCX처럼 content
  writer가 없는 형식의 승인 삭제까지 차단했다.
- Electron crosslink가 만든 `[CODE](DOC-….md)` 링크는 source input에 남아 있고, 삭제 대상 ID가 빠진
  candidate를 만들 때 LLMWIKI builder가 의도대로 broken internal link validation에 실패했다.
- repository recovery load도 `validate_sources=False`에서 source 존재를 검사해, 승인 뒤 이미 이동한
  원본을 pending execution으로 복구할 수 없었다.
- delete retry는 live normalized input만 해석해, 첫 시도가 quarantine으로 옮긴 입력을 다시 찾지
  못했다.

검토한 대안 중 broken link validation을 전역 완화하는 방식은 오타까지 숨겨 손상된 지식을 게시하므로
제외했다. normalized input의 링크를 평문화하는 방식도 수동 링크와 section anchor provenance가 없어
원문을 훼손할 수 있어 제외했다. 승인된 lifecycle operation의 정확한 삭제 ID만 builder request에
결박하고 outbox가 동일 execution을 재생하는 방식을 선택했다.

### 해결과 복구 검증

- content editability는 그대로 보존하되 로컬 source lifecycle에는 `restricted` write access를 부여해
  모든 형식이 기존 승인·hash·backup·journal 경계를 거쳐 삭제되게 했다.
- Backend는 승인된 `removed_document_ids`만 LLMWIKI stage와 candidate activation에 전달한다. builder는
  그 대상의 graph edge만 제외하고 다른 깨진 링크는 계속 거부하며 Markdown 링크·anchor는 수정하지
  않는다.
- Backend는 삭제 execution, source URI·SHA, 삭제 전 graph와 event ID를 SQLite tombstone으로 먼저
  기록한다. 현재 batch뿐 아니라 tombstone이 남아 있는 모든 후속 build가 활성 삭제 ID 전체를
  전달하며, 정확한 복원이 게시된 뒤에만 해당 execution의 tombstone을 지운다.
- source-fragment 문서는 모든 조각의 경로·SHA를 먼저 검증한 뒤 함께 quarantine/restore하고, 복원된
  조각 descriptor를 candidate attestation에 사용한다.
- recovery mode는 package·reference 무결성을 계속 검사하면서 pending source 부재만 허용한다. cache
  miss에서도 source 검사를 생략해 bootstrap할 수 있고 retry는 검증된 output 경계 안의 quarantine input
  baseline을 사용한다.
- native pointer 공개 뒤 SQLite 완료 전에 중단된 retry는 execution의 삭제 전 graph, retained input과
  quarantine SHA를 재검증해 event만 멱등 완료한다. 삭제 target을 참조하는 승인 enrichment는 target이
  없는 동안 stale 처리하고 복원 뒤 같은 attestation이면 다시 사용한다.
- 실제 PDF 삭제 게시 뒤 sidecar를 재시작하고, tombstone이 활성인 상태에서 무관한 HWP 수정·재빌드도
  성공시켰다. PDF는 계속 검색되지 않았고 tombstone은 1개로 유지됐다. 이어 PDF Undo와 HWP Undo를
  게시해 두 원본 SHA, PDF의 38개 관계 링크와 검색 결과를 정확히 복원했으며 tombstone은 0개,
  pending/failed event도 0개가 됐다.
- 관련 회귀 테스트를 포함해 Ruff format/check, mypy와 Backend pytest 275개가 통과했고 coverage는
  84%다. LLMWIKI builder Ruff check와 pytest 47개도 통과했다.

### 재발 방지와 남은 위험

read-only content와 source lifecycle 권한, 다중 fragment 원자성, 승인된 삭제 ID의 build scope,
missing-source cache-miss recovery, quarantine retry, pointer 공개 뒤 재조정과 후속 무관 build를 별도
회귀 테스트로 고정한다. 허용 누락 ID는 경로 문자를 거부하고 stage·activation에 활성 tombstone 전체를
동일하게 전달한다. 현재 앱은 ZIP 직접 등록이 아니라 압축 해제된 폴더를 입력으로 받으므로 가져오기
UX는 남아 있다.

- 왜 broken link 검증을 끄지 않았나? 삭제 성공처럼 보이면서 탐색 불가능한 graph를 게시하게 되기
  때문이다.
- 왜 read-only PDF를 삭제할 수 있나? 내용 patch 능력과 승인·backup 기반 파일 lifecycle은 서로 다른
  권한이기 때문이다.
- 중간 실패를 어떻게 복구하나? deterministic execution과 journal/outbox가 quarantine 상태를 식별하고
  같은 변경을 재적용한 뒤 CAS publish로 수렴시킨다.

## 2026-07-22 — 파일 삭제가 unsupported로 끝나고 후속 변경 query가 tool trace와 충돌

### 상황, 기대와 영향

정확한 HWP 파일명 삭제와 `계약서 전부 다 지워줘`가 승인 화면으로 이어지지 않았고, 직전 조회를 이은
담당자 이름 변경은 구조화 `search_query`와 Claude tool query 불일치로 실패할 수 있었다. 기대 동작은
현재 근거에 결박된 변경 preview와, 파일별 명시 승인 뒤 복구 가능한 원본·위키 삭제였다. 승인 없는
원본 변경이나 삭제는 발생하지 않았다.

### 증거와 원인

- ChatService가 파일명 뒤 삭제 동사를 감지하면 agent와 change plan 생성 전에 무조건 unsupported를
  반환했다.
- query rebinding은 target 문서가 search 결과 전체에 존재해도 첫 결과가 아니면 증거를 버렸다.
- 기존 `replace_exact` 모델에는 source 부재 상태, 원래 mode와 삭제 execution·graph version 결박이
  없었다.
- native LLMWIKI candidate 검증은 문서 ID 집합이 항상 같다고 가정했다.

### 해결과 검증

- 정확한 basename과 계약서 유형 일괄 요청을 app boundary에서 해석하고 파일별 `delete_file` plan을
  생성했다. Electron은 순서대로 각 exact `plan_hash` 승인을 받는다.
- 승인 시 SHA 재검사, immutable backup, journal, atomic unlink와 outbox publish를 사용한다. Undo는
  대상 부재와 현재 ACL을 확인한 뒤 bytes·mode·위키 문서를 복원한다.
- 삭제 직전에는 source를 rename-quarantine한 뒤 다시 hash를 검증해 외부 edit race의 새 내용을
  삭제하지 않는다. plan 기반 deterministic execution ID와 stable idempotency key를 사용하고, UI는
  승인 요청 전 execution을 영속해 응답 유실·중단 뒤 상태 조회와 파일별 Undo를 보존한다.
- query target 검증을 첫 결과가 아니라 검증된 result document ID 집합 membership으로 고쳤다.
- 전체 Backend pytest 259개, Ruff, mypy와 Electron typecheck·Vitest 141개가 통과했다.

### 재발 방지와 남은 위험

파일 삭제를 빈 content replacement로 표현하지 않고 discriminated operation으로 유지한다. 일괄 삭제는
20개로 제한하고 파일별 승인을 요구한다. 외부 process가 승인 직후 source를 바꾸는 POSIX race는 기존
직접-write 비지원 계약과 동일하게 남으며, 모든 협력 writer는 Backend API를 사용해야 한다. 면접에서는
“삭제 상태를 hash sentinel로 journal에 표현한 이유”, “원본 삭제와 지식 버전 공개를 어떻게 재시도와
Undo로 수렴시키는가”를 설명할 수 있다.

## 2026-07-22 — 정확한 HWP 조회·변경과 희소 근거 검색이 일반 재질문으로 종료

### 상황, 기대와 영향

실제 Electron 앱에서 사업계획서의 특정 희소 주장의 근거를 물으면 관련 문서 대신 일반 검색어에
가까운 문서가 선택됐다. 정확한 HWP 파일명을 지정해 표 안 담당자 필드를 조회하거나 값을 바꾸고,
같은 대화에서 그 값을 삭제해 달라고 해도 문서나 변경 전후 내용을 더 구체적으로 적으라는 응답만
반환됐다. 기대 동작은 첫 질문에는 인용 가능한 근거를, 둘째에는 정확한 필드 값을, 변경·삭제 요청에는
원본을 건드리지 않은 승인 preview를 반환하는 것이다.

영향 범위는 희소 단어가 들어간 근거 검색, 파일명 기반 HWP 조회, HWP 변경과 후속 대화 문맥이었다.
승인 없는 원본 변경은 발생하지 않았다.

### 재현과 증거

- 기존 doc2md HWP 결과에는 첫 페이지의 핵심 표가 없었지만 Kordoc full-body parse에는 해당 표와
  필드가 존재했다.
- 검색 artifact가 source filename을 보존하지 않아 정확한 파일명 query에 우선순위를 줄 수 없었다.
- chunk-local OR scoring에서 흔한 표현이 희소 주장을 이겼고, 조사 변형도 같은 용어로 정규화되지
  않았다. exact filename bonus는 검증 schema 상한 1을 넘을 수도 있었다.
- HWP/HWPX write capability가 converter의 read-only 값만 따라 항상 닫혀 있었다.
- 새 요청을 먼저 기록한 뒤 session history를 읽어 이전 변경 대상을 잃었고, resume할 transcript가
  없는 session도 복구하지 못했다.
- 모델이 구조화 응답에서 search query를 바꿔 쓰면 실제 tool trace와 결박되지 않았고, 여러 검색 중
  마지막의 넓은 query가 결과를 덮을 수 있었다.
- 평면 structured output schema는 `outcome`, nullable hash와 operation의 조합을 제한하지 못했다.
  SDK schema 검증은 성공해도 Pydantic 교차 필드 validator에서 `AGENT_RESULT_INVALID`가 발생했다.
- stable ID 뒤에 한국어 조사가 붙으면 Unicode `\b`가 경계로 인식하지 않아, 최근 user message의
  `REG-000001의`가 후속 삭제 routing hint에서 빠졌다.
- 새 TF/IDF ranking에서 같은 개인정보 보관 기간을 다루는 규정과 매뉴얼이 사실상 동률이었지만,
  매뉴얼의 반복 term frequency가 0.001 수준의 차이로 규정을 앞섰다.
- 같은 source SHA로 full-body normalized input만 교정해도 active LLMWIKI build가 갱신되지 않았다.

### 원인과 검토한 대안

단일 UI 문구가 아니라 변환, retrieval, agent trace, 대화 history, write capability와 지식 publish가
연속으로 어긋난 복합 장애였다. prompt만 더 강하게 쓰는 방법은 누락된 표와 read-only writer를 해결하지
못한다. HWP를 Markdown처럼 직접 쓰거나 모델에 파일 도구를 여는 방법은 서식 손상과 승인 우회 위험이
있어 제외했다. source SHA가 같다는 이유로 항상 재build하는 방법도 임의 input drift를 승인할 수 있어
제외했다.

### 해결과 복구 검증

- Electron input sync가 검증된 Kordoc full-body parse를 사용하고 filename·source metadata를 보존한다.
- 검색은 exact filename priority, bounded score, 문서 단위 TF/IDF와 희소 term chunk 선택, 한국어 조사
  정규화를 사용한다.
- 실제 successful search trace와 distinct token 또는 filename이 일치하는 결과만 구조화 응답에
  결박하고, 가장 높은 lexical alignment를 선택한다.
- Prompt contract 2.1은 `ready_locate`, `ready_change`와 non-ready 상태를 typed union으로 나눠 각
  상태에 유효한 필드만 SDK schema에 노출한다. 후단 domain validator와 tool trace 검증은 유지한다.
- stable ID reference는 ASCII ID 문자 경계로 추출해 한국어 조사가 붙어도 최근 user message의 target을
  복원한다. 가장 최근의 ID-bearing user message에 정확히 한 ID가 있을 때만 direct hint로 쓰고 복수
  ID면 검색으로 되돌린다. 모델이 source 문맥까지 넓혀 치환하면 사용자 요청에 실제 포함된
  replacement로 operation을 축소하고, 삭제 범위는 넓히지 않는다.
- 모델이 locate 요청을 임의로 clarification 처리해도 원문 희소 token이 ACL-filtered 최상위 인용문에
  직접 존재할 때만 고정 문구의 근거 결과로 복구한다.
- 정책 relevance가 근접 동률일 때만 작은 document authority prior를 적용한다. 명시적인 매뉴얼 query와
  exact filename bonus가 이를 충분히 이기도록 회귀 테스트한다.
- 같은 conversation의 이전 message를 현재 요청 기록 전에 로드하며 명시적 삭제와 후속 삭제를
  구분한다.
- 파일명 바로 뒤의 삭제 동사는 agent 호출 전에 파일 자체 삭제로 분류한다. 이 요청은 내용 삭제
  operation으로 변환할 수 없고, `파일에서 특정 항목을 지워` 형태만 기존 승인 preview 경로로 보낸다.
- structured validation 로그의 location은 알려진 schema field와 고정 union branch만 남기며 모델이 만든
  임의 key, 배열 index와 입력값은 placeholder로 정규화한다.
- HWP/HWPX는 entry와 전체 production dependency graph가 일치할 때만 편집 가능하다. exact operation,
  approval hash, immutable backup, atomic replace, skipped=0, 재parse equality와 source hash를 모두
  확인한다. 삭제는 문서 가장자리의 고유 문자열도 proposed result 기준으로 검증한다.
- Electron 33 내장 Node 20은 stable permission flag를 거부했고 experimental permission과 pnpm symlink
  resolution도 충돌했다. 개발 앱은 검증된 PATH Node의 stable permission model을 사용하며 설치본은
  standalone Node bundle 없이는 capability를 열지 않는다.
- normalized input은 수정된 HWP 재parse에서만 만들고, attested same-SHA repair와 durable recovery 뒤
  stage·validate·CAS publish한다. Undo는 exact backup bytes와 이전 검색 상태를 복구한다.
- 임시 HWP 복사본의 필드 변경→재parse→원본 bytes 복원 왕복에서 수정 결과가 확인됐고, 실제 원본
  SHA는 전후 동일했다.
- sidecar HTTP 재현에서 희소 주장 질문과 파일명 필드 조회는 각각 근거 결과를, 변경과 후속 삭제는
  승인 preview를 반환했다. 두 preview는 즉시 reject했으며 원본 SHA는 유지됐다.
- Prompt contract 2.1 변경 코드의 실제 Claude Sonnet read-only canary에서 semantic field 변경,
  history 기반 후속 삭제와 파일 삭제 거부가 3/3 통과했다. 전체 Ruff, mypy와 pytest 255개도 통과했다.
- Electron supervisor로 sidecar를 새 코드로 재기동한 뒤 실제 HWP field 변경 요청이 approval preview를
  반환했다. Preview를 즉시 reject했고 execution 0건, 원본 hash가 plan의 base hash와 같음을 확인했다.
  파일 자체 삭제 요청은 change plan 없이 지원 범위 안내로 종료됐다.

### 재발 방지와 남은 위험

filename, 희소 term, edge deletion, history resume, trace binding, HWP reparse-derived input,
same-SHA rebuild, retry와 Undo를 회귀 테스트로 고정한다. Kordoc child에는 package read permission만 주고
network·child process·secret environment를 차단하며 input, output, heap과 timeout을 제한한다.

개발 앱의 실제 corpus 흐름은 검증했지만 서명된 설치본의 ASAR/resource 배치와 standalone Node bundle은
release smoke가 필요하다. packaged runtime에서 attestation 경로를 찾지 못하면 HWP capability는
fail-closed한다.

- 왜 prompt 수정만으로 해결할 수 없었나? 검색 이전의 변환 결과에서 필요한 표가 이미 누락됐기
  때문이다.
- 왜 source SHA가 같은데 재build가 필요한가? 원본 bytes가 같아도 converter 교정으로 normalized input이
  달라질 수 있기 때문이다.
- 왜 HWP 변경 뒤 기존 Markdown에 operation을 적용하지 않나? 실제 바이너리 patch와 parser 결과의
  동일성을 증명하지 못하기 때문이다.
- dependency graph 전체를 왜 pin하나? 검토한 entry가 같아도 transitive parser 코드가 바뀌면 실행
  의미와 공격 표면이 달라지기 때문이다.

## 2026-07-22 — Google OAuth 전환 배포가 private Git과 production readiness에서 실패

### 상황과 영향

Railway Backend의 demo token 인증을 Google OAuth로 교체하고 고정 loopback callback을 사용하려 했다.
첫 배포는 image build 중단, 두 번째는 app 기동 뒤 healthcheck 503으로 실패했다. Railway는 이전 성공
deployment를 계속 제공해 기존 demo API의 가용성은 유지됐다.

### 기대와 실제

- 기대: OAuth package를 설치한 image가 기동하고 `/api/v1/health`와 `/auth/google/start`가 성공한다.
- 실제: 첫 image는 `git` 실행 파일 부재로 실패했고, Git을 추가한 로컬 재현에서는 private repository를
  인증 없이 clone할 수 없었다. 이를 제거한 image는 기동했지만 기존 demo knowledge release에
  FTS·vector·graph index artifacts가 없어 production readiness가 503을 반환했다.

### 증거와 원인

- `uv sync --frozen`이 private Git direct reference를 resolve하면서 build-time GitHub 인증을 요구했다.
- Railway Docker build 변수는 `ARG`로 주입해야 하므로 token을 clone URL이나 layer에 넣는 방식은
  credential 노출과 재현성 저하 위험이 있었다.
- production health는 검증된 index artifacts를 필수로 요구한다. 현재 volume의 demo release는 graph는
  제공하지만 `index_artifacts_available=false`여서 healthcheck 실패가 정상 동작이었다.

### 해결과 검증

- 검증된 `codegate_cloud_api@a0553b5` 소스를 Backend wheel에 포함하고 private Git direct reference를
  제거했다. multi-stage Docker build는 source와 virtualenv만 runtime image로 복사한다.
- production health 조건을 완화하거나 healthcheck를 우회하지 않았다. 데모 데이터가 준비된 현재
  Railway 환경은 `development + google`로 실행하고 실제 인증·session rotation은 Google OAuth를 쓴다.
- 로컬 Docker build, Ruff format/check, mypy와 pytest 220개가 통과했다.
- Railway deployment `87a5ec2d-1f07-4e5b-8e91-14238e458336`이 성공했고 공개 health에서
  `auth_mode=google`과 converter·agent·persistence 가용성을 확인했다.
- OAuth start smoke에서 Google authorization host, 정확한 고정 callback, PKCE S256과 만료되는 state를
  확인했다. 실제 사용자 계정 로그인은 사용자가 Electron에서 수행하도록 남겼다.

### 재발 방지와 남은 위험

배포 image는 인증이 필요한 Git dependency 없이 독립 빌드되어야 한다. OAuth source pin을 갱신할 때는
upstream package 테스트와 Backend 통합 테스트를 함께 실행한다. production 전환 전에는 volume에
checksummed FTS·vector·graph artifacts를 배치하고 health 200, 검색, 승인, Undo를 다시 검증한다.

## 2026-07-22 — `/docs`는 200이지만 브라우저에 Swagger UI가 보이지 않음

### 상황과 영향

Railway Backend의 `/docs`와 `/openapi.json`은 각각 200이었지만 사용자 브라우저에서는 문서 화면이
열리지 않았다. API endpoint를 발견하고 확인할 경로가 없어 base URL의 정상 404도 서버 장애처럼
보였다.

### 증거와 원인

기본 FastAPI docs HTML은 CSS와 JavaScript를 `cdn.jsdelivr.net`에서 내려받았다. 서버 HTML과
OpenAPI schema는 정상이지만 browser/network policy가 외부 CDN을 차단하면 빈 문서 shell만 남는다.

### 해결과 검증

FastAPI 기본 Swagger/Redoc route를 끄고 OpenAPI schema에서 endpoint 목록을 만드는 self-contained
HTML `/docs`를 추가했다. 페이지는 inline CSS 외에 외부 asset이나 JavaScript가 없고 `/`는 `/docs`로
이동한다. TestClient에서 redirect, no-store, endpoint 목록, CDN·script 부재를 검증한다.

### 재발 방지와 남은 위험

배포 smoke에 `/`, `/docs`, `/openapi.json`을 포함한다. 향후 interactive API console이 필요하면
외부 CDN을 다시 참조하지 말고 version과 license를 고정한 asset을 직접 제공한다.

## 2026-07-22 — Railway startCommand에서 `$PORT`가 확장되지 않아 컨테이너 반복 종료

### 상황과 영향

Railway Backend 첫 배포에서 Docker image build와 push는 성공했지만 healthcheck가 30초 동안 503을
반환했고 배포가 실패했다. 인스턴스는 시작 직후 제거되어 API를 제공하지 못했다.

### 기대와 실제

- 기대: `uvicorn ... --port $PORT`가 Railway의 동적 포트에서 서버를 시작한다.
- 실제: Railway가 `railway.toml`의 start command를 shell expansion 없이 전달해 Uvicorn이
  `'$PORT' is not a valid integer`로 종료됐다.

### 증거와 원인

배포 로그에서 volume mount는 정상 완료됐지만 모든 restart가 같은 Uvicorn port parsing 오류로
끝났다. 설정 문자열에 `$PORT`를 썼지만 명시적인 shell process가 없어 환경변수 확장을 보장하지
않은 것이 직접 원인이다.

### 해결과 검증

start command를 `sh -c`와 `exec`로 감싸고 `${PORT:-8000}`을 사용했다. TOML parser 기반 회귀
테스트로 shell wrapper와 port expression을 고정했다. 후속 Railway 배포에서 Uvicorn이 PID 1로
port 8080에 시작했고 Railway healthcheck와 실제 공개 `/api/v1/health`가 모두 200을 반환했다.

### 재발 방지와 남은 위험

플랫폼 변수를 쓰는 start command는 로컬 문자열 검토만 하지 않고 배포 로그와 실제 healthcheck로
검증한다. `exec`를 유지해 Uvicorn이 PID 1의 signal을 직접 받고 정상 종료하도록 한다. 면접에서는
“process runner와 shell expansion의 차이가 컨테이너 시작에 어떤 영향을 주는가?”를 설명할 수 있다.

## 2026-07-22 — Claude 구조화 결과 실패, stale resume, 원문 덤프 응답

### 상황과 영향

Electron 통합 뒤 첫 질문은 `Claude Agent SDK가 검증된 구조화 결과를 반환하지 못했습니다`로
실패했고, 성공한 뒤 다음 질문은 `No conversation found with session ID`로 종료됐다. 이 두 문제를
해결한 뒤에도 위치 검색 응답이 여러 문서의 긴 표와 citation 문자열을 그대로 이어 붙여 실제 질문의
요약처럼 읽히지 않았다.

### 증거와 원인

- SDK 결과 subtype은 `error_max_structured_output_retries`였고 10 turn 동안 permission denial 5건이
  발생했다. `output_format=json_schema`가 내부적으로 호출하는 무부작용 `StructuredOutput` 도구까지
  deny-by-default hook이 막고 있었다.
- 성공 session ID는 SQLite에 기록됐지만 SDK transcript 저장소가 없어 다음 요청의 resume 대상이
  존재하지 않았다.
- ChatService가 Claude의 짧은 답변을 버리고 검색된 모든 evidence quote와 citation을 본문 문자열로
  재조립했다. 표 중심 문서와 비슷한 두 번째 검색 결과가 그대로 노출됐다.

### 해결과 검증

- `StructuredOutput`만 명시 allow하고 파일·shell·web 쓰기 도구 차단은 유지했다.
- project/session별 private JSONL transcript store를 추가하고 누락된 resume은 새 UUID session으로
  fail-safe 복구했다.
- locate structured answer를 최대 480자로 제한하고 한 문서를 대상으로 2~3문장만 작성하게 했다.
  Backend는 검증된 첫 evidence와 citation metadata만 별도 전달하며 본문에는 raw quote를 붙이지 않는다.
- 실제 Sonnet 호출에서 구조화 결과와 permission denial 0건을 확인했고, 동일 사용자 질문은 `서식 1`
  한 건의 사업비·수행기간 요약과 클릭 가능한 출처 하나를 반환했다.

### 재발 방지와 남은 위험

SDK upgrade 때 output-format 제출 도구와 session-store 계약을 회귀 테스트하고, 응답 schema의 길이
상한과 단일 대상 규칙을 유지한다. 검색 자체가 잘못된 첫 문서를 선택하면 짧지만 틀린 요약이 될 수
있으므로 향후 temporal metadata와 사용자 선택 UX를 retrieval ranking에 연결해야 한다. 면접에서는
“deny-by-default 도구 정책에서 SDK 내부 도구를 어떻게 검증하는가”, “resume ID와 transcript의
durability를 왜 함께 보장해야 하는가”, “생성 요약과 검증된 citation을 어떻게 분리했는가”를 설명할
수 있다.

## 2026-07-22 — Claude API 크레딧 부족이 구조화 결과 실패로 오분류됨

### 상황과 영향

Electron에서 Claude Agent SDK 질문을 보내면 약 3초 뒤
`Claude Agent SDK가 검증된 구조화 결과를 반환하지 못했습니다`가 표시됐다. 실제 문제는 구조화
schema나 도구 호출이 아니어서 사용자는 prompt를 바꿔도 해결할 수 없었고, 계정 조치가 필요한 상태를
알 수 없었다.

### 기대와 실제

- 기대: 인증, 크레딧, rate limit, 공급자 장애와 구조화 출력 실패를 서로 다른 오류로 안내한다.
- 실제: gateway가 `ResultMessage.structured_output is None`을 먼저 검사해 모든 SDK 실패를
  `AGENT_RESULT_INVALID`로 바꿨다.

### 재현과 증거

- 실제 요청 세 건이 모두 `AGENT_RESULT_INVALID`로 기록됐고 약 3초 안에 끝났다.
- 안전한 진단 로그에서 SDK 결과는 `subtype=success`, `is_error=true`, `num_turns=1`,
  `api_error_status=400`, permission denial 0건, structured output 없음이었다.
- 문서·MCP·output schema를 제거한 최소 SDK 요청도 같은 HTTP 400을 반환했고 공급자 결과는
  `Credit balance is too low`였다.
- 따라서 StructuredOutput hook, schema 재시도, session resume은 이번 실패의 원인이 아니었다.

### 원인과 대안

직접 원인은 Anthropic API 크레딧 부족이고, 제품 측 원인은 공급자 오류를 구조화 결과 오류로 덮은
분류 순서였다. 공급자 원문을 그대로 사용자에게 노출하는 방법은 정보 노출과 불안정한 문구 의존성
때문에 제외했다. 모든 400을 키 오류로 처리하는 방법도 모델·요청 오류를 오진하므로 제외했다.

### 해결과 검증

- ResultMessage의 안전한 메타데이터만 기록하고 prompt, key, 공급자 원문은 로그에 남기지 않는다.
- 정확한 크레딧 부족 문구는 `AGENT_CREDIT_EXHAUSTED`로, 401/403은 인증 오류, 429는 rate limit,
  5xx는 공급자 장애, SDK 예산 초과는 별도 코드로 분류한다.
- 알 수 없는 공급자 거부와 실제 구조화 결과 실패는 계속 분리해 fail-closed로 처리한다.
- 분류 회귀 테스트 7개와 기존 agent runtime 테스트 26개가 통과했다.
- 전체 Ruff format/check, mypy 48개 source file, pytest 220개가 통과했다.
- 실행 중 sidecar를 재기동한 뒤 동일 요청이 `AGENT_CREDIT_EXHAUSTED`와 한국어 조치 문장을 반환했다.

### 재발 방지와 남은 위험

SDK ResultMessage subtype과 HTTP 상태를 새 버전 회귀 테스트에 포함한다. health의
`agent_available`은 키 존재만 뜻하며 크레딧과 실제 호출 성공을 뜻하지 않는다는 경계를 유지한다.
크레딧이 있는 키를 적용하기 전에는 구조화 결과와 파일 수정 E2E를 완료할 수 없다. 면접에서는
“transport는 200인데 내부 공급자 오류를 어떻게 분류하는가”, “raw provider message를 노출하지 않고
사용자가 조치 가능한 오류를 어떻게 만드는가?”를 실제 증거와 함께 설명할 수 있다.

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

## 2026-07-22 — LLMWIKI server-v2 최초 build를 Backend가 거부

### 상황과 기대

Electron sidecar 실행 계약을 실제 process로 검증하기 위해 현재 `LLMWIKI@6269824`와 한 문서짜리
합성 source/input으로 `codegate-local --deterministic-agent`를 시작했다. 기대는 native 후보 build를
검증·활성화하고 `/health`와 근거 검색이 성공하는 것이었다.

### 실제 동작과 영향

LLMWIKI는 `build-99801fba8b94ffc5f1a2`를 정상 stage했지만 Backend startup이
`LLMWIKI build metadata does not match current.json`으로 중단됐다. 설치 앱에서 최신 LLMWIKI bundle을
사용하면 sidecar가 준비 상태에 도달하지 못하는 통합 차단 문제였다.

### 증거와 원인

- 생성된 `build-meta.json`은 bundled schema를 통과했고 tenant, wiki, build ID도 요청과 일치했다.
- 실제 `build_format_version`은 `server-v2`였지만 Backend adapter가 `server-v1`만 하드코딩했다.
- `fb0f8c7..6269824` 비교에서 upstream schema가 semantic source fragment 지원과 함께 format을
  `server-v2`로 올린 것을 확인했다.

원인은 schema 검증과 별개로 둔 Backend compatibility allowlist가 upstream pin 변경을 따라가지 못한
것이다. Version 검사를 제거하는 대안은 미래의 비호환 format까지 허용하므로 제외했다. 로컬 checkout을
옛 commit으로 내리는 대안은 신규 source fragment 계약을 잃고 다음 통합 때 같은 문제가 재발하므로
제외했다.

### 해결과 검증

- Backend compatibility adapter가 검증된 `server-v1|server-v2`만 명시적으로 허용하도록 변경했다.
- `server-v2` metadata 회귀 테스트를 추가했다.
- 동일 source/input과 새 storage/data root로 sidecar를 다시 시작해 startup 완료를 확인했다.
- `/api/v1/health`가 `status=ok`, local auth, persistence·agent·index available을 반환했다.
- 위치 검색이 `REG-100001 rev.1 §sec-1cfaae57ec`의 canonical exact quote를 반환했다.
- sidecar에 SIGINT를 보내 worker와 Uvicorn이 정상 종료되는 것을 확인했다.

### 재발 방지와 남은 위험

다음 LLMWIKI 연결 때는 bundle commit과 `build_format_version`을 함께 pin하고, 실제 fresh build smoke를
계약 검증에 포함한다. 현재 `server-v2`의 한 문서 build·load는 통과했지만 민규 converter와 용휘의
최종 package가 준비되면 실제 corpus로 source hash, source fragment, 승인 write, 재build, Undo까지 다시
검증해야 한다. 면접에서는 “schema 검증 뒤에도 왜 format allowlist가 필요한가”, “upstream pin 변경을
어떤 executable contract test로 막는가”를 설명할 수 있다.

## 2026-07-22 — 최신 converter→Backend→LLMWIKI 재발행이 checksum과 H1에서 연속 실패

### 상황, 기대와 영향

`codegate-2026-convert@30e6814`, Backend, `LLMWIKI@acf94f7`을 실제 process로 띄우고 한 문서의
`1년`을 `3년`으로 승인 변경했다. 기대는 원본 atomic write 뒤 doc2md 변환, native candidate 검증,
`current.json` 공개와 새 근거 검색이 한 execution으로 완료되는 것이었다.

실제로 원본은 적용됐지만 첫 동기화는 `LLMWIKI ingest checksum is invalid`로 끝났다. 호환 parser를
보완한 뒤 같은 시나리오는 `H1 제목과 front matter title이 다릅니다`에서 다시 실패했다. 두 경우 모두
execution은 `sync_retryable`이었고 이전 `build-99801fba8b94ffc5f1a2`가 계속 검색에 제공돼 잘못된
candidate가 공개되지는 않았지만, 사용자는 파일과 검색 결과가 다른 action-required 상태에 놓였다.

### 재현과 증거

- 최신 native manifest는 legacy `ingest.path/sha256` 대신
  `ingest.aggregate_sha256/fragments[]`, `chunking_mode`, `source_fragment_count`를 기록했다.
- 한 문서 `sections` build는 fragment 1개, `chunk_no=null`, aggregate와 fragment SHA가 같았다.
- Backend는 format 이름만 `server-v2`로 허용하고 baseline과 candidate에서 여전히 legacy 필드를
  읽고 있었다.
- 실제 doc2md `/v2/convert`는 metadata title override를 보존했지만 Markdown body에는 원본 H1
  `# local source`를 남겼다. LLMWIKI input validator는 이 H1과 frontmatter title 불일치를 거부했다.
- 첫 실패 execution은 `exec_a8951817ac764effa0732c1fc6ee011d`였고 source write와 immutable
  backup은 정상 기록됐다.

### 원인과 검토한 대안

첫 원인은 build format allowlist와 실제 ingest shape 해석을 하나의 계약으로 검증하지 않은 얕은
회귀 테스트였다. 둘째 원인은 stable metadata title을 강제하면서 변환 body H1도 같은 값인지 재발행
전에 정규화하지 않은 adapter 경계였다.

Schema 검사를 느슨하게 하거나 aggregate만 승인 증거로 쓰는 방법은 path·fragment topology 변조를
놓치므로 제외했다. 여러 source fragment 중 첫 파일만 쓰는 방법은 부분 write와 불완전 Undo를 만들 수
있어 제외했다. doc2md 저장소나 LLMWIKI validator를 Backend 요구에 맞게 직접 바꾸는 방법은 담당 경계를
깨므로 사용하지 않았다.

### 해결과 복구 검증

- Legacy와 v2 ingest를 strict parser로 분리하고 mode, count, 정렬된 chunk number, path, fragment SHA와
  aggregate를 교차 검증했다.
- 변경 candidate에는 active와 같은 단일 input path와 Backend state에 미리 기록한 exact bytes SHA를
  요구하고, 관련 없는 문서는 전체 fragment descriptor가 같아야 한다.
- `source-fragments` 문서는 read-only로 내리고 직접 sync event도 input write 전에 차단했다.
- doc2md body는 fenced code 밖의 실제 선행 H1이 정확히 하나인지 검사하고 그 제목만 active manifest
  title로 바꾼다. H1 누락·중복은 이전 current를 유지한 채 실패한다.
- 실패 execution의 `retry-sync`가 완료돼 `build-4147f2b0ed2a29246605`를 공개했고 `3년` 근거가
  검색됐다. 새 source write나 새 change plan은 만들지 않았다.
- 이어서 Undo가 `build-465cd13e13f397a818d7`을 공개했다. 원본 SHA가 immutable backup SHA
  `581af8e24b0ab17d7a104a36434fc26ef8bb520d02d596828a15befe2c2a33bd`와 같았고 `1년`
  근거가 복구됐으며 health의 pending/failed/stale event는 모두 0이었다.
- 실제 v2 fixture를 포함한 focused Backend pytest 33개, converter pytest 104개, LLMWIKI
  wiki-builder 39개와 local-runtime 14개가 통과했다.

### 재발 방지와 남은 위험

현재 integration pin, build format과 실제 ingest shape를 함께 fixture로 고정한다. Aggregate가 path를
포함하지 않는다는 사실을 ADR 0005에 기록했고, multi-fragment write는 fragment-set durable snapshot과
원자 rollback이 생길 때까지 열지 않는다. LLMWIKI의 `/convert/async` watcher와 Backend의 동기
`/v2/convert` outbox writer는 같은 input에 동시에 쓰지 않도록 desktop에서 직렬화해야 한다.

현재 모델은 검토·고정한 LLMWIKI bundle과 app-owned storage를 신뢰한다. Candidate 내부 schema digest를
pinned bundle과 직접 결박하고 normalized input을 dirfd 기반 immutable snapshot으로 builder에 넘기는
작업은 추가 hardening으로 남는다. 면접에서는 “aggregate hash만으로 승인 경계를 만들 수 없는 이유”,
“원본 write 뒤 파생 build 실패를 어떻게 retry와 Undo로 수렴시키는가”, “다중 파일 논리 문서를 왜 먼저
read-only로 출시했는가”를 설명할 수 있다.
## 2026-07-23 — 자연어 삭제와 보고서 생성 요청이 unsupported로 종료됨

### 상황과 영향

같은 대화에서 조회·수정을 마친 `일일업무.hwp`를 “일일업무 보고서 파일 삭제해줘”라고 요청하면
`UNSUPPORTED_AGENT_REQUEST`가 반환됐다. “이번주 보고서를 보고 주간업무보고서.hwpx를 만들어줘”도 같은
오류로 끝났다. 기대 동작은 현재 문서 근거로 대상을 다시 확인한 뒤 각각 삭제 승인 preview와 새 HWPX
생성 승인을 제시하는 것이었다.

### 증거와 원인

단일 파일 삭제는 ChatService 입구의 확장자 포함 filename 정규식만 통과할 수 있었고 그 밖의 표현은
Claude로 넘어갔지만 structured output은 locate/change만 표현했다. 생성은 response model과 Electron
sidecar 실행 계약 자체가 없었다. 정규식을 확대하는 방법은 대화 문맥과 자연어 제목을 계속 누락하고,
Claude에 파일 도구를 여는 방법은 application-owned 승인 경계를 깨므로 제외했다.

### 해결과 검증

Agent가 `delete_file`과 `create_file`을 typed decision으로 선택하고 현재 turn의 검색·문서 확인을 다시
수행하게 했다. 삭제는 기존 exact `plan_hash`, atomic delete와 Undo를 그대로 사용한다. 생성은 canonical
근거에서 Markdown을 제안하고 Electron이 실제 대상과 전체 new-file diff를 승인받은 뒤 Kordoc 생성,
재파싱과 no-overwrite 게시를 수행한다. Backend 전체 pytest, Ruff, mypy가 통과했고 prompt/schema/chat
회귀 테스트에 두 사용자 문장을 고정했다.

### 재발 방지와 남은 위험

새 lifecycle intent는 typed schema와 tool trace test, prompt eval case를 함께 추가한다. 모델 출력은 여전히
proposal일 뿐 write authority가 아니다. 실제 사용자 corpus에서 보고서가 여러 개면 임의 선택하지 않고
clarification으로 닫히며, 서명된 설치본의 Kordoc packaging은 release gate에서 다시 확인한다.

## 2026-07-23 — Monorepo 병합 뒤 지식 빌드가 sidecar 시작 단계에서 실패

### 상황, 기대와 영향

`folding_ghdtjdwn` main에서 Electron integrated runtime을 시작하면 doc2md는 등록 문서를 정상 변환했지만
지식 빌드가 실패하고 검색 엔진이 준비되지 않았다. 기대 동작은 같은 monorepo의 Backend와 bundled
LLMWIKI가 하나의 요청 계약으로 시작해 immutable build를 공개하는 것이었다. 원본 문서 write는 없었고
기존 active 위키와 backup은 유지됐지만, sidecar가 없어서 채팅 검색·삭제 승인·HWPX 생성 흐름을 사용할
수 없었다.

### 재현, 증거와 원인

- integrated doc2md의 `POST /v2/convert`는 반복해서 HTTP 200을 반환했다.
- sidecar stderr의 최초 예외는
  `TypeError: WikiBuildRequest.__init__() got an unexpected keyword argument 'allowed_missing_link_targets'`
  였다.
- 새 Backend는 승인된 삭제 tombstone을 native build에 전달하도록 request 인자를 추가했지만, monorepo
  snapshot의 LLMWIKI request model에는 짝이 되는 필드가 없었다.
- Backend 단위 테스트는 fake runner로 pipeline scope를 검증했고 Electron 테스트는 child lifecycle을
  모사했기 때문에 실제 sibling package 생성자 불일치를 실행하지 않았다.

따라서 원인은 OCR, 사용자 문서, OAuth나 GitHub build가 아니라 Backend만 새 deletion contract로 올라가고
bundled LLMWIKI가 이전 생성자에 남은 cross-package version skew였다.

### 검토한 대안과 해결

Backend가 인자를 모를 때 생략하는 signature fallback은 최초 기동만 통과시키고 실제 삭제 build에서
broken-link와 stale enrichment 검증을 잃으므로 제외했다. 모든 missing link를 전역 허용하는 방법도 오타와
손상된 관계를 숨기므로 제외했다.

Bundled LLMWIKI의 `WikiBuildRequest`와 `WikiScope`가 exact
`allowed_missing_link_targets`를 전달하고 identifier를 검증하게 했다. Corpus와 enrichment는 그 집합에
포함된 삭제 target을 참조하는 기록만 stale로 제외하며, target 복원 뒤 다시 포함한다. Backend에는 실제
monorepo sibling module을 불러 request를 구성하는 contract test를 추가했다.

### 검증, 재발 방지와 남은 위험

LLMWIKI Ruff와 전체 pytest 43개, Backend Ruff·mypy·전체 pytest 279개, Electron sidecar 회귀 테스트
15개·typecheck·production build가 통과했다. 실패 당시 사용자 데이터의 격리 복사본과 같은 input snapshot
hash로 sidecar를 직접 시작해 application startup, 새 native build와 index load를 확인했다. 이어서
real OAuth integrated runtime의 실제 managed sidecar에서 health `ok`, converter·graph·index·worker·agent
준비와 pending/failed/stale sync event 0건을 확인했다.

앞으로 bundled dependency의 요청 필드를 바꿀 때는 fake adapter 테스트만으로 완료하지 않고 실제 sibling
package 생성자와 integrated sidecar startup을 함께 실행한다. 서명 installer의 bundled resource 조합은
release smoke가 별도로 필요하다. 면접에서는 “하위 package version skew를 어떤 executable contract로
막는가”, “삭제 때문에 broken-link 검증을 전역 완화하지 않고 exact scope로 제한한 이유는 무엇인가”를
이 증거로 설명할 수 있다.
