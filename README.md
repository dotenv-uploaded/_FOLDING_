# CODEGATE 2026 Backend

성주가 담당하는 지식 그래프 기반 문서 검색·수정 에이전트의 FastAPI 백엔드다. Claude Agent SDK가 질문과 변경 의도를 구조화하고, 애플리케이션이 ACL·원문 근거·승인·파일 쓰기·Undo·지식 버전 공개를 결정적으로 통제한다.

현재 합성 fixture 기준으로 다음 수직 흐름이 동작한다.

```text
질문 또는 변경 요청
→ Claude Agent SDK 또는 deterministic local gateway
→ status·효력 기간·ACL 필터
→ alias·chunk·verified relation 검색
→ canonical section/quote 근거 검증
→ exact diff와 immutable plan_hash
→ 사용자 승인
→ backup·journal·symlink-safe atomic replace
→ outbox worker
→ 문서 변환
→ FTS / vector / graph 병렬 빌드
→ schema·reference·checksum barrier
→ immutable knowledge VERSION 원자 공개
```

## 빠른 시작

Python 3.12와 [uv](https://docs.astral.sh/uv/)가 필요하다.

```bash
uv sync --all-groups
cp .env.example .env
uv run uvicorn codegate_api.main:app --reload
```

다른 터미널에서 anonymous public 검색을 확인한다.

```bash
curl http://127.0.0.1:8000/api/v1/health

curl -X POST http://127.0.0.1:8000/api/v1/chat/messages \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 00000000-0000-0000-0000-000000000001' \
  -d '{"conversation_id":"demo","message":"개인정보 보관 기간 문서 어디 있어?"}'
```

실제 변경 demo는 `.env.example`의 개발용 bearer token으로 `http://127.0.0.1:8000/docs`에서 실행한다. 변경 요청은 preview만 만들며, `plan_hash`를 approve API에 다시 보내야 파일이 바뀐다. approve와 Undo는 `202 Accepted`와 `Location`을 반환하므로 execution URL을 polling한다.

## 구현된 API

- `GET /api/v1/health`
- `POST /api/v1/chat/messages`
- `GET /api/v1/documents/{document_id}`
- `POST /api/v1/documents/{document_id}/source-sync-plans`
- `POST /api/v1/change-plans/{change_plan_id}/approve`
- `POST /api/v1/change-plans/{change_plan_id}/reject`
- `GET /api/v1/executions/{execution_id}`
- `POST /api/v1/executions/{execution_id}/retry-sync`
- `POST /api/v1/executions/{execution_id}/undo`
- `POST /api/v1/demo/reset`, production 비활성

실행 응답은 `file_status`, `sync_status`, `stage`, `terminal`, `recommended_poll_after_ms`를 분리한다. `sync_retryable`은 자동 재시도가 없는 action-required terminal 상태다. 이전 knowledge version을 계속 제공하되 실패 batch를 retry 또는 Undo로 해소하기 전에는 새 source 승인을 막아 stale event가 뒤 요청을 오염시키지 않는다. 원본에 아무 효과도 남기지 않은 일시적 `file_failed`는 같은 approve 또는 Undo 요청을 다시 보내면 기존 execution·journal을 재사용해 안전하게 재개한다.

## 보안·일관성 경계

- invalid 또는 expired bearer token을 anonymous로 강등하지 않는다.
- Supabase JWT는 JWKS signature, issuer, audience, expiry와 hook-owned tenant claim을 검증한다. `kid`별 key cache, unknown-`kid` negative cache, 최소 refresh 간격, 짧은 fetch timeout과 인증 IP rate limit으로 JWKS refresh 폭주를 제한한다.
- ACL을 검색, direct get, relation 확장, preview, approve, Undo마다 적용한다.
- 모델에는 built-in `Edit`, `Write`, `Bash`, web tool을 주지 않는다.
- 모든 Claude session은 checksum과 schema를 통과한 `AGENT_GUIDE.md` frontmatter로 시작한다.
- `llm-wiki`에는 원본 symlink 대신 checksummed `references/*.source.json`을 둔다.
- 근거 quote는 선언된 `section_id`의 canonical section 안에 정확히 한 번 있어야 한다.
- 계획의 exact operation·diff·base/result hash·expiry를 canonical hash로 고정하고 owner는 tenant·subject scoped persistence로 별도 결박한다.
- 승인 뒤에도 ACL과 현재 source hash를 다시 검사한다.
- 파일은 dirfd와 `O_NOFOLLOW`, immutable backup, journal, fsync, same-directory `os.replace`로 교체한다. 원본 무변경 상태에서 쓰기가 실패하면 같은 감사 execution을 다시 준비해 재시도한다.
- 실제 쓰기는 UTF-8 Markdown/TXT만 지원한다. PDF, DOCX, HWP는 검증된 round-trip writer 전까지 read-only다.

## 팀 통합

`codegate-2026-api`의 `services/doc2md` v0.1.0은 내부 adapter로만 호출한다. stable document ID와 `source://` URI override를 강제하고 응답 source SHA가 현재 원본과 다르면 stale cache로 거부한다. 실제 graph/embedding 구현은 용휘 담당이며, 이 저장소의 deterministic FTS/hash-vector/link adapter는 Backend E2E와 실패 복구를 독립 검증하기 위한 local 구현이다.

로컬 watcher가 외부 편집을 감지하면 현재 파일 본문, 활성 source hash, 단일 exact operation을 `source-sync-plans`에 보낸다. Backend는 파일을 바로 덮어쓰지 않고 idempotent diff 계획을 반환한다. 클라이언트가 그 `plan_hash`를 표준 approve API에 다시 제출한 뒤에만 안전한 원본 교체와 동일 outbox fan-out이 시작된다. 협조하지 않는 외부 writer와의 완전한 POSIX CAS는 보장할 수 없으므로 실제 원본 writer는 이 프로토콜과 문서 lock을 함께 사용해야 한다.

팀원이 꼭 맞춰야 하는 필드와 이벤트는 [통합 계약](docs/INTEGRATION_CONTRACT.md), 바로 보낼 내용은 [팀 handoff](docs/TEAM_HANDOFF.md), 성주 역할은 [역할 및 로드맵](docs/ROLE_AND_ROADMAP.md)에 있다.

## Claude와 production

실제 Claude Agent SDK session은 다음 설정으로 활성화한다.

```text
CODEGATE_AGENT_MODE=claude
ANTHROPIC_API_KEY=...
```

production은 Supabase Auth, Claude mode, doc2md URL, 비활성 demo bootstrap, Railway persistent volume이 없으면 설정 단계에서 기동을 거부한다. 적용 절차와 아직 사람이 해야 하는 작업은 [배포 runbook](docs/DEPLOYMENT.md)을 따른다.

## 검증

```bash
uv run ruff format --check .
uv run ruff check .
uv run mypy src
uv run pytest
```

Docker 확인:

```bash
docker build -t codegate-backend .
docker run --rm -p 8000:8000 codegate-backend
```

개발 도구는 저장소 루트의 `AGENTS.md`를 먼저 읽는다. Claude Code는 `CLAUDE.md`가 같은 파일을 import한다. 서비스의 Claude Agent SDK는 개발 도구 지침이 아니라 versioned `llm-wiki/AGENT_GUIDE.md`만 검증해 사용한다.
