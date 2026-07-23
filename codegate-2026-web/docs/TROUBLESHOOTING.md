# Troubleshooting

## 2026-07-23 — converter를 고쳐도 기존 XLSX normalized input이 갱신되지 않음

### 맥락과 원인

XLSX 병합 hidden-cell 중복을 converter에서 제거해도 Electron input sync는 source URI와 SHA가 같으면
기존 Markdown을 승인된 상태로 보존한다. doc2md raw cache도 pipeline version이 같으면 예전 중복 본문을
반환한다. 새 문서는 고쳐지지만 이미 등록한 업무기록의 검색 근거는 그대로 남는 부분 마이그레이션
문제였다.

### 해결과 검증

doc2md raw cache key를 v3로 올리고 Electron ownership manifest는 XLSX normalizer version 1을 요구한다.
marker가 없는 기존 XLSX만 한 번 재변환해 revision을 올리고, 성공한 marker가 있으면 이후 same-SHA sync는
다시 원자 보존한다. 모든 형식을 무조건 재변환하거나 구조상 정상인 Markdown을 손상으로 판정하는 방식은
불필요한 원본 읽기와 승인 결과 덮어쓰기를 일으켜 사용하지 않았다.

marker 제거→재변환→다음 sync unchanged 순서를 회귀 테스트로 고정했다. TypeScript typecheck, 전체
Vitest 148개가 통과했고 선택적 integration 1개는 기존 설정대로 skip됐다. 실제 XLSX는 source SHA를
유지하면서 병합 관계 문장 8→1, R-01~R-03 각 1회로 변환됐다.

### 재발 방지와 남은 위험

converter semantics가 같은 source bytes의 normalized output을 바꿀 때는 converter cache key와 해당
format의 Electron normalizer marker를 함께 올린다. doc2md가 연결되지 않은 상태에서는 stale XLSX를
조용히 재사용하지 않고 재변환 실패로 닫힌다.

## 2026-07-23 — 문서 삭제 뒤 생성된 crosslink가 사라진 target을 계속 참조

### 맥락과 원인

실제 업무기록 PDF의 승인 삭제에서 원본은 quarantine으로 이동했지만 다른 normalized 문서에 남은
`[CODE](DOC-….md)` 링크 때문에 Backend의 broken-link validation이 새 지식 버전을 거부했다. 기존
crosslink는 plain code를 링크하는 추가 방향만 처리하고, corpus에서 문서가 빠졌을 때 과거 생성 링크를
되돌리지 않았다. validation을 끄면 손상된 graph가 게시되므로 해결책이 될 수 없었다.

### 해결과 검증

각 sync에서 Folding이 생성하는 내부 문서 링크만 plain code로 되돌린 뒤 현재 문서 code index를
기준으로 다시 링크하는 초기 접근은 수동 DOC 링크와 section anchor의 provenance를 구분할 수 없어
폐기했다. Electron은 기존 링크를 그대로 보존하고 plain code에만 새 링크를 만든다. Backend가 승인된
삭제 ID를 LLMWIKI stage·activation에 전달하면 builder가 그 target의 graph edge만 제외하며, Undo 뒤
원본 링크에서 관계가 다시 생성된다.

기존 내부 section 링크, 외부·사용자 링크 보존을 회귀 테스트로 추가했다. 실제 PDF 삭제 retry에서
peer normalized input hash 불변과 대상 graph edge 0건, Undo 뒤 38개 관계 링크 복원을 확인했고
TypeScript typecheck, Vitest 147개 통과·선택적 integration 1개 skip, Electron production build가
성공했다.

### 재발 방지와 남은 위험

crosslink는 기존 Markdown 링크를 source of truth로 보존한다. 삭제 예외는 UI 추론이 아니라 승인된
Backend operation의 정확한 document ID에서만 나오며, 다른 깨진 링크는 계속 build 실패한다.

## 2026-07-22 — 파일 삭제 preview를 일반 문서 수정으로 표시

