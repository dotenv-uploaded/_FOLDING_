# ADR 0010: 승인 기반 복구 가능한 원본 파일 삭제

- 상태: 채택
- 날짜: 2026-07-22

## 배경

ChatService는 원본 파일 삭제 요청을 선제 차단했다. 이 경계는 Claude가 파일 삭제를 빈
`replace_exact`로 오해하는 위험은 막았지만, 사용자가 정확한 파일명을 지정해도 승인 가능한 작업으로
이어지지 않았다. 원본 삭제는 본문 수정과 달리 active manifest가 사라지는 상태, 위키 candidate의 문서
집합 변화, 재시작 복구와 Undo 복원이 모두 필요하다.

## 결정

명시적 파일명 삭제와 `계약서 전부` 삭제를 ChatService가 Claude 호출 전에 결정론적으로 해석한다.
단일 파일은 Unicode-normalized basename으로 정확히 찾고, 일괄 요청은 `doc_type=contract`인 ACL-visible
문서를 최대 20개까지 찾는다. 일괄 요청도 파일별 독립 `DeleteFileOperation`, diff와 `plan_hash`를 만들고
Electron은 각 파일마다 별도 승인을 받는다. 승인 전 원본 write는 0건이다.

승인 시 ACL과 active source SHA를 다시 확인하고 immutable backup과 durable journal을 만든 뒤 같은
filesystem 경계에서 원본을 임의 이름으로 rename-quarantine하고 hash를 다시 검증한 뒤 제거한다. 이
사이에 외부 edit가 끼면 새 내용을 원래 경로로 복원하고 conflict로 닫는다. outbox event는 LLMWIKI candidate에서 manifest, canonical,
reference, chunk와 관련 link를 제거하고 검증 뒤 새 버전을 공개한다. 삭제 상태는 고정 sentinel SHA로
표현해 재시작 복구가 파일 부재를 명시적으로 판별한다.

Undo는 삭제 execution의 backup, 원래 mode와 삭제 당시 graph version에 결박된
`RestoreFileOperation`을 만든다. 대상 경로가 비어 있고 현재 principal이 같은 document ID를 복원할
권한이 있을 때만 원본을 원자 복원하고, retained knowledge/input snapshot에서 문서를 새 candidate에
되살린다.

Execution ID는 plan ID의 SHA-256에서 결정론적으로 예약하고 approve idempotency key도 plan별로
고정한다. Electron은 승인 HTTP 전에 provisional execution을 SQLite에 기록한다. 응답 유실 또는 사용자
중단에는 같은 key로 결과를 복구하고, 재시작 뒤에도 예약 ID로 상태를 다시 조회할 수 있다. 일괄 삭제의
모든 execution을 배열로 보존해 파일별 Undo 진입점을 잃지 않는다.

## 검토한 대안

- Claude에 filesystem delete tool 제공: app-owned ACL, exact hash 승인, journal과 Undo를 우회하므로 제외했다.
- 한 번의 일괄 승인으로 여러 파일 삭제: 사용자가 개별 대상을 확인할 수 없고 부분 실패 복구 경계가
  커지므로 제외했다.
- 휴지통 이동만 수행: 위키와 source lifecycle 상태가 분리되고 운영 환경별 휴지통 계약이 달라 제외했다.
- LangChain/LangGraph 도입: 현재 Claude SDK structured output, app-owned state/outbox와 승인 journal이
  이미 필요한 상태 전이를 소유한다. 별도 graph checkpoint는 중복 상태와 승인 재개 경로를 만들어
  보장을 늘리지 않으므로 도입하지 않는다.

## 결과

파일 삭제는 일반 본문 수정과 동일한 exact `plan_hash` 승인 API를 사용하지만 별도 typed operation과
복구 규칙을 갖는다. UI는 삭제임을 명시하고 복원 가능한 backup을 안내한다. 동일 파일명 복수 대상은
선택을 요구하며, 20개를 넘는 일괄 요청은 범위를 좁히게 한다.
