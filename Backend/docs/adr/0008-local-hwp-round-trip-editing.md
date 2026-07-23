# ADR 0008: 검증된 로컬 HWP/HWPX 왕복 편집 경계

- 상태: 채택
- 날짜: 2026-07-22

## 배경

로컬 문서 검색은 HWP/HWPX를 변환해 읽을 수 있었지만, 기존 변환 결과는 일부 첫 페이지와 표를
누락했고 원본 write-back capability는 항상 false였다. 그 결과 정확한 파일명을 지정한 필드 조회도
실패하고, 필드 변경 요청은 일반적인 재질문으로 끝났다. 바이너리 문서를 모델이나 일반 텍스트 writer가
직접 수정하게 하면 서식 손상, 부분 적용, 승인 우회와 복구 불능 위험이 생긴다.

## 결정

HWP/HWPX 편집은 Electron이 확인한 로컬 Kordoc runtime과 Backend의 결정론적 operation 경계에서만
허용한다. Electron은 시작 전에 Kordoc entry와 필수 production dependency graph 전체의 SHA-256을
검증해 sidecar에 전달한다. Sidecar는 지원 여부 확인과 실행 직전에 같은 graph를 다시 계산한다.
Node child는 Electron main과 분리된 검증 가능한 Node 실행 파일로 띄우며 허용된 package 경로만 읽을
수 있다. 개발 앱은 PATH의 Node를 사용하고 설치본은 별도 bundled Node를 release gate로 요구한다.
네트워크, child process, addon, prototype 변경을 막고 환경변수 allowlist, 입력·출력·heap·timeout
상한을 둔다.

변경 계획은 원본 SHA, 정확한 before/after operation과 diff를 포함한다. 사용자가 같은 plan hash를
승인하기 전 source write는 없다. 승인 시 immutable backup을 만든 뒤 임시 파일에서 patch를 수행하고,
Kordoc이 모든 operation을 적용했으며 skipped operation이 0인지 확인한다. 결과 문서를 다시 parse한
Markdown이 요청 결과와 정확히 같을 때만 atomic replace한다. normalized LLMWIKI input은 기존 본문에
operation을 다시 적용해 추정하지 않고, 교체된 HWP/HWPX를 재parse한 결과에서만 만든다.

원본과 active build의 hash를 다시 확인한 뒤 candidate를 stage·검증하고 CAS로 공개한다. publish 실패는
기존 build를 유지하며 retry 또는 exact backup Undo로 수렴한다. 동일 source SHA의 변환 교정은 Electron이
전달한 input snapshot attestation 또는 같은 active build에 durable하게 기록된 drift 상태가 있을 때만
재build한다.

## 결과

- 정확한 HWP/HWPX 필드 조회와 승인 기반 변경·삭제·Undo가 서식을 보존한 채 가능하다.
- codec 또는 graph attestation이 없거나 달라지면 capability와 실행이 모두 fail-closed한다.
- 문서 bytes와 본문만 child에 전달되고 cloud credential, OAuth token, source path는 전달되지 않는다.
- 지원 여부 확인은 현재 설치 graph를 다시 해시하므로 로컬 측정에서 약 0.7초가 걸린다. 변경 계획의
  안전 경계에서는 허용 가능한 비용이며, signed immutable resource가 생기기 전까지 캐시하지 않는다.
- 서명된 설치본에서 ASAR/resource 배치와 bundled standalone Node 실행은 별도 release smoke gate다.

## 검토한 대안

- HWP/HWPX를 계속 read-only로 유지: 데이터 손상 위험은 없지만 핵심 사용자 작업을 해결하지 못한다.
- Electron main process에서 직접 Kordoc 실행: main process의 넓은 환경과 credential 경계가 parser에
  노출되어 제외했다.
- Electron-as-Node 실행: 현재 Electron 33의 Node 20 permission flag와 pnpm symlink module resolution이
  충돌해 검증 package graph를 로드하지 못하므로 제외했다.
- 변환된 Markdown만 수정한 뒤 원본과 동기화됐다고 표시: 원본이 바뀌지 않고 지식 결과만 달라져
  제외했다.
- 재parse 없이 기존 normalized body에 operation 적용: 표 구조와 변환 규칙 차이로 source와 index가
  어긋날 수 있어 제외했다.
- 모델에게 바이너리 write 권한 제공: 승인, exact diff, atomicity와 deterministic verification을
  보장할 수 없어 제외했다.
