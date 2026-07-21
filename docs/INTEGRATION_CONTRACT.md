# 팀 통합 계약 v0.2

이 문서는 각 담당자가 내부 구현을 추측하지 않고 병렬 개발하기 위한 최소 wire·artifact 계약이다. 실행 중인 Backend의 `/openapi.json`과 이 문서가 다르면 OpenAPI를 우선하고 계약 version을 함께 올린다.

## 담당 경계

| 담당 | 소유 | Backend 경계 |
| --- | --- | --- |
| 우창 | Next.js UI | chat, 근거, diff, approve/reject, execution polling, retry, Undo |
| 성주 | FastAPI·Claude Agent SDK·side effect | 인증·ACL, agent, 승인, 실제 file write, 상태·outbox·version publish |
| 용휘 | `llm-wiki`·검색·지식 그래프 | immutable manifest/chunks/links/enrichment와 index build 결과 |
| 민규 | 문서 변환 | source→canonical Markdown/assets/section mapping과 구조화 오류 |

다른 담당자의 저장소는 직접 수정하지 않는다. Backend는 adapter와 계약 테스트로만 연결한다.

## 공통 ID와 불변 조건

- `document_id`: 논리 문서의 stable 6자리 ID. 내용·경로·revision이 바뀌어도 유지한다.
- `file_version_id`: 원본 bytes가 바뀔 때마다 새 값이다.
- `graph_version`: 검증된 knowledge snapshot이 공개될 때마다 새 값이다.
- `event_id`: outbox와 모든 downstream consumer의 idempotency key다.
- 원본은 package에 복사·symlink하지 않고 `source://` URI, SHA-256, checksummed source reference로 연결한다.
- ACL은 query와 relation 확장 전에 적용하고 권한 없는 문서 ID도 model context에 넣지 않는다.
- 본문 metadata나 prompt는 access를 올릴 수 없다.
- enrichment는 후보 확장용이다. canonical section에 연결된 exact quote가 아니면 사실 근거가 아니다.
- 승인 전 source write는 0건이다. approve는 화면에 보인 exact `plan_hash`만 받는다.
- 승인 직전 ACL과 source base SHA-256을 다시 확인한다.
- 실제 write는 UTF-8 Markdown/TXT만 지원한다. PDF, DOCX, HWP는 verified round-trip writer 전까지 read-only다.
- 변환 뒤 FTS, vector, graph를 병렬 갱신하고 모두 검증된 immutable VERSION만 공개한다.
- request는 시작 시 하나의 snapshot을 pin한다. 한 응답에서 version을 섞지 않는다.

## `llm-wiki` acceptance 계약

필수 package 파일:

```text
AGENT_GUIDE.md
VERSION
checksums.sha256
manifest.jsonl
docs/**/*.md
references/<document_id>.source.json
retrieval/aliases.json
retrieval/chunks.jsonl
retrieval/links.jsonl
schemas/*.schema.json
```

`enrichments.jsonl`은 현재 MVP acceptance의 선택 산출물이며 Backend 검색 adapter는 아직 로드하지 않는다. 용휘가 schema와 실제 후보 확장 adapter를 제공하면 `section_id`와 canonical exact quote를 검증한 항목만 검색 후보 확장에 사용한다. 그 전에는 enrichment를 답변 근거나 production graph readiness로 주장하지 않는다.

`AGENT_GUIDE.md`는 checksum에 포함하며 다음 citation을 모두 요구한다.

```toml
required_citations = ["document_id", "revision", "graph_version", "chunk_id", "section_id"]
```

Backend는 허용된 TOML frontmatter만 schema로 검증해 모든 Claude session의 고정 지침으로 바꾼다. 자유 형식 body는 model prompt에 넣지 않는다.

Manifest 최소 필드:

```json
{
  "schema_version": "1.0.0",
  "id": "REG-000001",
  "file_version_id": "fv_...",
  "title": "개인정보 처리 규정",
  "doc_type": "regulation",
  "revision": "3",
  "status": "active",
  "authority_level": "regulation",
  "effective_from": "2026-07-01",
  "effective_to": null,
  "source": {
    "filename": "regulations/REG-000001.md",
    "uri": "source://regulations/REG-000001.md",
    "media_type": "text/markdown",
    "sha256": "..."
  },
  "canonical_path": "docs/regulations/REG-000001.md",
  "access": "internal",
  "write_access": "restricted",
  "editability": "editable",
  "tags": [],
  "aliases": [],
  "conversion": {}
}
```

