# Work log

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
- 전달 상태: 로컬 구현과 집중 검증 완료. 전체 Backend gate, commit·push·PR·merge와 앱 재실행은 진행 중.

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
