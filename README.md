# Folding

Folding은 로컬 문서를 검증 가능한 지식 버전으로 정리하고, 근거 기반 검색과 승인형 문서 변경을
제공하는 데스크톱 문서 에이전트 프로젝트입니다.

## 완성본 시연

[완성본 시연 영상 보기](docs/demo/folding-final-demo.mov)

## 구성

- `codegate-2026-web`: Electron 데스크톱 앱과 승인 UI
- `Backend`: 로컬 sidecar, 문서 검색, 변경 계획, 승인, Undo와 지식 동기화
- `LLMWIKI`: 문서 정규화, 검색 인덱스와 불변 지식 버전 빌더
- `codegate-2026-api`: 문서 변환 API와 관련 서비스

## 핵심 안전 경계

- 모델은 문서를 직접 쓰거나 삭제하지 않습니다.
- 변경과 삭제는 diff 및 exact `plan_hash` 승인 뒤에만 실행됩니다.
- 원본 hash를 실행 직전에 다시 확인하고 immutable backup과 journal을 남깁니다.
- 파일 변경 뒤 새 지식 버전을 검증해 공개하며 Undo로 원본과 위키를 복원할 수 있습니다.

## 다른 컴퓨터에서 그대로 실행

macOS 또는 Linux에서 저장소 전체를 clone한 뒤 Node.js 18 이상과
[uv](https://docs.astral.sh/uv/)만 준비한다. 저장소 루트에서 다음 명령을 실행하면 pnpm lockfile,
Backend lockfile, doc2md lockfile에 고정된 의존성을 설치하고 실행 설정 파일을 만든다.

```bash
./scripts/bootstrap.sh
```

`codegate-2026-web/.env`에 `CODEGATE_ANTHROPIC_API_KEY`를 입력한 뒤 실행한다. API key와 로그인
세션은 개인 정보이므로 Git에 들어가지 않으며 새 컴퓨터로는 비공개 경로로 옮겨야 한다.

```bash
./scripts/run-app.sh
```

실행 스크립트는 실제 Google OAuth, 고정 callback
`http://127.0.0.1:47821/auth/callback`, Claude Sonnet과 통합 doc2md를 사용한다. 처음 실행한
컴퓨터에서는 Google 로그인을 다시 하고 문서 폴더를 새로 선택해야 한다. 선택한 문서와 로컬 지식
인덱스도 저장소에 포함하지 않는다.

각 컴포넌트의 상세 실행과 테스트 방법은 해당 디렉터리의 README와 문서를 참고하세요.