Chunk 최소 필드:

```json
{
  "schema_version": "1.0.0",
  "chunk_id": "REG-000001@3#sec-004",
  "document_id": "REG-000001",
  "file_version_id": "fv_...",
  "section_id": "sec-004",
  "section": "제4조 보관 기간",
  "heading_path": ["개인정보 처리 규정", "제4조 보관 기간"],
  "text": "인용 가능한 원문",
  "embedding_text": "검색 전용 보강 텍스트와 인용 가능한 원문",
  "text_sha256": "...",
  "ordinal": 0
}
```

`chunk_id`는 revision-bound다. section의 첫 chunk(`ordinal=0`)는
`<document_id>@<revision>#<section_id>`, 추가 chunk는 뒤에 `:<ordinal>`을 붙인다. revision이
바뀌면 해당 문서의 모든 chunk ID와 `links.evidence_chunk_ids`도 같은 candidate 안에서 함께
갱신한다.

Canonical Markdown은 stable anchor를 정확히 한 번 포함한다.

```markdown
<a id="sec-004"></a>
## 제4조 보관 기간
```

Backend load barrier는 anchor, 전체 heading path, file version, text hash를 확인하고, `text`가 선언한 section body에 정확히 한 번 있을 때만 evidence로 노출한다. `embedding_text`는 검색에만 사용하고 quote로 반환하지 않는다.

Link endpoint와 evidence chunk는 같은 package에 존재해야 한다. `VERIFIED` relation만 사용자 응답과 agent context에 사용한다.

## API 계약

Base path는 `/api/v1`이다.

- `GET /health`
- `POST /chat/messages`
- `GET /documents/{document_id}`
- `POST /documents/{document_id}/source-sync-plans`
- `POST /change-plans/{change_plan_id}/approve`
- `POST /change-plans/{change_plan_id}/reject`
- `GET /executions/{execution_id}`
- `POST /executions/{execution_id}/retry-sync`
- `POST /executions/{execution_id}/undo`
- `POST /demo/reset`, non-production only

현재 Chat `response_type`은 `location_result`, `target_selection`, `change_preview`, `error` 중 하나다. 실행 상태는 chat 응답이 아니라 execution API로 조회한다. 위치 응답의 사실 문장은 canonical quote 그대로이며 각 quote와 구조화 evidence에 `[document_id rev.N §section_id]` citation을 붙인다.

Approve와 Undo는 `202 Accepted`, `Location: /api/v1/executions/{id}`를 반환한다. Frontend는 `recommended_poll_after_ms`를 사용해 `terminal`까지 polling한다.

Execution의 핵심 필드:

```json
{
  "status": "file_applied",
  "file_status": "applied",
  "sync_status": "pending",
  "stage": "sync_queued",
  "terminal": false,
  "recommended_poll_after_ms": 500,
  "graph_version_before": "...",
  "graph_version_after": null,
  "error": null
}
```

동기화 실패는 `stage=sync_retryable`, `terminal=true`, `recommended_poll_after_ms=null`, `error.retryable=true`인 action-required 상태다. 이전 knowledge version은 계속 active다. 같은 candidate batch에서 실패한 event들은 함께 retry하며, retry 또는 Undo로 해소하기 전에는 새 source 승인을 `KNOWLEDGE_SYNC_BLOCKED`로 막는다.

원본 교체 전에 storage 오류가 나고 source가 정확히 before hash로 남으면 execution은 `stage=file_failed`가 된다. 이때 `retry-sync`가 아니라 원래 approve 또는 Undo endpoint를 다시 호출한다. 같은 key와 새 key 모두 기존 execution·journal에 결박되며 새 승인·새 Undo row를 만들지 않는다. source가 before/after 어느 쪽도 아니면 conflict로 닫는다.

`GET /health`는 `pending_sync_events`, `failed_sync_events`, `stale_sync_events`, `worker_available`, `index_artifacts_available`을 반환한다. 짧은 정상 pending은 readiness를 낮추지 않지만 설정된 시간보다 오래된 pending/processing은 degraded다. immutable release의 index 검증 결과는 load 시 한 번 계산하고 probe에서는 재사용한다.

### 외부 파일 watcher

