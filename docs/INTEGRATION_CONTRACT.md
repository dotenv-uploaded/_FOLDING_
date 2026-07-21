# 팀 통합 계약 v0.1

이 문서는 각 담당자가 서로의 내부 구현을 추측하지 않고 병렬 개발하기 위한 최소 계약이다. 상세 설계보다 아래 schema와 상태를 우선한다.

## 담당 경계

| 담당 | 소유 | 백엔드에 전달하거나 받는 것 |
| --- | --- | --- |
| 우창 | Next.js UI | HTTP 요청, 위치·근거, diff, 승인·거절, 실행 상태, Undo |
| 성주 | FastAPI·Claude Agent SDK·실제 파일 쓰기 | 공개 API, 승인·버전·감사, 변환·graph update 조정 |
| 용휘 | `llm-wiki`·검색·지식 그래프 | versioned manifest/chunks/links와 증분 update 결과 |
| 민규 | 문서 변환 | source→Markdown/assets 결과와 증분 재변환 결과 |

## 공통 불변 조건

- `document_id`는 내용 변경에도 유지한다.
- `file_version_id`와 `graph_version`은 별도로 바뀐다.
- 파일 쓰기는 exact diff와 `plan_hash`를 사용자가 승인한 뒤에만 실행한다.
- 승인 뒤에도 현재 source hash가 계획의 base hash와 같은지 다시 검사한다.
- HWP/PDF는 검증된 round-trip writer가 생기기 전까지 원본 수정 대상이 아니다.
- 실제 key, 개인정보, 개인 absolute path는 저장소와 fixture에 넣지 않는다.
- `AGENT_GUIDE.md`는 `checksums.sha256`과 `VERSION`에 묶인 필수 계약이다. backend는 허용된 TOML frontmatter만 schema로 검증·정규화해 모든 Claude session에 주입하고 자유 형식 본문은 prompt에 넣지 않는다.
- ACL은 검색·relation 확장·본문 반환 전에 적용한다. 인증되지 않은 요청은 public 문서만 읽고 write는 모두 거부한다.
- 원본은 `llm-wiki`에 복사하거나 symlink로 넣지 않고 manifest의 `source://` URI와 SHA-256으로 참조한다.
- 파일 수정 뒤 converter가 먼저 새 canonical 문서를 만들고, 그 결과로 FTS·vector·graph를 병렬 갱신한다. 모든 검증이 끝나기 전에는 새 `VERSION`을 active로 공개하지 않는다.
- 같은 문서 변경은 base hash와 문서별 lock으로 직렬화하고 event handler는 event ID 기준으로 멱등해야 한다.
- 서로 다른 문서 update가 같은 active version에서 출발해 publish CAS에 지면, stale package를 재시도하지 않고 승자 version 위로 미반영 event를 rebase하거나 대기 event와 coalesce한다.

## API 기준

Base path는 `/api/v1`이다.

현재 구현:

- `GET /health`
- `POST /chat/messages`
- `GET /documents/{document_id}`

다음 구현:

- `POST /change-plans/{change_plan_id}/approve`
- `POST /change-plans/{change_plan_id}/reject`
- `GET /executions/{execution_id}`
- `POST /executions/{execution_id}/undo`

Chat 응답의 `response_type`은 `answer`, `location_result`, `target_selection`, `change_preview`, `execution_result`, `error` 중 하나다. 실제 request/response schema는 실행 중인 FastAPI의 `/openapi.json`을 source of truth로 삼는다.

## 용휘가 먼저 제공할 것

- `manifest.jsonl` 1줄, `chunks.jsonl` 2줄, `links.jsonl` 1줄
- 세 JSON schema와 ID·relation enum
- `source://` root mapping
- 검색·인용·ACL 규칙이 담긴 `AGENT_GUIDE.md`, `agent-guide.schema.json`과 변경 시 새 `VERSION`
- FTS/vector load 방법 또는 search API
- 문서 1개 증분 update 진입점과 새 `VERSION`
- FTS·vector·graph 병렬 update 결과를 모아 새 version을 원자적으로 publish하는 방식

## 민규가 먼저 제공할 것

- sample source와 canonical Markdown
- `ConversionResult`와 실패 error 예시
- stable section 또는 source page/span mapping
- 형식별 parse/write-back capability
- 문서 1개 증분 변환 진입점

## 우창과 먼저 맞출 것

- `NEXT_PUBLIC_API_BASE_URL`
- 화면이 처리할 여섯 가지 `response_type`
- diff 승인 시 화면에서 본 exact `plan_hash` 전달
- polling terminal status와 간격
- CORS origin
