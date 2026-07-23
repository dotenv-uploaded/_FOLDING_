# Folding

Folding은 로컬 문서를 검증 가능한 지식 버전으로 정리하고, 근거 기반 검색과 승인형 문서 변경을
제공하는 데스크톱 문서 에이전트 프로젝트입니다.

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

각 컴포넌트의 설치, 실행, 테스트 방법은 해당 디렉터리의 README와 문서를 참고하세요.