watchdog/File System Access client는 변경된 전체 UTF-8 본문, active source의 `base_sha256`, 그 둘을 정확히 연결하는 단일 `replace_exact` operation을 `source-sync-plans`에 보낸다. 응답은 파일 적용 결과가 아니라 `ChangePlanView`이며 source write는 0건이다. client는 diff를 확인하고 같은 `plan_hash`를 표준 approve API에 제출해야 한다. 같은 `Idempotency-Key`는 같은 plan으로 replay되고 다른 본문에는 409를 반환한다. 현재 adapter가 canonical evidence에 안전하게 표현할 수 없는 변경과 PDF/DOCX/HWP upload는 실패 폐쇄한다.

모든 원본 writer는 이 API를 사용해야 한다. Backend는 rename 직전 source hash를 다시 확인해 비협조 외부 edit의 대표 race를 막지만, POSIX에는 임의 외부 writer와의 원자 compare-and-swap이 없으므로 API 밖 직접 덮어쓰기는 지원 계약이 아니다.

### 인증 경계

Supabase JWT는 허용된 asymmetric algorithm과 bounded `kid`를 먼저 확인한 뒤 signature, issuer, audience, expiry와 필수 claim을 검증한다. known key는 제한 시간 cache하고 unknown `kid`는 negative cache하며 JWKS refresh에는 process-wide 최소 간격과 fetch timeout을 둔다. 모든 Authorization 요청에는 header 크기 제한과 pre-auth IP rate limit이 적용된다. Railway 앞단에서도 플랫폼 gateway/WAF rate limit을 유지해야 한다.

## 문서 변환 계약

현재 연동 대상은 `codegate-2026-api/services/doc2md` v0.1.0의 내부 `POST /convert`다. Backend가 allowlisted absolute path를 서비스 내부 요청에만 전달하고 metadata로 stable ID, source URI, doc type, access를 강제한다. 응답 source SHA가 요청한 현재 SHA와 다르면 cache 결과를 거부한다.

`doc2md`가 추가로 보장해야 하는 항목:

- 변경 뒤에도 stable section anchor와 heading hierarchy 보존
- canonical Markdown, source/canonical SHA, converter/version
- section 또는 source page/span mapping
- warning과 retryable 여부가 있는 구조화 오류
- 형식별 parse와 original write-back capability 분리

원격 doc2md의 무인증 absolute path API를 public network에 노출하지 않는다. 현재 v0.1.0은 Backend와 같은 trusted filesystem boundary에서만 사용한다.

v0.1.0의 path 입력은 단순 private network만으로 충분하지 않으며 같은 filesystem namespace가 필수다. 별도 Railway service를 쓰려면 authenticated bytes/object-storage URI 기반 v0.2가 먼저 필요하다.

## 지식 그래프 update 계약

Backend outbox payload:

```json
{
  "schema_version": "1.0.0",
  "event_id": "evt_...",
  "execution_id": "exec_...",
  "document_id": "REG-000001",
  "source_uri": "source://regulations/REG-000001.md",
  "before_sha256": "...",
  "after_sha256": "...",
  "file_version_id": "fv_...",
  "operation": {
    "type": "replace_exact",
    "expected_text": "1년",
    "replacement_text": "3년",
    "expected_occurrences": 1
  }
}
```

저장 envelope은 `{id, event_type, aggregate_id, payload, status, attempts}`이고
`id == payload.event_id`, `event_type == DocumentContentChanged`,
`aggregate_id == payload.execution_id`여야 한다. adapter entry point는 이 envelope을 받아
`event_id`를 consumer 멱등 key로 사용한다. 불일치한 ID는 build 전에 거부한다.

Consumer 규칙:

1. `event_id` 기준으로 중복 처리한다.
2. converter 결과 뒤 FTS, vector, graph를 병렬 build한다.
3. candidate에 parent VERSION과 포함 event IDs를 기록한다.
4. schema, source reference, canonical evidence, link, checksum을 모두 검증한다.
5. expected parent가 현재 active일 때만 publish한다.
6. CAS loser는 최신 active 위로 미반영 event를 rebase/coalesce한다.
7. 일부 stage 실패 시 active pointer를 바꾸지 않는다.

## 팀이 제공할 최소 fixture

- 용휘: 실제 manifest 1줄, chunk 2줄, link 1줄, aliases와 schema, update entry point, expected query 2개
- 민규: source 1개, canonical 1개, section mapping 1개, 성공/실패 응답, format capability 표
- 우창: API base URL, CORS origin, diff viewer, polling UI, retry·Undo UX

팀 fixture가 준비되기 전에는 이 저장소의 합성 문서와 deterministic adapter로 전체 상태 머신을 검증한다.
