# Backend

성주가 담당하는 CODEGATE 2026 지식 그래프 기반 문서 검색·수정 에이전트의 FastAPI 백엔드입니다. 현재 구현 범위는 Phase 0~2 기반으로, 합성 `llm-wiki` 패키지를 검증하고 접근 가능한 자연어 검색 결과를 HTTP API로 반환하며 Claude Agent SDK의 안전한 read-only runtime을 구성합니다.

## 빠른 시작

요구 사항:

- Python 3.12+
- [uv](https://docs.astral.sh/uv/)

```bash
uv sync --all-groups
uv run uvicorn codegate_api.main:app --reload
```

다른 터미널에서 확인합니다.

```bash
curl http://127.0.0.1:8000/api/v1/health

curl -X POST http://127.0.0.1:8000/api/v1/chat/messages \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 00000000-0000-0000-0000-000000000001' \
  -d '{"conversation_id":"demo","message":"개인정보 보관 기간 문서 어디 있어?"}'
```

OpenAPI 문서는 서버 실행 후 `http://127.0.0.1:8000/docs`에서 확인할 수 있습니다.

## 검증

```bash
uv run ruff format --check .
uv run ruff check .
uv run mypy src
uv run pytest
```

## 현재 범위

- `llm-wiki` checksum과 JSONL 참조 무결성 검증
- source·chunk SHA-256 검증과 `AGENT_GUIDE.md` 필수 로드
- 미인증 요청은 public 문서만 허용하는 deny-by-default ACL
- `source://` URI의 allowlist root 해석과 경로 이탈 차단
- `GET /api/v1/health`
- `POST /api/v1/chat/messages`의 read-only 위치 검색
- `GET /api/v1/documents/{document_id}`
- 합성 문서 5개를 사용한 독립 실행 fixture

Claude Agent SDK의 deny-by-default client와 read-only in-process MCP tool은 구성했습니다. 각 세션은 체크섬 포함이 강제된 `AGENT_GUIDE.md`의 제한된 TOML frontmatter를 검증·정규화한 시스템 지침을 받으며, 자유 형식 본문은 prompt에 삽입하지 않습니다. built-in file·shell·web tool과 로컬 memory·prompt history도 비활성화됩니다. 아직 실제 model session, Supabase JWT 인증, 변경 preview, 승인, 실제 쓰기, Undo, 재변환·재색인은 API에 연결하지 않았습니다. 성주의 전체 책임과 구현 순서는 [역할 및 로드맵](docs/ROLE_AND_ROADMAP.md), 팀 경계는 [통합 계약](docs/INTEGRATION_CONTRACT.md), 백엔드 경계는 [ADR 0001](docs/adr/0001-backend-boundary.md), 원본 참조와 동시 갱신 방식은 [ADR 0002](docs/adr/0002-knowledge-version-publish.md)를 따릅니다.

## AI 작업 지침

- Codex와 `AGENTS.md`를 지원하는 개발 도구는 저장소 루트의 `AGENTS.md`를 먼저 읽습니다.
- Claude Code는 `CLAUDE.md`가 `AGENTS.md`를 import하므로 같은 계약으로 시작합니다.
- 서비스의 Claude Agent SDK는 개발 도구용 파일에 의존하지 않고 `llm-wiki/AGENT_GUIDE.md`의 구조화 정책만 애플리케이션 코드로 검증·정규화해 주입합니다.

## 환경변수

`.env.example`을 `.env`로 복사해 로컬 경로와 허용 origin을 바꿀 수 있습니다. 실제 API key나 Supabase key는 커밋하지 않습니다.
