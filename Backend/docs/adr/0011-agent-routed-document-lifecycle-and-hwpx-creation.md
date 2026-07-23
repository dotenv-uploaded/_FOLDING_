# ADR 0011: Agent-routed 문서 lifecycle과 검증된 HWPX 생성

- 상태: 채택
- 날짜: 2026-07-23

## 배경

ChatService가 확장자를 포함한 삭제 문장만 정규식으로 가로채면서 `일일업무 보고서 파일 삭제해줘` 같은
자연어 후속 요청은 Claude가 보기도 전에 일반 수정 실패로 끝났다. 반대로 `이번주 보고서를 보고
주간업무보고서.hwpx를 만들어줘`는 typed output에 새 문서 생성 상태가 없어 `unsupported` 이외의 결과를
표현할 수 없었다.

## 결정

Claude structured output에 `ready_delete_file`과 `ready_create_file`을 추가한다. 삭제는 현재 turn의
검색과 document 확인만 허용하고 ChatService가 ACL, active source hash, diff와 `plan_hash`를 다시 만든다.
생성은 현재 turn에서 source document를 검색·확인한 뒤 canonical 문서를 읽고, 경로가 없는 `.hwpx`
basename과 근거 기반 Markdown만 제안한다. Claude에는 filesystem write, shell, 승인 권한을 주지 않는다.

새 파일에는 base document와 source hash가 없으므로 기존 change plan schema에 억지로 넣지 않는다.
Electron이 등록 폴더 안의 충돌 없는 실제 경로와 `/dev/null`에서 시작하는 전체 diff를 보여주고 별도
사용자 승인을 받는다. 승인 뒤 설치된 실제 Kordoc으로 같은 디렉터리의 임시 HWPX를 생성하고 재파싱한
다음 hard-link no-replace로 게시한다. 기존 파일이 생겼거나 생성 결과가 비었거나 다시 읽히지 않으면
대상 파일을 남기지 않는다. 성공한 새 파일은 기존 watcher가 감지해 지식 빌드에 포함한다.

## 검토한 대안

- 채팅 입구 정규식 확대: 표현을 계속 누락하고 대화 문맥·현재 근거를 사용할 수 없어 제외했다.
- Claude에 create/delete filesystem tool 제공: app-owned 승인과 경로·hash 검증을 우회해 제외했다.
- 새 파일을 기존 change plan에 저장: `document_id`, `file_version_id`, `base_sha256`의 의미를 거짓으로
  채워야 하므로 제외했다.
- 기존 이름 덮어쓰기: 새 파일 생성에는 복원할 원본 backup이 없으므로 제외했다.

## 결과

문서 조회, 본문 수정, 원본 삭제와 근거 기반 HWPX 생성은 하나의 typed agent routing 경계에서 구분된다.
삭제는 기존 plan-hash·Undo 경계를 유지하고, 생성은 실제 경로 승인·무덮어쓰기·Kordoc 재파싱 검증을
거친다. 모델의 proposal과 애플리케이션의 write authority는 계속 분리된다.
