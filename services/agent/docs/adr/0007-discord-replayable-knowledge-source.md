# ADR 0007: Discord를 재생 가능한 LLMWiki 소스로 수집한다

- 상태: Accepted
- 날짜: 2026-07-29

## Context

Discord 대화를 모델 context에 반복해서 붙이면 채널이 길어질수록 prompt token과 비용이
선형 증가한다. 기존 Folding은 이미 immutable LLMWiki build, source hash 검증, ACL
filtering, evidence citation, CAS publish를 제공한다. Discord 전용 벡터 저장소를 추가하면
동일한 보안·검증 규칙이 두 벌이 되고 source of truth가 갈라진다.

Discord message는 수정·삭제될 수 있고 REST backfill과 Gateway가 같은 message를 중복
전달할 수 있다. 또한 사용자 입력은 신뢰할 수 없으며 Markdown link나 instruction을
지식 관계 또는 agent 명령으로 해석하면 안 된다.

## Decision

1. Discord event를 append-only SQLite journal에 멱등 저장한다.
2. 허용된 guild와 channel만 수집한다. thread는 허용 parent channel을 상속한다.
3. journal을 결정적으로 재생해 raw JSONL과 LLMWiki source-fragment Markdown을 만든다.
4. 기존 `NativeLLMWikiPipeline.rebuild()`를 호출하고 별도 검색 엔진을 만들지 않는다.
5. Discord 문서는 source-fragment semantics로 read-only 처리한다.
6. API 조회는 요청자의 기존 `AccessContext`를 사용한다.
7. Discord slash command는 guild administrator에게만 ephemeral 응답을 제공하고,
   Discord projection 문서만 검색한다.
8. cloud production은 guild-to-tenant ACL 모델이 정의될 때까지 금지한다.

## Consequences

### Positive

- 전체 history 대신 top-k 근거만 모델 context에 포함할 수 있다.
- 기존 checksum, citation, ACL, active-build rollback 규칙을 재사용한다.
- Gateway 장애 후 REST와 journal replay로 복구할 수 있다.
- projection이 파생물이므로 schema 변경 시 원문 event에서 다시 만들 수 있다.
- update/delete와 중복 전달을 재현 가능하게 처리한다.

### Negative

- append-only journal에는 삭제 전 본문이 남아 별도 retention 정책이 필요하다.
- Message Content intent와 bot read-history 권한이 필요하다.
- 한 guild를 한 local workspace에 연결하는 모델이며 cloud multi-tenant를 지원하지 않는다.
- Discord API backfill은 rate limit과 bot이 접근 가능한 history 범위에 종속된다.

## Rejected alternatives

- **전체 Discord history를 매 prompt에 첨부**: 비용과 context가 선형 증가하고 ACL과
  근거 경계가 약하다.
- **Discord 전용 vector database**: LLMWiki와 검증·권한·버전 체계가 분기된다.
- **현재 상태만 덮어쓰기**: update/delete 감사와 결정적 복구가 불가능하다.
- **모든 채널 자동 수집**: 최소 권한 원칙을 위반한다.
- **Discord 메시지를 editable 문서로 취급**: 원천 authority와 Folding write-back
  경계를 혼동한다.