Backend에 복구 가능한 삭제 plan이 추가돼도 Electron 계약에는 operation type과 복수 plan이 없어 삭제를
일반 `approve_change_plan`으로 표시하고 한 계획만 처리할 수 있었다. Sidecar 응답에 discriminated
operation과 `change_plans`를 반영하고, 삭제는 파일별 승인 모달과 복원 가능한 backup 경고를 사용하게
했다. 거부된 파일은 reject API만 호출하고 다음 파일로 진행한다. TypeScript typecheck, 승인 요청의 exact
plan hash·삭제 label·Undo 안내 단위 테스트와 전체 Vitest 141개가 통과했다.

독립 리뷰에서 일괄 삭제의 마지막 execution만 메시지에 남고 approve 응답 유실 때 Undo 진입점이
사라지는 문제를 추가로 확인했다. 메시지 schema와 SQLite migration에 execution 배열을 추가하고 승인
HTTP 전 deterministic provisional ID를 즉시 저장한다. approve는 plan별 고정 idempotency key를 사용해
중단 시 같은 요청을 복구하며, 미완료 카드는 예약 ID로 서버 상태를 다시 확인한다.

## 2026-07-22 — HWP 표 필드가 검색되지 않고 변경 대화가 재질문으로 종료

### 맥락과 영향

실제 Electron 대화에서 희소 주장의 근거 검색은 관련 없는 일반 문서를 우선했고, 정확한 HWP 파일명을
지정한 표 필드 조회·변경과 같은 대화의 후속 삭제는 모두 더 구체적으로 적으라는 응답으로 끝났다.
원본 쓰기는 일어나지 않았지만 문서 검색과 승인 편집의 핵심 흐름을 사용할 수 없었다.

### 증거와 원인

기존 HWP 변환 결과는 첫 페이지 표를 누락했고 source artifact에는 정확한 filename 우선순위가 없었다.
Electron은 converter의 write-back=false만 따라 HWP를 read-only로 내렸으며, sidecar는 현재 request를
기록한 뒤 이전 history를 읽어 후속 삭제 대상을 잃었다. 같은 source SHA의 변환 결과만 교정했을 때는
active LLMWIKI가 재build되지 않았다. 검색 쪽에서는 흔한 단어의 chunk-local OR 점수가 희소 단어를
이겼고 모델의 요약 query가 실제 tool trace와 다를 수 있었다.

### 해결과 검증

Input sync를 Kordoc full-body parse로 바꾸고 filename과 input snapshot을 보존했다. Kordoc entry와 필수
dependency graph 전체를 pinned digest로 확인한 뒤 개발 앱에서는 PATH의 Node를 사용하며, sidecar child에는
허용된 package 경로와 최소 환경만 전달한다. Backend는 exact filename/희소 term ranking, conversation
history, trace binding, 승인 preview, HWP atomic patch·재parse·Undo와 same-SHA publish recovery를
담당한다.

전체 Vitest 139개가 통과했고 opt-in 통합 테스트 1개는 제외됐다. 설치 graph는 양쪽 구현에서 같은
digest였고 임시 HWP patch·restore 뒤 원본 SHA가 같았다. sidecar HTTP에서 요청한 네 흐름이 각각 근거,
필드 조회, 변경 preview와 문맥 기반 삭제 preview를 반환했으며 preview는 reject했다.

### 재발 방지와 남은 위험

실제 설치 graph digest와 dependency mutation, full-body input sync, supervisor 환경 전달을 회귀 테스트로
고정한다. Electron 33 내장 Node 20은 permission flag와 pnpm symlink resolution이 충돌해 개발 경로에서
제외했다. 서명된 설치본의 ASAR/resource와 standalone Node bundle은 아직 release smoke 대상이다.
packaged runtime이 검증된 Kordoc 경로를 찾지 못하면 HWP capability는 fail-closed한다.

- 왜 converter 결과만 바꾸면 충분하지 않았나? 기존 active build는 같은 source SHA를 정상 상태로
  보았고 교정된 normalized input을 publish하지 않았기 때문이다.
- 왜 Electron-as-Node를 사용하지 않나? 현재 Electron 내장 Node의 permission model이 pnpm symlink
  dependency resolution을 막아 검증 graph를 로드하지 못하기 때문이다.
- 왜 entry 파일뿐 아니라 dependency graph도 검증하나? 실제 parser 동작 대부분이 transitive package에
  있으므로 entry hash만으로 실행 코드를 고정할 수 없기 때문이다.

## 2026-07-22 — Electron renderer를 Railway에 올리면 첫 로딩이 끝나지 않음

