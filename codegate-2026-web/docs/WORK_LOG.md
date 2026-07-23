# Work log

## 2026-07-23 — 분리 저장소 잔여 파일 통합

- 목표: 공개 monorepo 하나만으로 심사와 재현이 가능하도록 분리된 로컬 저장소에만 남아 있던
  Supabase migration, XLSX 안전 정규화, 통합 launcher helper와 회귀 테스트를 모두 포함한다.
- 변경: Custom Access Token hook migration을 복원했다. doc2md는 XLSX를 request-local copy에서
  정규화해 병합 hidden-cell 중복과 ZIP/XML resource abuse를 차단하고 원본 bytes를 보존한다.
  Electron launcher는 child 종료 판정과 최소 환경 전달을 별도 helper로 사용하며 Windows `.cmd`
  실행과 `DOC2MD_DATA_ROOT` 전달을 보존한다.
- 영향: Backend 배포 자산, doc2md XLSX converter와 dependency lock, Electron 통합 개발 launcher.
  사용자 문서 승인·원본 쓰기 계약은 변경하지 않는다.
- 검증: XLSX 집중 테스트 8개, doc2md 전체 117개, launcher 집중 테스트 3개, Electron 전체
  159개 통과·환경 의존 1개 skip, TypeScript typecheck와 Node 구문 검사를 통과했다.
- 전달 상태: 공개 `ghdtjdwn_complete` main 반영과 fresh clone 확인을 진행한다.

## 2026-07-23 — README 시연 영상 호환성 수정

- 문제와 원인: README의 저장소 MOV 파일 링크가 GitHub에서 플레이어 대신 바이너리 파일 화면으로
  열렸다. GitHub Markdown은 저장소의 HTML `video` 태그를 제거하며 영상 플레이어는 첨부 파일
  URL에 적용되는 동작이었다.
- 변경: 로그인과 폴더 경로가 표시되는 첫 구간을 제외하고 계정 라벨 영역을 배경색으로 가린
  브라우저 호환 H.264/yuv420p MP4를 만들었다. README 안에서 별도 플레이어 없이 전체 공개 구간이
  재생되는 560×482 GIF를 추가하고, 고화질 MP4는 GitHub 파일 페이지의 raw 보기로 연결한다.
- 검증: MP4 전체 frame decode, codec, pixel format, fast-start container와 GitHub Markdown
  렌더 결과를 확인했다. GIF는 5fps, 188.8초로 전체 공개 구간과 GitHub 이미지 제한을 충족한다.
  기존 MOV는 현재 tree에서 제거하고 로컬 원본 파일은 보존했다.
- 전달 결과: 복구용 bundle을 만든 뒤 원본 MOV와 이전 MP4를 main 이력에서 제거하고
  force-with-lease로 교체했다. gitleaks finding 0건을 확인한 후 저장소를 public으로 전환했으며,
  비로그인 요청에서 저장소·README·GIF·MP4가 모두 HTTP 200을 반환했다.

## 2026-07-23 — 단일 저장소 새 컴퓨터 재현 경로

- 목표: 현재 동작하는 Electron·Backend·doc2md·LLMWIKI 조합을 개인 설정이나 기존 가상환경에
  의존하지 않고 새 컴퓨터에서 같은 저장소만으로 설치·실행하게 한다.
- 변경: pnpm과 uv lockfile을 고정해 전체 로컬 runtime을 준비하는 루트 bootstrap과 실제
  Google OAuth·고정 callback·Claude Sonnet으로 실행하는 스크립트를 추가했다. doc2md는 bootstrap이
  만든 Python 3.12 가상환경을 자동 재사용하고, 없을 때만 기존 isolated uv 경로로 fallback한다.
  환경변수 예시는 monorepo 기본 경로와 실제 cloud API를 사용하며 자격증명은 계속 제외한다.
- 영향: 개발 설치·실행 경로와 문서만 변경한다. 문서 조회·승인·생성·삭제 계약과 사용자 데이터
  형식은 변경하지 않는다.
- 검증: Bash 구문 검사, TypeScript typecheck와 임시 fresh clone bootstrap을 실행해 pnpm 11.9.0
  frozen install, Backend Python 3.12 frozen sync, doc2md Python 3.12 frozen sync, `.env` 생성과
  미설정 API key fail-fast를 확인했다.
- 전달 상태: 전용 `ghdtjdwn` 저장소 main 반영을 진행한다.

## 2026-07-23 — Claude 기본 모델을 Sonnet으로 변경

