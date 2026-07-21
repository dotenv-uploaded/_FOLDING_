# 로컬 앱 runtime 계약

이 모드는 다운로드 앱의 sidecar API를 위한 것이다. Claude Agent SDK session과 LLMWIKI builder,
원본 파일 write, SQLite journal, backup은 사용자 장치에서 실행한다. Claude 모델 추론에는
네트워크와 사용자 소유 `ANTHROPIC_API_KEY`가 필요하다.

## 디렉터리

서로 겹치지 않는 네 경로를 준비한다.

```text
source/                 사용자가 허용한 원본 파일 정본
source-md/              doc2md가 만든 LLMWIKI 입력 Markdown
llmwiki-storage/        tenant/wiki current.json과 불변 native builds
app-data/               SQLite, backup, Claude session, compatibility cache
```

`source-md/*.md`는 LLMWIKI `INPUT_CONTRACT.md`를 따라야 한다. 새 파일의 최초 정규화는 doc2md
또는 desktop ingestion 계층이 담당한다. source와 source-md를 같은 파일로 두면 frontmatter의
source SHA가 자기 자신을 참조하므로 지원하지 않는다.

LLMWIKI project root는 사용자가 고르는 문서 폴더가 아니라 앱과 함께 배포·검증한 code bundle
경로다. 현재 호환 기준은 `dotenv-uploaded/LLMWIKI@fb0f8c7`이다.

## 실행

```bash
export ANTHROPIC_API_KEY=<user-api-key>

uv run codegate-local \
  --source-root /absolute/workspace/source \
  --llmwiki-project-root /absolute/app/LLMWIKI \
  --llmwiki-input-root /absolute/workspace/source-md \
  --llmwiki-storage-root /absolute/app-data/llmwiki \
  --data-root /absolute/app-data/codegate \
  --cors-origin http://127.0.0.1:3000
```

`codegate-local`은 loopback IP만 bind한다. Claude 연결 없이 상태 머신만 개발할 때에만
`--deterministic-agent`를 추가한다. 제품 배포판은 이 옵션을 기본으로 사용하지 않는다.

doc2md v0.2를 함께 실행하는 구성이라면 `--doc2md-url http://127.0.0.1:<port>`를 추가한다.
로컬 CLI의 기본 transport는 `source.kind=path`이므로 Backend와 같은 filesystem namespace와
loopback/trusted process 경계가 필요하다. doc2md에 Bearer 인증을 켰다면
`CODEGATE_DOC2MD_API_TOKEN`과 doc2md의 `DOC2MD_API_TOKEN`에 같은 값을 설정한다.

## 한 번의 변경

```text
사용자 명령
→ Claude가 app-owned read tools로 LLMWIKI와 현재 원본 확인
→ exact diff preview
→ 사용자 plan_hash 승인
→ 원본 backup + atomic replace
→ 정규화 Markdown 재변환 또는 exact update
→ source.sha256 + revision 갱신
→ WikiBuildService CAS build
→ native current.json 공개
→ build-ID compatibility cache 검증
→ 새 근거 검색
```

LLMWIKI build가 실패해도 원본 write 기록과 backup은 남고 이전 current는 계속 제공된다.
execution의 `sync_retryable`에서 동일 event를 retry하거나 Undo한다.

## 로그인과 로컬 권한

Frontend 로그인은 Supabase SDK가 직접 처리한다. cloud Backend 요청에만 access token을
`Authorization: Bearer ...`로 보낸 뒤 `/api/v1/auth/me`로 provisioning과 문서 권한을 확인한다.
password와 refresh token은 CODEGATE Backend로 보내지 않는다.

로컬 sidecar에는 Supabase Bearer token을 전달하지 않는다. sidecar의 `authz_source`는
`local-workspace`이며 사용자가 OS에서 허용한 source root에만 접근한다. 따라서 frontend는
다음 두 client를 구분해야 한다.

```text
cloud API client     Supabase access token 포함, 계정·tenant ACL
local sidecar client Bearer 없음, loopback URL, 로컬 workspace capability
```

Supabase 로그아웃은 frontend SDK가 처리한다. 로그아웃은 cloud session을 끝내며 로컬 파일을
삭제하거나 LLMWIKI build를 되돌리지 않는다.