### 상황과 영향

Railway에서 프런트 화면을 공개하려 했지만 저장소의 프런트는 일반 웹 앱이 아니라 Electron
renderer였다. renderer 산출물만 정적 서빙하면 화면은 내려오지만 앱 초기화가 완료되지 않아
사용자가 제품 UI에 진입할 수 없다.

### 기대와 실제

- 기대: Railway URL에서 로그인과 문서 화면을 확인한다.
- 실제: `useSession`, `useWorkspace`, `useApproval`이 시작과 동시에 `window.codegate`를 호출하지만
  브라우저에는 Electron preload가 없어 첫 로딩에서 실패한다.

### 근거와 원인

`src/preload/index.ts`가 `contextBridge.exposeInMainWorld`로 API를 주입하고 main process가 OS 폴더,
SQLite, child process sidecar를 소유한다. Railway 컨테이너는 이 preload와 사용자 로컬
파일시스템을 브라우저에 제공할 수 없다. 배포 설정 문제가 아니라 런타임 경계 불일치가 원인이다.

### 검토한 대안

- Electron을 headless container에서 실행하는 방식은 사용자에게 창과 로컬 파일 접근을 제공하지
  못해 기각했다.
- renderer 정적 파일만 서빙하는 방식은 preload 계약이 없어 기각했다.
- 실제 API 키를 브라우저 번들에 넣는 방식은 비밀 노출 때문에 기각했다.

### 해결

공용 `CodegateApi` 타입을 Electron 구현에서 분리하고 웹 전용 메모리 bridge를 추가했다. 웹은
폴더 파일명·트리·채팅 UI만 데모하며 실제 문서 분석과 수정은 하지 않는다. `vite.web.config.ts`,
비밀 제외 `.dockerignore`, multi-stage `Dockerfile.web`, 보안 헤더를 주는 Node 정적 서버와 Railway
healthcheck를 추가했다.

### 검증과 회귀 방지

웹 타입검사와 빌드, 기존 Electron 타입검사·55개 테스트·production build, Railway용 Docker build와
컨테이너 `/health`, SPA fallback, CSP를 모두 확인했다. 앞으로 Electron API가 바뀌면 두 bridge가
같은 `CodegateApi` 인터페이스를 구현해야 타입검사를 통과한다.

### 남은 위험과 인터뷰 질문

웹 데모는 새로고침 시 상태가 사라지고 실제 문서 내용을 분석하지 않는다. 실제 웹 제품 전환에는
tenant 격리, 업로드 수명주기, 변환 worker, 서버 비밀 관리가 필요하다. 설명할 핵심 질문은
“데스크톱 전용 기능을 웹 데모로 분리하면서 보안 경계를 어떻게 보존했는가?”다.

## 2026-07-22 — 실제 사용자 문서의 중복 H2가 sidecar 시작을 막음

### 맥락과 영향

doc2md 변환과 normalized input 저장은 끝났지만 sidecar startup의 LLMWIKI compatibility 단계가
`duplicate section anchor`로 종료됐다. 동일한 H2 제목이 한 문서 안에 반복됐고, LLMWIKI가
`document ID + H1 + H2`로 section ID를 만들기 때문에 두 섹션이 같은 anchor를 받은 것이 원인이다.

### 해결과 검증

원본이나 변환 본문을 삭제하지 않고 Electron 입력 어댑터가 normalized 사본의 두 번째 이후 동일
H2에 `· 2`, `· 3` suffix를 붙인다. fence 안의 Markdown 예시는 건드리지 않으며 이미 사용된 suffix와도
충돌하지 않게 다음 번호를 찾는다. 이전 실행이 남긴 invalid input은 source SHA가 같더라도 감지해
doc2md 결과로 복구하고 revision을 올린다.

중복 H2 최초 정규화와 같은 SHA의 legacy invalid input 복구를 회귀 테스트로 추가했다. 원본 파일은
변경하지 않으며 정상적으로 고유한 heading은 그대로 보존한다.

