# CODEGATE Local

문서 폴더를 로컬에서 변환·색인하고, 근거가 있는 검색과 승인 기반 수정을 제공하는 Electron
데스크톱 앱이다. React renderer와 Electron main process는 우창 저장소가 소유하고, main process가
성주의 Python sidecar, 용휘의 LLMWIKI, 민규의 doc2md를 loopback과 로컬 경로 계약으로 연결한다.

## 개발 실행

요구 사항은 Node.js 18 이상, pnpm, uv, Python 3.12다. 팀 저장소 네 개를 같은 상위 디렉터리에
다음 이름으로 checkout한 구성을 기본으로 자동 탐색한다.

```text
Backend/             codegate-2026-agent
LLMWIKI/             codegate-2026-backend
codegate-2026-api/   codegate-2026-convert
codegate-2026-web/   codegate-2026-local
```

```bash
pnpm install
pnpm integrations:check
pnpm typecheck
pnpm test
pnpm dev:integrated
```

`dev:integrated`는 doc2md를 `uv run --isolated --python 3.12`로 먼저 띄우고 URL을 Electron에
전달한다. 이미 별도로 실행한 doc2md를 쓸 때만 `CODEGATE_DOC2MD_URL=... pnpm dev`를 사용한다.

실제 네 저장소 프로세스를 함께 검증하려면 다음 smoke를 실행한다. Converter는 프로젝트 안에
`.venv`를 만들지 않고 `uv --isolated --python 3.12` 환경에서 실행한다.

```bash
pnpm integrations:smoke
```

smoke는 원본 fixture의 doc2md 변환, sidecar와 LLMWIKI 초기 build, 근거 검색, exact diff 승인,
새 version publish, Undo와 원본 복구를 순서대로 검증한다. 경로를 바꿔야 하면
[`.env.integration.example`](.env.integration.example)의 환경변수를 사용한다.

상세 실행·패키징 경계는 [통합 상태](docs/NEXT_INTEGRATION.md), 현재 구현은
[프론트엔드 스펙](docs/FRONTEND_SPEC.md), 실제 장애 기록은
[troubleshooting](docs/TROUBLESHOOTING.md)을 참고한다.
