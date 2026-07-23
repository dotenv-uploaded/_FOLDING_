# 규약 — 코드를 쓰기 전에

## 목차
1. [오류 처리](#오류-처리)
2. [주석](#주석)
3. [테스트](#테스트)
4. [명령어](#명령어)
5. [커밋](#커밋)
6. [자주 밟는 지뢰](#자주-밟는-지뢰)

## 오류 처리

**사용자에게는 한국어 문장, 로그에는 원인.** 이 둘을 섞지 않는다.

```ts
throw new UserFacingError('문서를 열지 못했습니다.', { cause: realError });
```

`logError` 는 `cause` 사슬을 끝까지 찍는다. 새 오류 경로를 만들면 원인을 반드시 실어
보낸다 — 감싼 문장만 남으면 진짜 이유(HTTP 상태, 제공자 메시지, 서브프로세스 stderr)가
사라진다. 이 프로젝트에서 그 때문에 다섯 번 헤맸다.

**조용한 실패 금지.** 되돌아가거나 건너뛰었으면 그 사실을 남긴다. 예: kordoc 이 없어
대체 변환기를 쓸 때 `hwp_kordoc_unavailable` 경고를 붙인다. 표가 빠진 결과가 온전한 척
나가면 안 되기 때문이다.

**폴백을 조용히 쓰지 않는다.** 양식 채우기는 설정한 제공자로만 부르고 실패하면 그대로
실패한다. 폴백은 (a) 품질이 눈에 안 보이게 갈리고 (b) 진짜 고장을 "조금 느리다"로
위장한다.

## 주석

주석은 **무엇을** 이 아니라 **왜** 를 적는다. 특히 직관에 어긋나는 결정에는 근거를 남긴다.
이 코드베이스의 주석 상당수가 "이렇게 안 했다가 이런 일이 있었다"를 담고 있다 — 그게 다음
사람이 같은 함정을 피하는 방법이다.

한국어로 쓴다(사용자 문구·로그와 톤을 맞춘다).

## 테스트

`tests/` 평면 배치, vitest. 실행:

```bash
./node_modules/.bin/vitest run              # pnpm 핀 문제를 피해 로컬 바이너리 직접
./node_modules/.bin/tsc -p tsconfig.node.json --noEmit
./node_modules/.bin/tsc -p tsconfig.web.json --noEmit
```

**better-sqlite3 는 Electron ABI 로 빌드돼 러너에서 못 연다.** SQL 을 검증할 때는 Node
내장 `node:sqlite` 로 같은 문을 실행하는 어댑터를 쓴다(`tests/chat-delete.test.ts`,
`tests/usage-limit.test.ts` 참고). Vite 가 `node:sqlite` 를 모르므로 `createRequire` 로
실행 시점에 부른다.

**통합 테스트는 환경변수로 끈다** — 실제 LLM·파일을 쓰기 때문이다:

```bash
CODEGATE_FORM_FILL_INTEGRATION=1 ./node_modules/.bin/vitest run tests/integration-form-fill.test.ts
```

통합 테스트는 경로를 박지 않는다. 앱이 지금 쓰는 것(SQLite 의 등록 폴더, 위키의
`source-md`)을 찾아 쓴다 — 박아 두면 그 컴퓨터에서만 돌고, 더 나쁘게는 앱이 실제로 보는
것과 다른 걸 검증하게 된다.

**통과만 보고 믿지 않는다.** 근거를 지우고 다시 돌려 테스트가 실제로 실패하는지 확인한다.

파이썬 쪽:

```bash
cd ~/dev/codegate-2026-agent && .venv/bin/python -m pytest tests/ --no-cov -q
cd ~/dev/codegate-2026-convert/services/doc2md && PYTHONPATH=. .venv/bin/python -m pytest tests/ -q
```

## 명령어

```bash
pnpm dev:integrated     # doc2md + cloud-api + 사이드카 + 앱 (권장)
pnpm dev                # 앱만
pnpm dev:mock           # 목 에이전트
```

`pnpm exec` 를 거치지 않고 `./node_modules/.bin/*` 를 직접 부른다 — `packageManager` 핀이
맞지 않는 컴퓨터에서 pnpm 이 버전 전환을 시도하다 죽고, 그 실패가 "electron 종료 코드 1"
로만 보여 원인을 찾기 어려웠다.

## 커밋

제목은 무엇을 바꿨는지, 본문은 **왜** 와 **어떻게 확인했는지**. 측정값이 있으면 넣는다.

```
fix: 캐시된 호환 렌더 탓에 한글이 계속 read_only 로 남았다

`materialize()` 는 build_id 만 보고 …
재렌더 후 `일일업무.hwp` 가 editable 로 바뀌는 것을 확인했다.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

커밋 전에 **비밀값을 훑는다**: `AIzaSy…`, `sk-ant-api03-…`, `GOCSPX-…`. `.env` 는 네
저장소 모두 gitignore 돼 있어야 한다.

## 자주 밟는 지뢰

| 증상 | 원인 |
|---|---|
| 고쳤는데 결과가 그대로 | 캐시 판 번호를 안 올렸다 (4곳 중 하나) |
| 재빌드를 눌러도 위키가 그대로 | 사이드카는 활성 빌드가 있으면 재기동해도 새로 안 만든다 → `knowledge/rebuild` |
| 채팅 2번째부터 실패 | 세션 전사본이 저장되지 않아 `resume` 이 실패 |
| 로그인 실패 | cloud-api 가 안 떠 있거나(ECONNREFUSED 8000), client secret 불일치 |
| 사이드카가 통째로 죽음 | 느린 작업(enrichment 등)을 기동 임계 경로에 넣었다 |
| 웹 빌드 타입 오류 | `preload/api.ts` 에 추가한 API 를 `web/bridge.ts` 에 안 넣었다 |
| 로그인 화면 제목이 남색 | `base.css` 를 `layer(base)` 없이 임포트 |
| 우측 패널이 밀림 | 가운데 grid 트랙에 `min-w-0` 이 없다 |
| 요약이 0개 | enrichment 를 부르는 곳이 없거나, 가상 코퍼스 플래그가 꺼져 가드에 막힘 |
| 한글 표 내용이 사라짐 | kordoc 대신 pyhwp2md 로 읽혔다 (`CODEGATE_KORDOC_DIR` 확인) |