같은 corpus의 대형 문서에서는 LLMWIKI overlap chunk가 canonical section 안에서 여러 번 나타나
`evidence text is not unique`도 재현됐다. normalized 사본의 H2 본문을 현재 LLMWIKI chunk 한도보다
작은 2,200자 이하 섹션으로 나누고, H1과 첫 H2 사이의 preamble도 첫 섹션 분할에 포함했다. 실제
31개 문서 corpus에서 sidecar health `ok`, agent available, 새 knowledge version 활성화와 파일 상태
31개 `done`을 확인했다.

## 2026-07-22 — 최초 대량 변환에서 화면이 `빌드를 시작하는 중`에 고정됨

### 맥락과 영향

통합 개발 실행에서 폴더를 등록하면 doc2md가 OCR을 수행하고 normalized input을 차례로 만들었지만,
온보딩 화면은 `roots.add` IPC가 끝날 때까지 고정 문구와 spinner만 표시했다. 실제 출력 파일이 늘고
doc2md process가 CPU를 사용 중이어도 사용자는 정지나 실패로 판단할 수 있었다. 개발 launcher도
Electron을 띄우기 전에 deep health를 기다려 첫 화면 표시를 불필요하게 늦췄다.

### 원인과 해결

최초 `원본 → doc2md → LLMWIKI → sidecar` 흐름이 장시간 IPC 하나 안에서 동작하는데 파일별 상태를
기존 `build:state:changed` 채널로 보내지 않았고, 렌더러도 로컬 `submitting` boolean만 보고 있었다.
또한 등록 완료 직후 legacy `build.trigger`를 다시 호출해 같은 사용자 동작에 두 빌드 경로가 연결됐다.

- input sync가 시작, 현재 상대 파일, 완료 수, 전체 수와 변환·재사용 결과를 callback으로 보고한다.
- AppServices가 scan, convert, assemble, sidecar readiness를 하나의 진행률로 변환해 renderer에 보낸다.
- 온보딩은 현재 단계의 `n/N`, 파일명, progress bar와 백분율을 표시하고 실패 메시지를 그대로 보여준다.
- 폴더 등록은 즉시 확정해 메인 화면으로 이동하고, sidecar가 `ready`가 될 때까지 채팅만 비활성화한다.
  실패는 메인 화면의 build 상태에 남겨 등록 화면에 사용자를 가두지 않는다.
- production 등록 경로에서 legacy build의 중복 호출을 제거했다.
- 개발 launcher는 빠른 기본 health 뒤 Electron을 먼저 띄우고 OCR 초기화는 background conversion에서
  진행한다. 실제 통합 smoke만 긴 단일 요청으로 deep health를 검증한다.

### 검증과 회귀 방지

- input sync 진행 이벤트의 `0/N → 현재 파일 → 완료 n/N` 순서를 단위 테스트로 고정했다.
- TypeScript main/renderer typecheck, Vitest 46개, Electron production build가 통과했다.
- 실제 통합 smoke는 production input sync를 직접 호출하므로 fixture-only 우회를 허용하지 않는다.

첫 OCR 실행 시간은 사용자 문서 형식, Paddle model cache와 CPU에 따라 여전히 길 수 있다. 취소를
doc2md 요청까지 전달하는 AbortSignal 계약과 파일별 예상 시간 표시는 후속 개선 범위다.

## 2026-07-22 — 신규 폴더는 등록되지만 최초 검색 corpus가 비어 있음

### 맥락과 영향

실제 네 저장소 smoke는 미리 만든 `source-md/REG-100001.md`를 복사한 뒤 sidecar를 시작하고
있었다. 반면 Electron의 `addRoot`는 원본을 DB에 색인한 뒤 sidecar와 legacy build를 각각
시작했으며, sidecar가 읽는 app data의 `source-md`에는 아무 입력도 만들지 않았다. 신규 사용자는
폴더 등록 성공 화면을 보더라도 최초 LLMWIKI build가 빈 corpus이거나 시작 실패가 되는 결함이다.

### 원인과 해결

테스트 fixture가 production의 누락된 `원본 → doc2md → normalized input` 단계를 대신하고 있었고,
Electron legacy builder와 sidecar native builder의 저장소 layout도 달랐다. 폴더 등록 경로에
다음 단일 흐름을 추가했다.

```text
원본 scan·SHA 고정
→ loopback doc2md POST /v2/convert
→ stable path-based document ID와 LLMWIKI 1.0 front matter 생성
→ normalized input 원자적 저장
→ sidecar WikiBuildService 최초 build·활성화
```

