# 팀에 지금 보낼 내용

상세 내부 설계 대신 아래 담당자별 문장과 OpenAPI만 공유한다.

## 전원

> Backend는 `https://github.com/dotenv-uploaded/Backend`에서만 작업합니다. 검색 결과는 `document_id + revision + graph_version + chunk_id + section_id` 근거를 반환하고, 파일 변경은 exact diff와 `plan_hash` 승인 뒤에만 실행합니다. 원본은 symlink가 아니라 `source://` URI와 SHA-256으로 참조합니다. 승인 뒤 파일 적용과 지식 동기화는 분리되며, 변환·FTS·vector·graph가 모두 검증된 새 VERSION만 공개합니다.

## 우창

> `POST /api/v1/chat/messages`에서 `location_result`, `target_selection`, `change_preview`, `error`를 처리해 주세요. `change_preview`의 diff를 보여주고 화면에서 받은 `plan_hash` 그대로 approve 또는 reject에 보내야 합니다. 로컬 watcher 업로드도 `POST /documents/{id}/source-sync-plans`에서 먼저 plan을 받고 같은 승인 흐름을 거칩니다. approve·reject·Undo에는 요청마다 8자 이상의 `Idempotency-Key`가 필수입니다. approve와 Undo는 `202 + Location`이므로 `GET /api/v1/executions/{id}`를 `recommended_poll_after_ms` 간격으로 polling해 주세요. `sync_retryable`은 polling 종료 후 retry 또는 Undo를 선택하는 action-required 상태입니다. 원본이 바뀌지 않은 일시적 `file_failed` 오류는 같은 approve/Undo endpoint를 새 key로 다시 호출하면 같은 execution으로 재개합니다. 브라우저에는 Anthropic key, source 절대경로, Claude session state를 두지 않습니다.

## 용휘

> manifest에는 stable 6자리 `id`, `file_version_id`, `revision`, `status`, 효력 기간, `authority_level`, `access`, `source.uri`, `source.sha256`, `canonical_path`, `write_access`, `editability`가 필요합니다. chunk에는 `chunk_id`, `document_id`, `file_version_id`, stable `section_id`, 전체 `heading_path`, 원문 `text`, 검색 전용 `embedding_text`, `text_sha256`를 주세요. enrichment는 현재 optional·미연동이며, 추가하려면 schema와 원문 `section_id`·exact quote 연결을 함께 주세요. 변경 event 뒤 FTS·vector·graph를 병렬 갱신하고 expected parent VERSION CAS와 checksum barrier를 통과한 immutable VERSION만 반환해 주세요. sample manifest/chunk/link/schema와 실제 update entry point를 부탁드립니다.

## 민규

> 현재 `services/doc2md` `/convert` adapter는 stable ID·source URI metadata override와 현재 source SHA를 검증합니다. 변환 Markdown에는 각 인용 section의 stable anchor(`<a id="..."></a>` 또는 `{#...}`)와 정확한 heading hierarchy가 반드시 남아야 합니다. source SHA, canonical SHA, converter version, `section_id`, source page/span, warning/error schema를 반환해 주세요. HWP/PDF/DOCX는 parse와 원본 round-trip write를 구분해 capability 표로 알려주세요. 검증된 writer가 없으면 Backend는 read-only로 유지합니다.

## 보내지 않을 것

- 개인 로컬 경로와 `.private` 문서
- SQLite table과 atomic write 내부 구현
- 실제 key, token, Supabase service-role key
- 검증되지 않은 HWP/PDF write 지원 주장

실제 request/response schema는 실행 중인 `/openapi.json`을 source of truth로 사용한다.