- 목표와 변경: Electron sidecar의 Claude 기본 alias와 환경변수 예시를 `sonnet`으로 맞췄다.
- 영향: 모델 routing 설정만 변경하며 agent·승인·문서 처리 계약은 그대로다.
- 검증과 전달: TypeScript typecheck 통과. commit `189be80`을 전용 `ghdtjdwn` 저장소 main에
  push했고, 저장 OAuth 세션을 복구 가능한 백업으로 이동한 뒤 실 OAuth·Sonnet으로 앱을 재시작해
  로그인 화면을 확인했다.

## 2026-07-23 — 복수 업무보고 HWPX 생성 route 고정

- 목표: 사용자가 참고 파일을 하나씩 지정하지 않아도 에이전트가 이번 주 업무보고 문서를 검색·검증해
  `주간업무보고서.hwpx` 생성 미리보기를 만들게 한다.
- 변경: 명시적인 HWPX 생성 요청의 파일명과 source 검색 주제를 application-owned routing hint로
  전달한다. 에이전트는 관련 업무진행 기록과 주간 성과 자료를 검색한 뒤 각 stable ID와 canonical
  본문을 현재 turn에서 직접 검증한다. 복수 프로젝트·형식이라는 이유만으로 재질문하지 않게 했다.
- 영향: Backend agent turn envelope, system prompt, 생성 검색어와 회귀 테스트. evidence, ACL, 승인,
  no-overwrite HWPX 쓰기 경계는 그대로다.
- 검증: agent prompt/runtime 집중 테스트 94개, Ruff·mypy 통과. 실 OAuth·Opus 앱과 sidecar health
  200 확인.
- 전달 결과: commit `f5199a0`을 전용 `ghdtjdwn` 저장소 main에 push했다. 실 OAuth·Opus 앱은
  반영된 코드로 실행 중이다.

## 2026-07-23 — 복원 HWP 동기화 복구와 주간보고 생성 검색 안정화

- 목표: 복원된 `일일업무.hwp` 편집의 부분 완료를 실제 위키 게시까지 복구하고, 붙여 쓴 HWPX 생성
  파일명과 빈 검색 결과가 내부 도구 오류를 만들지 않게 한다.
- 변경: active manifest에 복원된 문서의 stale 삭제 tombstone을 검증된 update event에서만 해제한다.
  앱이 증명한 전체 normalized-input snapshot의 동시 migration은 candidate fragment가 현재 입력
  경로·SHA와 일치할 때만 허용한다. Claude의 정렬된 빈 검색 query를 실제 tool evidence에 결박하고,
  한국어 파일명형 문서 복합어를 제한적으로 분해해 주간·업무·보고서 자료를 찾게 했다.
- 영향: Backend LLMWIKI 복구 검증, agent tool-trace 검증, 지식 검색 token화와 회귀 테스트. 원본 승인,
  ACL, exact plan hash, HWPX no-overwrite 생성 경계는 변경하지 않았다.
- 실행 설정: Claude Agent SDK가 지원하는 `opus` alias를 기본 모델로 지정하고 환경변수 예시도 같은
  값으로 맞췄다. `CODEGATE_CLAUDE_MODEL`을 명시하면 기존처럼 실행별 override할 수 있다.
- 검증: 실패 실행을 재처리해 `build-33d85e0c8aec1f833d97` 게시와
  `completed/applied/published` 상태, 원본 SHA 유지, active build 작성자 `성선제`, sync 실패 0건을
  확인했다. Backend 전체 pytest 285개와 Ruff·mypy, Electron Vitest 156개·typecheck·production
  build, 실제 corpus 검색을 통과했다. Opus 변경 뒤 typecheck와 production build는 통과했고, 실행 중인
  앱과 동시에 다시 돌린 Vitest는 155개 통과·환경 의존 1개 skip·process-group 재시작 timing 1개
  실패였다.
- 전달 상태: 동기화·검색 수정은 PR #4로 main에 병합했다. Opus 기본값 변경을 후속 반영한다.

## 2026-07-23 — 복수 업무 문서를 종합하는 HWPX 생성 라우팅

- 목표: 여러 이번 주 업무보고 문서를 근거로 진행사항·완료 업무·이슈·다음 주 계획을 정리한 HWPX 생성
  요청이 재질문으로 끝나지 않고 승인 미리보기까지 이어지게 한다.
- 변경: Backend 생성 결정을 단일 source에서 순서가 고정된 최대 20개 source로 확장했다. 검색어에서는
  출력 section 요구를 제거하고, 검색된 각 문서의 ID와 canonical 본문을 현재 turn에서 검증한다.
  ChatService는 모든 source의 ACL과 존재를 다시 확인한 뒤 기존 Electron 생성 승인 계약으로 전달한다.