같은 source URI·SHA는 sidecar가 승인 작업 중 갱신한 normalized input을 보존하고, SHA가 바뀔
때만 revision을 올린다. rename은 ownership manifest와 원본 SHA로 기존 ID·revision 계보를 찾고
source URI만 canonical percent-encoding해 갱신한다. input 경로는 모든 쓰기 전에 realpath까지
비중첩 검증하며, app ownership manifest가 없는 non-empty 디렉터리는 거부하고 manifest에 기록된
파일만 정리한다. path transport가 원본 절대경로를 전달하므로 doc2md URL은 인증정보 없는 loopback
HTTP로 제한했다. production `current.json` writer는 sidecar 하나로 고정하고 Electron의 기존
builder는 mock·호환 경로로 제한했다.

### 검증과 남은 위험

- normalized input 단위 테스트: 최초 변환, 동일 SHA no-op, rename ID 계승, revision 증가, 소유 파일만
  stale 정리, 예약문자 URI, loopback·경로 중첩 제한
- sidecar 수명주기 단위 테스트: health 직후 종료를 `ready`로 오인하지 않고 dispose가 crash restart
  timer를 취소함
- fixture seeder 없이 production `input-sync.ts`를 직접 실행한 실제 doc2md→LLMWIKI→sidecar smoke 통과
- exact diff 승인, 새 build publish, Undo와 후속 publish 통과

Sidecar lifecycle은 start/restart/stop을 직렬화하고, 예약 restart를 generation으로 무효화하며,
child event가 현재 소유 process에만 영향을 주게 했다. Anthropic 키 삭제는 기존 process 종료 확인이
실패하면 성공으로 숨기지 않는다. dev/smoke wrapper도 종료 신호에서 process group을 내리고 강제
종료 뒤 실제 exit를 확인한다.

앱 밖에서 원본 파일이 바뀌는 watcher 경로의 자동 재변환은 sidecar 승인 실행과 동시에 같은 입력을
쓰지 않도록 writer lock/event 계약을 추가한 뒤 활성화해야 한다. 플랫폼별 standalone Python
artifact와 서명된 installer도 별도 release gate로 남아 있다.

## 2026-07-22 — 실제 통합 smoke에서 doc2md와 sidecar가 시작 전에 종료

### 맥락과 영향

`codegate-2026-local`에서 민규 doc2md, 성주 sidecar, 용휘 LLMWIKI를 실제 프로세스로 띄워
검색→승인→재빌드→Undo를 검증하려 했다. 기대 결과는 두 health check가 준비 상태가 된 뒤
Electron이 사용하는 HTTP 계약으로 전체 흐름이 완료되는 것이었다.

처음에는 doc2md가 import 단계에서 종료됐고, Python 3.12 환경으로 바꾼 뒤에는 sidecar가 설정
검증 단계에서 종료됐다. 앱에서는 엔진 상태가 `ready`에 도달하지 못해 검색과 변경 흐름 전체가
막히는 영향이다.

### 재현과 증거

```bash
pnpm integrations:smoke
uv pip install --python ../codegate-2026-api/.venv/bin/python \
  --editable ../codegate-2026-api/services/doc2md --dry-run
```

- 기존 converter 루트 `.venv`는 Python 3.14였고 `pyhwp2md`가 없어 `app.converters` import가
  실패했다.
- dry run은 `paddlepaddle`에 cp314 wheel이 없어 doc2md 의존성 해석이 불가능하다고 보고했다.
- Python 3.12에서 doc2md deep health는 성공했다.
- 이후 sidecar는 `local environment requires CODEGATE_BOOTSTRAP_DEMO=false`로 종료됐다.
- Backend `Settings`는 local mode에서 auth, demo bootstrap, knowledge mode, LLMWIKI 경로와 CORS
  allowlist를 함께 요구하지만 Electron supervisor는 auth와 environment만 전달하고 있었다.

### 원인과 해결

첫 원인은 지원되지 않는 Python 3.14 ABI와 불완전한 로컬 환경을 실행 기준처럼 사용한 것이다.
두 번째 원인은 Backend CLI가 인자를 파싱하기 전에 기본 ASGI app을 import한다는 사실을 Electron
supervisor 환경 계약에 반영하지 않은 것이다.

