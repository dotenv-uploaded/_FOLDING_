# Work log

## 2026-07-23 — 채팅 추천 명령을 읽기·수정·삭제로 구분

- 목표: 빈 채팅 화면의 혼합된 예시를 실제 문서 작업 유형에 맞춰 빠르게 선택할 수 있게 한다.
- 변경: 추천 명령을 읽기, 수정, 삭제 카드로 나누고 각 범주에 두 개의 실행 가능한 예시를 배치했다.
  삭제 카드는 승인 후 실행과 Undo 가능성을 명시하며 단일 파일·계약서 일괄 삭제 예시를 제공한다.
- 검증: TypeScript typecheck, Vitest 143개 통과, 선택적 integration fixture 1개 skip, Electron
  production build 성공.
- 전달 상태: 로컬 구현과 검증 완료. 기존 사용자 변경을 보존했으며 commit·push는 수행하지 않음.

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