- 영향: agent structured output·prompt·tool trace, ChatService 생성 응답과 관련 회귀 테스트. 실제 파일
  생성, no-overwrite, 재파싱과 사용자 승인 경계는 변경하지 않았다.
- 검증: 사용자 문장 기반 API 테스트를 포함한 Backend 전체 pytest 281개, Ruff·mypy, Electron 전체
  Vitest 156개 통과·환경 의존 integration 1개 skip, TypeScript typecheck와 production build 성공.
- 전달 결과: commit `d3c8f62`를 push하고 PR #3을 생성했다. required check가 없는 저장소에서
  mergeable/CLEAN 상태를 확인했으며 main 병합과 앱 재실행은 진행 중.

## 2026-07-23 — 기존 XLSX 입력의 병합 hidden-cell 교정 마이그레이션

- 목표: doc2md의 XLSX 병합 hidden-cell 중복 수정이 이미 등록된 같은-SHA 문서에도 한 번 적용되게 한다.
- 변경: ownership manifest의 기존 `normalizerVersion` 계약을 XLSX에도 적용해 version 1이 없는 XLSX는
  doc2md로 재변환하고, 성공 뒤 marker를 기록해 다음 sync부터 bytes를 보존한다. HWP version 3과 다른
  형식의 same-SHA 보존 계약은 유지한다.
- 검증: marker 없는 XLSX가 정확히 한 번 재변환되고 revision 2와 marker 1로 안정화하는 테스트,
  TypeScript typecheck와 전체 Vitest 148개 통과·선택적 integration 1개 skip을 확인했다. converter 전체
  pytest 117개와 실제 `GBX-ONB-003` 원본 SHA 불변·병합 문장 8→1도 확인했다.
- 전달 상태: 로컬 구현과 검증 완료. 원본 XLSX·ZIP은 변경하지 않았고 commit·push·배포는 수행하지 않음.

## 2026-07-23 — 실제 업무기록 corpus의 삭제·복원 링크 보존

- 목표: 실제 9종 문서 corpus에서 승인된 파일 삭제와 Undo 뒤 Electron이 만드는 문서 관계 링크가 현재
  파일 집합과 항상 일치하게 한다.
- 변경: Electron crosslink는 기존 내부 링크를 수정하지 않고 plain document code만 새 링크로 만든다.
  승인 삭제 시 사라진 target의 graph edge 처리는 Backend가 정확한 삭제 ID를 LLMWIKI에 결박해
  수행하므로 수동 링크와 section anchor가 normalized input에 그대로 남는다.
- 검증: 실제 DOCX·HWP·HWPX·PDF·PPTX·XLSX 9개 변환과 정확한 파일명 검색 9/9, HWP 승인 변경·Undo,
  PDF 승인 삭제·재시작 retry·Undo와 peer input hash 불변을 확인했다. TypeScript typecheck, Vitest
  148개 통과·선택적
  integration 1개 skip, Electron production build가 성공했다.
- 전달 상태: 로컬 구현과 검증 완료. 원본 ZIP은 변경하지 않았고 commit·push·배포는 수행하지 않음.
- 남은 일: ZIP 직접 import는 지원하지 않으므로 현재는 압축 해제한 폴더를 등록해야 한다.

## 2026-07-23 — 등록 폴더 기반 채팅 추천 명령

- 목표: 빈 채팅 화면의 추천이 고정 예시가 아니라 사용자가 등록한 폴더의 실제 문서와 기능 범위를
  반영하게 한다.
- 변경: 파일 트리 변경마다 추천을 다시 계산한다. 일정·리스크, 회의록, 성과보고, 승인서와 계획서의
  파일명에 맞는 조회 명령을 만들고 HWP/HWPX/Markdown/TXT가 있을 때만 수정 준비를 표시한다. 삭제는
  중복되지 않은 실제 파일명을 사용하며, 계약서가 여러 개일 때만 일괄 삭제를 제안한다.
- 검증: 추천 집중 테스트 5개, TypeScript typecheck, 전체 Vitest 148개 통과, 선택적 integration
  테스트 2개 skip, Electron
  production build 성공.
- 전달 상태: 로컬 구현과 검증 완료. 기존 사용자 변경을 보존했으며 commit·push는 수행하지 않음.

## 2026-07-23 — 채팅 기반 실제 HWPX 생성과 안전한 게시

- 목표: `이번주 보고서를 보고 주간업무보고서.hwpx를 만들어줘` 요청을 답변 문구가 아니라 실제 파일
  생성으로 완료하고, 자연어 파일 삭제도 agent routing 결과를 기존 승인 흐름에 연결한다.