Converter는 저장소 내부 venv를 전제로 하지 않고 `uv run --isolated --python 3.12`로 실행하게
했다. Sidecar는 `buildSidecarEnvironment`에서 local runtime invariant와 실제 source, LLMWIKI,
doc2md 경로를 CLI import 전에 모두 전달한다. 외부 환경이나 `extraEnv`가 local 안전 경계를
production/demo 값으로 덮어쓰지 못하게 최종 값을 고정했다.

Python 3.14 환경에 일부 패키지만 추가하는 대안은 Paddle wheel이 없어 제외했다. doc2md deep
health를 생략하는 방법은 실제 변환 불능을 숨기므로 제외했다. Backend CLI import 구조 자체를
이번 통합에서 재편하는 방법은 다른 저장소의 public entrypoint 변경 범위가 커 supervisor 경계에서
해결했다.

### 검증과 회귀 방지

- `tests/sidecar-supervisor.test.ts`: local runtime 환경 계약 포함 5개 통과
- doc2md v2/security/structure 집중 테스트: 54개 통과
- `pnpm integrations:smoke`: doc2md deep health, sidecar+LLMWIKI health, `REG-100001` 검색,
  exact diff 승인과 새 version publish, Undo와 원본 복구 통과
- smoke 종료 뒤 `services/doc2md/.venv`가 생성되지 않음을 확인

`buildSidecarEnvironment` 단위 테스트와 실제 네 저장소 smoke를 함께 유지한다. 단위 테스트는 필수
환경 누락을 빠르게 잡고, smoke는 import 순서·Python ABI·HTTP·build publication을 함께 잡는다.
부모 환경은 PATH·locale·임시/인증서 경로만 allowlist하고 child HOME을 app data root로 격리한다.
Cloud session을 포함한 그 밖의 부모 환경변수는 sidecar에 상속하지 않는 회귀 테스트를 유지한다.

### 남은 위험과 면접 질문

첫 isolated 실행은 dependency와 OCR model cache 상태에 따라 느릴 수 있다. 실제 Anthropic session,
서명된 설치본의 bundled sidecar/doc2md, 임의 사용자 corpus의 최초 대량 변환은 별도 설치본 E2E가
필요하다.

- 왜 단위 테스트가 통과했는데 실제 프로세스가 실패했나? spawn 인자만 검사했고 Backend의 import
  시점 설정 검증과 Python wheel ABI를 실행하지 않았기 때문이다.
- 왜 local venv를 커밋하지 않나? interpreter와 native wheel은 플랫폼별 산출물이며 소스·lock·재현
  명령만 버전 관리해야 하기 때문이다.
- 왜 health를 완화하지 않았나? 실행 가능하다는 신호가 실제 변환·검색 가능성을 보장해야 UI가
  거짓 `ready` 상태를 표시하지 않기 때문이다.

## 2026-07-22 — 터미널 종료 뒤 sidecar 로그가 Electron `write EIO` 예외를 발생시킴

### 맥락과 영향

Electron 앱은 sidecar의 stdout과 stderr를 메인 프로세스 console로 전달한다. 앱을 띄운 터미널이나
개발 서버의 출력 pipe가 앱보다 먼저 닫힌 뒤 sidecar가 로그를 남기면 다음 예외가 반복해서 표시됐다.

```text
Uncaught Exception: Error: write EIO
at console.warn
at Socket.<anonymous> (.../out/main/index.js)
```

기대 동작은 로그 출력 대상이 사라져도 앱과 sidecar 수명주기가 계속 동작하는 것이다. 실제로는 진단
로그의 전송 실패가 Electron 메인 프로세스의 미처리 예외가 되어 사용자에게 오류 창을 띄웠다.

### 증거와 원인

빌드 stack의 `Socket.<anonymous>`를 원본에 대응시키면 `SidecarSupervisor.spawnChild`의 child stderr
`data` listener가 실행한 `console.warn('[sidecar]', ...)` 경로다. sidecar process나 API 오류가
직접 원인이 아니라, 이미 닫힌 `process.stderr` socket에 뒤늦게 쓰면서 Node가 `EIO`를 emit한 것이
원인이다. 동일한 닫힌 pipe 상태는 플랫폼과 launcher에 따라 `EPIPE`로도 나타날 수 있다.

