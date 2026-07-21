# 팀에 지금 보낼 내용

상세 내부 설계 대신 아래 담당자별 문장과 OpenAPI만 공유한다.

## 전원

> Backend는 `https://github.com/dotenv-uploaded/Backend`에서만 작업합니다. 검색 결과는 `document_id + revision + graph_version + chunk_id + section_id` 근거를 반환하고, 파일 변경은 exact diff와 `plan_hash` 승인 뒤에만 실행합니다. 원본은 symlink가 아니라 `source://` URI와 SHA-256으로 참조합니다. 승인 뒤 파일 적용과 지식 동기화는 분리되며, 변환·FTS·vector·graph가 모두 검증된 새 VERSION만 공개합니다.

## 우창

> 로그인은 Supabase SDK에서 직접 처리하고 password·refresh token을 Backend로 보내지 마세요. cloud API에는 access token을 Bearer로 붙인 뒤 `GET /api/v1/auth/me`의 `provisioned`, `write_scope`, `writable_document_ids`를 화면 권한의 source of truth로 사용해 주세요. Supabase session client와 local sidecar client를 분리하고 sidecar에는 Bearer를 붙이지 않습니다. `POST /api/v1/chat/messages`에서 `location_result`, `target_selection`, `change_preview`, `error`를 처리해 주세요. `change_preview`의 diff를 보여주고 화면에서 받은 `plan_hash` 그대로 approve 또는 reject에 보내야 합니다. 로컬 watcher 업로드도 `POST /documents/{id}/source-sync-plans`에서 먼저 plan을 받고 같은 승인 흐름을 거칩니다. approve·reject·Undo에는 요청마다 8자 이상의 `Idempotency-Key`가 필수입니다. approve와 Undo는 `202 + Location`이므로 `GET /api/v1/executions/{id}`를 `recommended_poll_after_ms` 간격으로 polling해 주세요. `sync_retryable`은 polling 종료 후 retry 또는 Undo를 선택하는 action-required 상태입니다. 원본이 바뀌지 않은 일시적 `file_failed` 오류는 같은 approve/Undo endpoint를 새 key로 다시 호출하면 같은 execution으로 재개합니다. 브라우저에는 Anthropic key, source 절대경로, Claude session state를 두지 않습니다.

## 용휘

> `LLMWIKI@fb0f8c7`의 `WikiBuildService`, native `current.json`, manifest/chunks/links/aliases schema를 Backend에 연결했습니다. stable ID는 LLMWIKI regex와 최대 96자를 그대로 받습니다. Backend compatibility cache는 native build ID에만 결박하고 별도 current를 만들지 않습니다. 변경 event는 normalized Markdown의 source hash와 revision을 갱신한 뒤 expected current build ID CAS로 새 native build를 공개합니다. schema나 update entry point를 바꿀 때 build format/version과 migration contract를 같이 알려주세요.

## 민규

> `codegate-2026-api@360ff41`의 `services/doc2md` v0.1.0 adapter를 연결했습니다. stable ID·source URI metadata override와 현재 source SHA를 검증하고 결과를 LLMWIKI normalized input으로 사용합니다. LLMWIKI가 H1/H2에서 stable `sec-*` anchor를 생성하므로 변환 결과는 frontmatter, 정확히 하나의 H1, 하나 이상의 비어 있지 않은 H2와 heading hierarchy를 보존해야 합니다. source SHA, canonical SHA, converter version, source page/span, warning/error schema를 추가해 주세요. HWP/PDF/DOCX는 parse와 원본 round-trip write를 구분해 capability 표로 알려주세요. 검증된 writer가 없으면 Backend는 read-only로 유지합니다.

## 보내지 않을 것

- 개인 로컬 경로와 `.private` 문서
- SQLite table과 atomic write 내부 구현
- 실제 key, token, Supabase service-role key
- 검증되지 않은 HWP/PDF write 지원 주장

실제 request/response schema는 실행 중인 `/openapi.json`을 source of truth로 사용한다.
