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

**팀이 Supabase로 서버 호스팅을 정한 뒤 추가로 리팩터링한 것** — 자세한 내용은 8장 참고:
- 인증을 템플릿의 자체 JWT 발급/비밀번호 해시(`pwdlib`)에서 **Supabase Auth 토큰 검증**으로 전면 교체 (`/login/*` 라우트 삭제, `core/security.py`가 이제 Supabase JWT를 검증만 함).
- `User` 테이블에서 `hashed_password` 제거, `id`는 Supabase `auth.users.id`를 그대로 사용. 첫 인증 요청 시 로컬 프로필 행을 자동 생성(`crud.get_or_create_user`).
- DB 연결을 Supabase managed Postgres(SSL)로 전환, `docker-compose.yml`에서 로컬 `db` 서비스 제거.
- Alembic 마이그레이션 5개를 새 스키마에 맞춰 1개로 스쿼시(`0001_initial_schema.py`) — 아직 어떤 환경에도 배포된 적 없는 프로젝트라 안전하게 정리.

## 2. 로컬 실행

```bash
cd backend
uv sync
uv run alembic upgrade head
uv run fastapi dev app/main.py   # http://localhost:8000/docs
```

또는 `docker compose up -d` (백엔드 컨테이너만 뜬다 — DB는 Supabase가 호스팅).

루트 `.env`는 `.env.example`을 복사해서 만들어져 있지만 `SUPABASE_URL`/`SUPABASE_JWT_SECRET`/`POSTGRES_*`는 아직 플레이스홀더다 — **8장을 따라 실제 Supabase 프로젝트 값으로 채워야 백엔드가 뜬다.** `.env`는 커밋하지 말 것(이미 `.gitignore` 처리). 팀원과 공유할 때는 `.env.example`을 기준으로 각자 생성.

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
    security.py      # Supabase JWT 검증 (토큰을 발급하지 않고 검증만 함)
    db.py           # SQLModel 엔진/세션 (Supabase Postgres, SSL)
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
| 인증/세션 | `Authentication_Cheat_Sheet.md`, `Session_Management_Cheat_Sheet.md` | 비밀번호 저장/해시는 Supabase Auth 책임 — 이 백엔드는 절대 비밀번호를 다루지 않는다. `SUPABASE_JWT_SECRET`이 유출되면 토큰 위조가 가능하므로 `.env`와 동급으로 취급 |
| 인가(IDOR) | `Authorization_Cheat_Sheet.md` | `crud.py`에서 `owner_id`로 리소스 소유자 검증하는지 (템플릿의 `items` 라우트가 예시) — 새 도메인 추가할 때마다 빠뜨리기 쉬움 |
| 입력 검증/인젝션 | `Input_Validation_Cheat_Sheet.md`, `SQL_Injection_Prevention_Cheat_Sheet.md` | SQLModel/SQLAlchemy ORM만 쓰고 raw SQL 문자열 조합 금지 |
| 시크릿 관리 | `Secrets_Management_Cheat_Sheet.md` | `.env`는 절대 커밋 금지(이미 `.gitignore` 처리), 배포 시 `SECRET_KEY`를 임의값으로 재생성 |
| CORS | `Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.md` | `BACKEND_CORS_ORIGINS`를 배포 도메인으로 좁히기(`*` 금지) |
| LLM 프롬프트 인젝션 | `LLM_Prompt_Injection_Prevention_Cheat_Sheet.md` | 사용자 입력을 시스템 프롬프트에 그대로 이어붙이지 말고 역할 분리, 외부 콘텐츠(검색 결과 등)는 신뢰 경계로 명시 |
| API 보안 전반 | `REST_Security_Cheat_Sheet.md` | 레이트리밋, 에러 메시지에 스택트레이스 노출 금지(`ENVIRONMENT=production`일 때 FastAPI 기본 동작 확인) |

커밋 전 최소한 `bandit`과 `pip-audit`은 CI 없이도 로컬에서 한 번씩 돌리는 걸 습관화.

## 6. MVP 개발 순서 (제안)

1. **도메인 모델 정의** — 서비스 핵심 엔티티를 `models.py`(또는 도메인별 파일)에 SQLModel로 추가, `alembic revision --autogenerate` → `alembic upgrade head`.
2. **인증은 프론트가 Supabase Auth로 직접 처리** — 백엔드는 아무 로그인/회원가입 라우트도 만들 필요 없음(8장 참고). 프론트에서 `supabase-js`로 로그인한 뒤 받은 `access_token`을 `Authorization: Bearer <token>`으로 이 백엔드에 보내면 끝.
3. **핵심 API 1개를 엔드투엔드로** — 프론트가 붙을 수 있는 가장 중요한 기능 하나를 먼저 완성 (인증 → 요청 → LLM/DB 처리 → 응답)해서 데모 가능한 뼈대부터 확보.
4. **AI 서비스 레이어 추가** — 위 4장 원칙대로 `app/services/llm.py` 분리, 스트리밍/재시도 붙이기.
5. **나머지 기능 확장** — 우선순위 낮은 기능은 목데이터로 먼저 프론트와 계약(스키마)만 맞추고 이후 구현.
6. **데모 안정화** — 시드 데이터 스크립트 정리, 에러 발생 시 500 대신 명확한 4xx 메시지, 헬스체크(`/api/v1/utils/health-check/`)로 배포 확인.

