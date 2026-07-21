# Backend

성주가 담당하는 CODEGATE 2026 지식 그래프 기반 문서 검색·수정 에이전트의 FastAPI 백엔드입니다. 현재 구현 범위는 Phase 0~1로, 합성 `llm-wiki` 패키지를 검증하고 자연어 검색 결과를 HTTP API로 반환합니다.

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
- `source://` URI의 allowlist root 해석과 경로 이탈 차단
- `GET /api/v1/health`
- `POST /api/v1/chat/messages`의 read-only 위치 검색
- `GET /api/v1/documents/{document_id}`
- 합성 문서 5개를 사용한 독립 실행 fixture

아직 Agents SDK, 변경 preview, 승인, 실제 쓰기, Undo, 재변환·재색인은 연결하지 않았습니다. 구현 순서와 팀 경계는 [통합 계약](docs/INTEGRATION_CONTRACT.md)과 [ADR](docs/adr/0001-backend-boundary.md)을 따릅니다.

## 환경변수

`.env.example`을 `.env`로 복사해 로컬 경로와 허용 origin을 바꿀 수 있습니다. 실제 API key나 Supabase key는 커밋하지 않습니다.
