# 백엔드 설계 & MVP 개발 가이드

CODEGATE AI 스타트업 해커톤 본선용 백엔드 세팅 결과와, 이 위에서 MVP를 어떻게 설계·개발해야 하는지 정리한 문서.

## 1. 설치된 것 / 왜 이걸 골랐는지

| 위치 | 출처 | 스타 | 역할 |
|---|---|---|---|
| `backend/` | [fastapi/full-stack-fastapi-template](https://github.com/fastapi/full-stack-fastapi-template) | 44.3k | FastAPI 공식 프로덕션급 백엔드 뼈대 (JWT 인증, SQLModel+Alembic, 테스트, Docker) |
| `security/cheatsheets/` | [OWASP/CheatSheetSeries](https://github.com/OWASP/CheatSheetSeries) | 32.6k | 실전 보안 체크리스트 120개 (인증, 세션, 인젝션, API 등 카테고리별) |
| `backend` dev deps | `bandit`, `pip-audit` | 8.2k / PyPA 공식 | 코드 정적 보안 스캔 + 의존성 CVE 스캔 |

숫자는 임의 추천이 아니라 GitHub API로 실측 확인한 값. `zhanymkanov/fastapi-best-practices`(17.7k)는 코드 대신 읽을거리라 설치 없이 이 문서에 원칙만 흡수했다.

**클론 후 수정한 것**: 템플릿 원본에 최신 문법 버그 2개가 있어 즉시 고쳤다 — `except A, B:` → `except (A, B):` (`app/api/deps.py`), 순방향 참조 깨짐 → `from __future__ import annotations` 추가 (`app/models.py`). `uv run python -c "from app.main import app"` 로 import 확인 완료.

Python 요구 버전은 템플릿 기본값(3.14)에서 로컬 환경에 맞춰 `>=3.11`로 낮춰뒀다.

## 2. 로컬 실행

```bash
# DB + 백엔드 동시 실행
docker compose up -d

# 또는 백엔드만 직접 (Postgres는 별도로 떠 있어야 함, .env의 POSTGRES_SERVER를 localhost로)
cd backend
uv sync
uv run alembic upgrade head
uv run fastapi dev app/main.py   # http://localhost:8000/docs
```

루트 `.env`는 이미 생성됨 (`SECRET_KEY`, `POSTGRES_PASSWORD`, `FIRST_SUPERUSER_PASSWORD`를 랜덤 값으로 채워둠). **이 파일은 커밋하지 말 것** — `.gitignore`에 이미 걸려 있음. 팀원과 공유할 때는 `.env.example`을 기준으로 각자 생성.

보안 스캔:
```bash
cd backend
uv run bandit -c pyproject.toml -r app -q     # 코드 취약 패턴
PYTHONUTF8=1 uv run pip-audit                  # 의존성 CVE (경로에 한글이 있어 PYTHONUTF8=1 필요)
uv run ruff check app && uv run mypy app       # 린트/타입
```

## 3. 아키텍처 설계 원칙

템플릿은 이미 계층 구조가 잡혀 있다 — 그 구조를 유지하며 확장하는 게 핵심이다.

```
app/
  api/
    routes/        # 엔드포인트 (얇게 유지 — 검증 + 서비스 호출만)
    deps.py         # 인증/세션 등 공용 의존성
  core/
    config.py       # 환경변수 기반 Settings (pydantic-settings)
    security.py      # JWT, 비밀번호 해시
    db.py           # SQLModel 엔진/세션
  models.py         # DB 테이블 + API 스키마 (SQLModel)
  crud.py           # DB 접근 함수
```

**MVP 확장 시 지켜야 할 것:**
- **라우트는 얇게**: 비즈니스 로직을 라우트 함수에 직접 쓰지 말고 `crud.py`나 새 `services/` 모듈로 뺀다. 해커톤이라 빨리 짜더라도 이 경계는 지켜야 나중에 데모 직전 디버깅이 지옥이 안 된다.
- **도메인별로 파일 쪼개기**: `models.py` 하나에 다 넣는 템플릿 기본 구조는 초기엔 괜찮지만, 도메인(예: `chat`, `document`, `billing`)이 3개 이상 늘면 `app/models/`, `app/api/routes/` 아래 도메인별 파일로 쪼갠다.
- **Pydantic 스키마 = 계약**: 요청/응답 스키마를 명시적으로 분리(`XCreate`, `XPublic`, `XUpdate` 템플릿 패턴 그대로 따라가기) — 프론트/심사위원 데모에서 필드 누락 사고를 막아준다.
- **설정은 전부 `core/config.py`의 `Settings`를 통해서만** — `os.environ` 직접 호출 금지. API 키, DB 접속정보 등 전부 여기 필드로 선언하고 `.env`에서 주입.

## 4. AI 스타트업 특화 설계

일반 CRUD 백엔드와 다르게 신경 써야 할 부분:

1. **LLM 호출은 별도 서비스 레이어로 격리**: `app/services/llm.py` 같은 모듈을 만들어 OpenAI/Anthropic/기타 API 호출을 감싼다. 라우트가 직접 SDK를 호출하지 않게 해야 나중에 모델 교체·재시도·캐싱을 한 곳에서 관리할 수 있다.
2. **스트리밍 응답**: 챗봇/생성형 기능이면 FastAPI의 `StreamingResponse`(SSE)를 기본으로 잡아라 — 심사 데모에서 체감 응답속도가 크게 갈린다.
3. **비동기 + 타임아웃 + 재시도**: LLM 호출은 느리고 가끔 실패한다. 템플릿에 이미 있는 `tenacity`를 LLM 호출에도 그대로 활용 (`@retry` + `stop_after_attempt` + `wait_exponential`). 타임아웃 없는 외부 호출은 절대 금지.
4. **비용/레이트리밋 가드**: 무료 API 크레딧으로 데모하는 경우가 많다 — 사용자별/IP별 요청 횟수 제한(간단히 인메모리 카운터 또는 `slowapi`)을 넣어 데모 중 크레딧 소진을 막는다.
5. **긴 작업은 비동기 큐로 분리**: 문서 분석·배치 생성처럼 오래 걸리는 작업은 요청-응답 안에서 블로킹하지 말고 백그라운드 태스크(FastAPI `BackgroundTasks`, 시간 있으면 Celery/RQ)로 빼고 폴링 또는 웹소켓으로 상태를 알려준다.
6. **프롬프트도 버전 관리 대상**: 프롬프트 템플릿을 코드에 하드코딩하지 말고 `app/prompts/` 같은 곳에 파일로 분리 — 심사 전날 프롬프트 튜닝할 때 git diff로 추적 가능하게.
7. **벡터 검색이 필요하면**: MVP 단계에선 별도 벡터DB 인프라(Pinecone/Weaviate) 세팅 시간을 아끼고 `pgvector` 확장을 기존 Postgres에 붙이는 걸 먼저 고려 — 이미 Postgres가 떠 있으므로 인프라 추가 없이 갈 수 있다.

## 5. 보안 체크리스트 (OWASP 매핑)

`security/cheatsheets/`에 있는 시트 중 해커톤 MVP에서 실제로 자주 사고 나는 것들:

| 리스크 | 참고 시트 | 이 프로젝트에서 확인할 것 |
|---|---|---|
| 인증/세션 | `Authentication_Cheat_Sheet.md`, `Session_Management_Cheat_Sheet.md` | JWT 만료시간(`security.py`), 비밀번호는 `pwdlib`(argon2)로 해시 — 이미 템플릿에 구현됨 |
| 인가(IDOR) | `Authorization_Cheat_Sheet.md` | `crud.py`에서 `owner_id`로 리소스 소유자 검증하는지 (템플릿의 `items` 라우트가 예시) — 새 도메인 추가할 때마다 빠뜨리기 쉬움 |
| 입력 검증/인젝션 | `Input_Validation_Cheat_Sheet.md`, `SQL_Injection_Prevention_Cheat_Sheet.md` | SQLModel/SQLAlchemy ORM만 쓰고 raw SQL 문자열 조합 금지 |
| 시크릿 관리 | `Secrets_Management_Cheat_Sheet.md` | `.env`는 절대 커밋 금지(이미 `.gitignore` 처리), 배포 시 `SECRET_KEY`를 임의값으로 재생성 |
| CORS | `Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.md` | `BACKEND_CORS_ORIGINS`를 배포 도메인으로 좁히기(`*` 금지) |
| LLM 프롬프트 인젝션 | `LLM_Prompt_Injection_Prevention_Cheat_Sheet.md` | 사용자 입력을 시스템 프롬프트에 그대로 이어붙이지 말고 역할 분리, 외부 콘텐츠(검색 결과 등)는 신뢰 경계로 명시 |
| API 보안 전반 | `REST_Security_Cheat_Sheet.md` | 레이트리밋, 에러 메시지에 스택트레이스 노출 금지(`ENVIRONMENT=production`일 때 FastAPI 기본 동작 확인) |

커밋 전 최소한 `bandit`과 `pip-audit`은 CI 없이도 로컬에서 한 번씩 돌리는 걸 습관화.

## 6. MVP 개발 순서 (제안)

1. **도메인 모델 정의** — 서비스 핵심 엔티티를 `models.py`(또는 도메인별 파일)에 SQLModel로 추가, `alembic revision --autogenerate` → `alembic upgrade head`.
2. **인증은 템플릿 그대로 사용** — 새로 안 만들어도 됨. `FIRST_SUPERUSER`로 관리자 계정 시딩(`initial_data.py`)까지 이미 구현돼 있음.
3. **핵심 API 1개를 엔드투엔드로** — 프론트가 붙을 수 있는 가장 중요한 기능 하나를 먼저 완성 (인증 → 요청 → LLM/DB 처리 → 응답)해서 데모 가능한 뼈대부터 확보.
4. **AI 서비스 레이어 추가** — 위 4장 원칙대로 `app/services/llm.py` 분리, 스트리밍/재시도 붙이기.
5. **나머지 기능 확장** — 우선순위 낮은 기능은 목데이터로 먼저 프론트와 계약(스키마)만 맞추고 이후 구현.
6. **데모 안정화** — 시드 데이터 스크립트 정리, 에러 발생 시 500 대신 명확한 4xx 메시지, 헬스체크(`/api/v1/utils/health-check/`)로 배포 확인.

## 7. 참고 문서

- 템플릿 자체 문서: `backend/README.md`
- OWASP 전체 인덱스: `security/Index.md`
- FastAPI 실전 패턴 요약(외부 링크, 설치 안 함): https://github.com/zhanymkanov/fastapi-best-practices