## 7. 참고 문서

- 디렉토리 구조/요청 흐름/데이터 모델 상세: [BACKEND_STRUCTURE.md](BACKEND_STRUCTURE.md)
- 템플릿 자체 문서: `backend/README.md`
- OWASP 전체 인덱스: `security/Index.md`
- FastAPI 실전 패턴 요약(외부 링크, 설치 안 함): https://github.com/zhanymkanov/fastapi-best-practices

## 8. Supabase 통합 (Postgres + Auth)

팀 결정: **Supabase = 호스팅 Postgres + 인증(Auth)**, 비즈니스 로직/API는 계속 이 FastAPI 백엔드가 담당한다. 즉 프론트가 로그인·회원가입·비밀번호 재설정을 Supabase에 직접 요청하고, 이 백엔드는 프론트가 들고 온 Supabase 토큰을 검증만 한다.

### 8.1 Supabase 프로젝트에서 값 가져오기

1. [supabase.com](https://supabase.com)에서 프로젝트 생성.
2. **Project Settings → API**: `Project URL` → `.env`의 `SUPABASE_URL`. **JWT Settings → JWT Secret** → `SUPABASE_JWT_SECRET` (이 값이 이 백엔드가 토큰을 검증하는 유일한 비밀 — 유출되면 누구나 임의 사용자로 위조 토큰을 만들 수 있으니 `.env`와 동급으로 취급).
3. **Project Settings → Database**: Connection string에서 host/port/password를 꺼내 `POSTGRES_SERVER`/`POSTGRES_PORT`/`POSTGRES_PASSWORD`에 채운다. **Connection pooling(포트 6543, transaction mode)** 을 기본으로 쓴다 — FastAPI처럼 요청마다 짧게 연결하는 앱에 맞고, Supabase 무료 플랜의 direct connection 개수 제한을 피할 수 있다. Alembic 마이그레이션처럼 세션이 오래 유지돼야 하는 작업만 direct connection(5432)을 임시로 쓴다.
4. `uv run alembic upgrade head`로 스키마 적용.

### 8.2 인증 흐름

```
[프론트] --supabase-js login/signup--> [Supabase Auth]
[프론트] <--------- access_token(JWT) -----------
[프론트] --Authorization: Bearer <token>--> [이 FastAPI 백엔드]
[백엔드] --SUPABASE_JWT_SECRET으로 서명 검증(app/core/security.py)--
[백엔드] --sub(uuid)/email로 로컬 User 행 조회, 없으면 자동 생성(app/crud.get_or_create_user)--
```

- 백엔드는 `/login`, `/signup`, `/reset-password` 라우트를 갖지 않는다 — 전부 프론트에서 `supabase-js`로 Supabase Auth API를 직접 호출한다.
- `User.id`는 항상 Supabase `auth.users.id`와 같은 값이다. 로컬 `User` 테이블은 앱 전용 필드(`is_superuser`, `full_name` 등)만 들고, 계정 자체(이메일 인증, 비밀번호, OAuth)는 전부 Supabase가 책임진다.
- 관리자 권한 부여: 해당 사용자가 한 번이라도 로그인해 로컬 프로필 행이 생긴 뒤, 기존 superuser가 `PATCH /api/v1/users/{id}` (`is_superuser: true`)로 승격한다. 최초 1명은 Supabase Dashboard → SQL Editor에서 `UPDATE "user" SET is_superuser = true WHERE email = '...'`로 직접 올린다.
- 로컬 테스트/시딩용으로 `POST /api/v1/private/users/`(ENVIRONMENT=local에서만 mount)가 Supabase 없이 로컬 프로필 행만 직접 만들어준다.

### 8.3 프론트엔드 쪽 (참고)

```ts
// supabase-js 로그인 후
const { data: { session } } = await supabase.auth.getSession()
fetch(`${API_URL}/api/v1/users/me`, {
  headers: { Authorization: `Bearer ${session?.access_token}` },
})
```

### 8.4 테스트에서 인증 흉내내기

실제 Supabase 없이도 백엔드 테스트가 인증을 통과할 수 있다 — `SUPABASE_JWT_SECRET`만 같으면 서명이 유효하기 때문. `tests/utils/utils.py`의 `mint_supabase_token(user_id, email)`이 Supabase가 발급하는 것과 같은 모양의 JWT를 로컬에서 만들어준다. 단, DB 자체는 여전히 `.env`의 Supabase Postgres에 실제로 붙는다(로컬 SQLite/인메모리로 안 바꿔놨음) — `pytest`를 돌리려면 8.1을 먼저 마쳐야 한다.