- 변경: sidecar chat 계약에 grounded HWPX preview를 추가했다. 등록 폴더의 충돌 없는 경로와 전체
  new-file diff를 승인 모달에 보여준 뒤 설치된 Kordoc으로 임시 HWPX를 만들고 재파싱한다. 검증된
  candidate만 hard-link no-replace로 게시하며 취소·이름 충돌·빈 파일·재파싱 실패에는 대상 파일을
  남기지 않는다. 성공 파일은 기존 watcher가 후속 지식 빌드에 반영한다.
- 영향: sidecar client/agent, 실제 Kordoc 생성 경계와 생성 회귀 테스트.
- 검증: 실제 설치 Kordoc으로 HWPX 생성·재파싱과 전체 sidecar 승인 흐름을 실행했다. TypeScript
  typecheck, 전체 Vitest 156개 통과(환경 의존 통합 테스트 1개 skip), Electron production build가
  성공했다.
- 전달 결과: 전용 monorepo commit `228f17f`로 push하고 PR #1을 통해 main 병합 절차를 실행함.

## 2026-07-22 — 파일 삭제 개별 승인과 복원 안내 연결

- 목표: Backend의 단일·일괄 파일 삭제 plan을 원본 변경 전에 사용자가 파일별로 확인하게 한다.
- 변경: change operation과 복수 plan 계약을 sidecar client에 반영하고, 각 plan을 순차 승인·거부하며
  삭제 전용 도구명·경고·완료 및 Undo 안내를 표시한다. 모든 execution과 provisional ID를 SQLite에
  보존하고 승인 응답 유실에는 같은 idempotency key로 복구하며, 미완료 실행은 상태를 다시 조회한다.
- 검증: TypeScript typecheck와 Vitest 141개 통과, 선택적 integration fixture 1개 skip.
- 전달 상태: 로컬 구현과 검증 완료. commit, push, PR, 배포는 수행하지 않음.

## 2026-07-22 — 팀원 원격 변경 선별 통합

- 목표: 팀원 저장소의 후속 변경을 기존 로컬 HWP·채팅 작업과 충돌 없이 반영한다.
- 변경: Folding 디자인 규격 문서를 추가하고 HTTP 상태와 오류 cause 사슬을 진단 로그에 보존했다.
  합성 코퍼스 여부도 sidecar 환경에 전달한다.
- 검증: Node/Web TypeScript typecheck가 통과했다.
- 전달 결과: 로컬 변경만 반영했으며 commit, push, PR, 배포는 수행하지 않았다.
- 결정: 접근 가능한 개인 저장소가 대화에서 설명한 SemanticEdit 구현 이전 스냅샷이므로 이를
  추정 병합하지 않고, 공식 저장소에 확인 가능한 변경만 선별했다.

## 2026-07-22 — OAuth 로그인 완료 화면 개선

- 목표: Google OAuth callback의 단순 문장을 Folding 제품 UI와 맞는 완료 화면으로 바꾸고
  사용자가 별도로 탭을 정리하지 않아도 되게 한다.
- 변경: Folding 브랜드 색·타이포·카드 스타일을 사용한 독립형 성공 페이지, 3초 카운트다운과
  `window.close()` 호출, 브라우저가 자동 닫기를 막을 때의 수동 안내, CSP·no-store·referrer와
  permissions 보안 헤더를 추가했다.
- 영향: Electron OAuth loopback 성공 응답과 관련 회귀 테스트.
- 검증: OAuth 집중 테스트 8개, Node/Web typecheck, 전체 Vitest 129개가 통과했다. opt-in 통합
  테스트 1개는 기존 설정대로 제외됐고 Electron production build가 성공했다.
- 전달 결과: 로컬 구현과 검증 완료. commit, push, 배포는 수행하지 않았다.

## 2026-07-22 — HWP 전체 본문 동기화와 안전한 로컬 편집 runtime 연결

- 목표: 정확한 HWP 파일명 조회와 표 필드 변경·후속 삭제가 일반 재질문으로 끝나는 통합 장애를
  해결하고, sidecar가 원본과 같은 전체 본문을 검색·편집하게 한다.
- 변경: source sync가 Kordoc full-body parse와 새 normalizer snapshot을 사용한다. Electron은 Kordoc
  entry와 필수 117-package dependency graph의 검토된 digest, Node 실행 경로와 snapshot attestation을
  최소 환경으로 sidecar에 전달한다. 개발 앱은 PATH의 Node permission model을 사용하며 dependency
  graph 변경은 시작 전에 fail-closed하고 Backend도 실행 직전에 다시 검증한다.
