# 트러블슈팅 기록

## 2026-07-21 — setup-uv action major tag 해석 실패

### 상황

Backend 기반을 올린 draft PR #1의 첫 GitHub Actions 실행이 job setup 단계에서 4초 만에 실패했다. 애플리케이션 설치와 테스트는 시작되지 않았다.

### 기대와 실제

- 기대: `astral-sh/setup-uv`가 uv를 설치한 뒤 lint, type check, test를 실행
- 실제: `Unable to resolve action astral-sh/setup-uv@v8, unable to find version v8`
- 영향: 코드 품질은 로컬에서 검증됐지만 원격 CI 증거를 만들 수 없었음

실패 실행: https://github.com/dotenv-uploaded/Backend/actions/runs/29809767493

### 조사와 원인

공식 GitHub release API에서 최신 릴리스 `v8.3.2`가 존재함을 확인했다. 그러나 tag 목록에는 `v8.0.0`부터 `v8.3.2`까지의 정확한 버전만 있고 `v8` 이동 tag는 없었다. Workflow가 존재하지 않는 `@v8`을 요청한 것이 직접 원인이었다.

검토한 대안은 다음과 같다.

- `@v7`로 내리기: major alias는 존재하지만 최신 릴리스 기능과 수정 사항을 사용하지 못함
- `@v8.3.2`로 고정: 현재 존재하는 최신 release를 명확히 사용하며 수정 범위가 가장 작음
- commit SHA로 고정: 공급망 관점에서 가장 강하지만 자동 업데이트와 사람이 읽는 버전 추적 비용이 늘어남

해커톤 저장소에서는 정확한 release tag인 `astral-sh/setup-uv@v8.3.2`를 선택했다.

### 해결과 검증

- workflow YAML을 로컬 parser로 다시 읽어 action 값 확인
- `astral-sh/setup-uv@v8.3.2`로 수정해 branch에 push
- 후속 GitHub Actions 실행 성공: https://github.com/dotenv-uploaded/Backend/actions/runs/29809871193

### 재발 방지와 남은 위험

- 새 major action을 쓸 때 release 이름뿐 아니라 실제 major alias ref 존재 여부를 확인한다.
- CI가 job setup에서 즉시 실패하면 애플리케이션보다 action resolution 로그를 먼저 본다.
- release tag도 저장소 관리자가 이동시킬 수 있으므로 제품화 단계에서는 commit SHA 고정과 자동 업데이트 도구를 재검토한다.

면접에서는 “로컬 통과와 원격 CI 통과가 왜 다른가”, “action tag와 commit SHA 고정의 trade-off는 무엇인가”, “setup 단계 실패를 어떻게 빠르게 분류했는가”를 설명할 수 있다.
