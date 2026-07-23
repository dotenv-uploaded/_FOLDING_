# 트러블슈팅 기록

## 2026-07-22 — Railway doc2md healthcheck가 IPv6 bind에서 503

### 상황과 영향

첫 doc2md 컨테이너는 Uvicorn을 `--host ::`로 시작했고 application startup 로그도 정상이었지만,
Railway `/health` 요청은 2분 동안 service unavailable을 반환해 배포가 실패했다.

### 증거와 원인

컨테이너 로그에는 Uvicorn의 `[::]:8080` listen과 startup 완료만 있고 healthcheck access log는
없었다. Uvicorn은 `::` bind를 public/private dual-stack으로 처리하지 않으며 Railway의 Uvicorn
private-network 지침은 빈 host를 요구한다. 애플리케이션 오류가 아니라 listener 주소가 원인이었다.

### 해결과 검증

start command를 `uvicorn ... --host "" --port "${PORT:-8080}"`로 바꿨다. 재배포 첫 healthcheck가
성공했고 service가 `RUNNING`이 됐다. 인증된 synthetic bytes 변환과 Backend의 private health 호출도
성공했다.

### 재발 방지와 남은 위험

`railway.toml`에 dual-stack bind와 healthcheck를 함께 유지하고 실제 Railway 배포로 검증한다.
OCR model cold-start와 대형 파일 변환은 별도 성능 smoke가 필요하다.

## 2026-07-22 — Python 3.14에서 PaddlePaddle wheel 해석 실패

로컬 기본 Python 3.14로 isolated test 환경을 만들 때 PaddlePaddle의 호환 wheel이 없어 dependency
resolution이 실패했다. 배포 image와 검증 interpreter를 프로젝트 지원 버전인 Python 3.12로 고정해
104개 테스트를 통과했다. 생성된 실패 환경은 저장소 밖의 임시 위치로 옮겨 작업 트리에 포함되지
않게 했다.
