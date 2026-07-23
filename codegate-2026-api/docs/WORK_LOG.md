# 작업 로그

## 2026-07-22 — 팀원 HWP 읽기 개선 선별 통합

- 목적: 병합 셀 중심 HWP/HWPX에서 검색·질문 근거 본문이 누락되는 문제를 줄인다.
- 변경: Kordoc 우선 본문 추출, pyhwp2md 대체 시 명시적 진단, 변환 캐시 버전 키와 집중 테스트를 추가했다.
- 검증: 변경 파일 문법 컴파일과 diff 검사를 통과했다. 집중 pytest는 현재 Python 3.14 환경에
  `paddlepaddle` wheel이 없어 의존성 동기화 단계에서 실행되지 못했다.
- 전달 상태: 로컬 변경만 반영했으며 commit, push, 배포는 수행하지 않았다.
- 결정: `rhwp`로 쓰기 엔진을 교체하지 않고 검증된 Kordoc 왕복 경로를 유지한다.

## 2026-07-22 — Railway Backend 통합 배포

- 목적: doc2md v0.2를 Backend와 같은 Railway 프로젝트에 배포하고 하나의 공개 Backend 뒤에서 사용
- 변경: Python 3.12 CPU Docker image, frozen uv lock, Railway healthcheck와 private dual-stack bind,
  `.dockerignore`를 추가했다. 서비스는 Bearer 인증과 bytes transport를 사용하고 public domain은
  만들지 않는다.
- 검증: Python 3.12 isolated 환경에서 104개 테스트를 통과했다. Railway image build와 `/health`가
  성공했고 synthetic Markdown의 `/v2/convert`에서 source SHA, version 0.2.0, section mapping과
  warning 0건을 확인했다. Backend 재배포 뒤 `/api/v1/health`는 `converter_available=true`였다.
- 전달 상태: `codegate-backend` 프로젝트의 `doc2md` 서비스가 `RUNNING`이며 Backend 내부 주소
  `http://doc2md.railway.internal:8080`에서만 접근할 수 있다.
- 결정: Browser와 public network에는 Backend 하나만 노출한다. Converter는 독립 process로 장애와
  OCR 자원을 격리하되 같은 project의 private network에서 Backend 구성요소처럼 사용한다.
- 남은 일: 실제 대형 PDF/HWP corpus로 Railway CPU cold-start와 OCR 처리 시간·메모리를 측정한다.