처음에는 메인 프로세스 시작 시 stdout/stderr의 `EIO`·`EPIPE` event를 중앙에서 처리했다. 하지만 새
빌드에서도 같은 stack이 반복돼, `console.warn` 쓰기 단계의 실패를 stream listener만으로 완전히
차단할 수 없다는 증거가 생겼다. 개별 console 호출의 try/catch도 비동기 stream 오류와 새 호출 지점
누락 위험이 있어 최종 해결책으로 삼지 않았다.

### 해결과 검증

장시간 실행되는 child output을 수명이 짧은 터미널 console로 다시 쓰지 않도록 경계를 바꿨다.
sidecar stdout은 `resume()`으로 계속 비워 child의 pipe backpressure 정체를 막고, stderr는 console로
보내지 않은 채 기존 8KB 진단 꼬리에만 저장한다. 따라서 기동 실패 판단 근거는 보존하면서 `EIO`를
발생시킨 write 자체가 사라진다. `installOutputStreamGuards`는 그 밖의 출력에 대한 보조 방어로 남긴다.

- sidecar stdout/stderr가 console을 호출하지 않고 stderr 진단 꼬리는 유지하는 회귀 테스트 통과
- sidecar 수명주기 집중 테스트 12개와 채팅 저장소 포함 집중 테스트 16개 통과
- 재빌드된 `out/main/index.js`에 `[sidecar]` console 전달 코드가 없음을 확인
- 전체 Vitest 137개, TypeScript typecheck, Electron production build 통과

남은 위험은 실제로 터미널 pipe를 끊은 설치본 수동 E2E를 자동화하지 않았다는 점이다. 다만 예외를
발생시킨 console write를 빌드 산출물에서 제거하고 sidecar pipe 배출·진단 보존·재시작 동작 테스트를
함께 통과시켜 회귀 범위를 고정했다.

- 왜 앱 오류가 아니라 로그 오류라고 판단했나? stack이 API나 child exit가 아니라 child stderr
  `data` listener의 `console.warn`과 Node socket write를 가리켰기 때문이다.
- 왜 stderr를 완전히 버리지 않았나? stale wiki와 기동 실패를 판별하는 근거이므로 메모리 진단 꼬리는
  유지하되, 사용자 터미널에 의존하는 재출력만 제거했다.
## 2026-07-23 — 채팅의 HWPX 생성 요청이 파일 쓰기까지 이어지지 않음

### 상황과 영향

사용자가 기존 주간 자료를 근거로 `주간업무보고서.hwpx` 생성을 요청해도 Backend가 unsupported를
반환했고 Electron에는 생성 action이 없었다. 별도의 “답변을 HWPX로 저장” IPC와 Kordoc 변환 코드는
존재했지만 sidecar chat result와 연결되지 않아 실제 채팅 workflow에서는 도달할 수 없었다.

### 원인과 대안

기존 change plan은 이미 존재하는 document ID, file version과 base hash를 전제로 해 새 파일을 표현할 수
없었다. 이 필드를 가짜 값으로 채우는 대안은 plan hash 의미를 훼손해 제외했다. Agent에 직접 write tool을
주는 대안도 등록 경로와 사용자 승인을 우회해 제외했다.

### 해결과 검증

Backend의 grounded creation preview를 Electron sidecar가 받아 등록 폴더 안의 실제 target을 정하고 전체
`/dev/null` diff로 승인받는다. 승인 후 npm에 설치된 실제 Kordoc으로 candidate를 생성·재파싱하고 같은
directory의 hard link로 no-overwrite 게시한다. 실 Kordoc round-trip, sidecar HTTP response부터 승인과
실제 HWPX 생성까지의 통합 테스트, 이름 충돌·잘못된 filename·재파싱 실패 회귀 테스트가 통과했다.

### 재발 방지와 남은 위험

생성 성공은 단순 파일 존재가 아니라 non-empty HWPX, Kordoc 재파싱과 원자 no-replace까지 확인한다.
Watcher가 감지한 뒤 새 위키 publish는 비동기이므로 생성 완료 문구가 publish 완료를 주장하지 않게 했다.
서명된 설치본에서 npm Kordoc asset이 ASAR/resource와 함께 로드되는지는 release smoke gate로 유지한다.