- 영향: 서비스 초기화, sidecar supervisor·input sync, Kordoc runtime attestation과 관련 테스트.
- 검증: 전체 Vitest 139개 통과, opt-in 통합 테스트 1개 제외. 실제 설치 graph의 TypeScript와 Python
  digest가 일치했고, 임시 HWP 왕복 patch·재parse·restore 및 네 대화의 sidecar HTTP 흐름에서 원본 SHA가
  유지됐다.
- 전달 결과: 로컬 구현과 검증 완료. commit, push, PR, 배포는 수행하지 않았다.
- 남은 작업: 서명된 설치본의 ASAR/resource 및 standalone Node bundle smoke. production build와 광범위
  추가 검증은 이번 집중 범위에서 다시 실행하지 않았다.

## 2026-07-22 — Railway 웹 프런트 배포 준비

- 목표: Electron 제품 UI를 훼손하지 않고 Railway에서 확인 가능한 브라우저 데모를 제공한다.
- 변경: 공용 preload API 타입 분리, 웹 메모리 bridge, 브라우저 전용 Vite build, 보안 정적 서버,
  multi-stage Dockerfile, Railway healthcheck를 추가했다.
- 영향: renderer, preload 타입 계약, 빌드·배포 설정, 공개 문서.
- 검증: typecheck, Vitest 55개, Electron production build, web production build, Docker build,
  container health·SPA fallback·보안 헤더를 실제 실행했다. opt-in 통합 테스트 1개는 제외됐다.
- 결정: 웹은 명시적 UI 데모이며 문서 내용·API 키를 서버로 보내지 않는다. 실제 분석·수정은
  Electron과 로컬 sidecar가 계속 소유한다.
- 배포 결과: Railway `codegate-frontend/frontend` production 배포가 성공했고
  `https://frontend-production-a058.up.railway.app`에서 원격 `/health`, SPA fallback, 보안 헤더와
  Chrome 초기 화면 렌더링을 확인했다.

## 2026-07-22 — 원격 변경 통합과 OAuth 충돌 해결

- 목표: `integration/local-sidecar-runtime`의 원격 15커밋을 기존 로컬 작업과 합친다.
- 변경: 원격 브랜치를 fast-forward한 뒤 OAuth callback, Google 세션 저장, runtime config,
  sidecar 초기화와 관련 테스트 충돌을 양쪽 계약을 보존하도록 해결했다.
- 영향: Electron 인증·서비스 초기화, sidecar 설정, 배포 문서와 lockfile.
- 검증: TypeScript Node·Web typecheck, Vitest 128개, Electron production build가 통과했다.
  opt-in 통합 테스트 1개는 실행 대상에서 제외됐다.
- 전달 결과: 로컬 브랜치는 원격 최신 커밋을 포함하며 병합 결과는 미커밋 상태로 남겼다.
- 남은 작업: Claude Agent SDK의 파일 수정 실패는 별도 작업으로 재현하고 수정한다.

## 2026-07-22 — 채팅 탐색·정리 기능과 닫힌 출력 스트림 안정화

- 목표: 채팅 입력의 중복 포커스 테두리를 제거하고 새 채팅·추천 질문 흐름을 단축하며, 대화 목록을
  핀·이름 변경·보관·삭제로 정리할 수 있게 한다. 터미널 종료 뒤 반복되던 `write EIO` 예외도 막는다.
- 변경: 새 채팅이 그래프 탭에서 채팅 탭으로 이동하고, 추천 질문은 클릭 즉시 전송된다. 우클릭 대화
  메뉴와 보관 목록을 추가하고 상태를 SQLite migration과 IPC에 영속화했다. sidecar stdout은 console
  재전송 없이 계속 배출하고 stderr는 진단 꼬리만 보존해, 닫힌 터미널에 쓰면서 발생하던 `EIO`를
  원천 차단했다. 메인 출력 스트림 보호는 `EIO`·`EPIPE`에 대한 보조 방어로 유지한다.
- 영향: renderer 채팅 상태·목록·입력, preload/IPC 계약, 채팅 서비스와 SQLite conversation schema,
  웹 데모 bridge, 메인 프로세스 로그 처리.
- 검증: 채팅 저장소와 sidecar 출력 집중 테스트 16개, TypeScript typecheck, 전체 Vitest 137개가
  통과했다. opt-in 통합 테스트 1개는 기존 설정대로 제외됐고 Electron
  production build가 성공했다.
- 전달 결과: 로컬 구현과 검증 완료. commit, push, 배포는 수행하지 않았다.
