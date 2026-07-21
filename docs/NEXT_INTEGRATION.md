# 다음 세션 통합 handoff

## 이번 세션에서 고정한 경계

- 인증 모드는 MVP에서 `local`이다. Supabase는 사용하지 않는다.
- Electron은 문서 폴더가 선택된 뒤에만 `codegate-local`을 시작한다.
- sidecar에는 source, LLMWIKI bundle, normalized input, native storage, app data의 서로 겹치지 않는 경로를 전달한다.
- 개발 환경은 sibling `Backend/.venv/bin/codegate-local`과 `LLMWIKI` checkout을 자동 탐색한다.
- 설치본은 `resources/sidecar/codegate-local`과 `resources/LLMWIKI`를 사용한다.

## 민규 산출물 연결

1. doc2md v0.2를 loopback에서 실행한다.
2. `CODEGATE_DOC2MD_URL`을 설정한다.
3. Electron 변환 package가 준비되면 `CODEGATE_CONVERT_MODULE`을 설정한다.
4. kordoc 실행 파일이 준비되면 `CODEGATE_KORDOC_BIN`을 설정한다.
5. `pnpm integrations:check -- --strict`로 `toInputContract`, deep health, binary를 확인한다.

Backend가 소비하는 doc2md 계약은 `POST /v2/convert`, `GET /capabilities`, `GET /health?deep=1`이다.
별도 process에서는 bytes transport와 Bearer secret을 사용하고, 같은 filesystem에서는 path transport를 사용할 수 있다.

## 용휘 산출물 연결

1. 검증한 LLMWIKI checkout 또는 bundle 경로를 `CODEGATE_LLMWIKI_PROJECT_ROOT`에 설정한다.
2. Electron builder package가 준비되면 `CODEGATE_BUILDER_MODULE`을 설정한다.
3. native storage는 `tenants/<tenant>/wikis/<wiki>/current.json`을 유일한 활성 포인터로 사용한다.
4. `pnpm integrations:check -- --strict`로 bundle과 `assemble` export를 확인한다.

## 통합 전 실행

```bash
pnpm integrations:check
pnpm typecheck
pnpm test
pnpm build
```

외부 산출물이 모두 준비된 뒤 `integrations:check --strict`가 통과해야 설치본 E2E를 시작한다.

## 설치본 E2E

```text
폴더 선택
→ sidecar ready
→ 최초 변환·native build
→ 근거가 있는 질문 응답
→ exact diff와 plan_hash 승인
→ 원본 변경·재빌드
→ 새 근거 검색
→ Undo
→ 앱 종료 뒤 sidecar process 없음
```

Railway는 Electron 또는 로컬 sidecar 배포 대상이 아니다. 향후 별도 cloud API가 필요할 때만 Backend의 `railway.toml`을 사용한다.
