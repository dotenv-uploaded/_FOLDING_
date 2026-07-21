# 작업 로그

## 2026-07-21 — Backend 저장소 기반과 read-only 수직 기능

- 목적: 성주 담당 FastAPI 저장소를 독립 실행 가능하게 만들고, 팀 산출물이 오기 전에도 `llm-wiki` 계약과 위치 검색을 검증
- 변경:
  - Python 3.12, uv, FastAPI 프로젝트와 Docker/Railway 설정 추가
  - 합성 문서 5개, manifest/chunks/links/schema/checksum fixture 추가
  - `source://` allowlist resolver와 경로 이탈 차단 추가
  - knowledge package 무결성 검사와 metadata 우선 검색 추가
  - checksum coverage와 제한된 TOML schema를 검증한 `AGENT_GUIDE.md` 정책을 Claude session 시작 지침으로 정규화
  - Claude Code용 `CLAUDE.md`에서 개발 계약 `AGENTS.md` import
  - public-only anonymous ACL과 relation ACL, source·chunk SHA-256 검증 추가
  - Claude local config 격리와 auto memory·prompt history 비활성화
  - health, chat location, document detail API 추가
  - Claude Agent SDK dependency, deny-by-default client options, read-only MCP tools와 `PreToolUse` hook 추가
  - 역할·통합 계약·기술 결정·CI·CODEOWNERS 추가
  - 원본 `source://` 참조, 증분 변환 뒤 병렬 index fan-out, 검증 barrier와 graph version 원자적 공개를 ADR로 확정
- 검증:
  - Ruff format/check 통과
  - mypy strict 통과
  - pytest 18개 통과, line coverage 91%
  - Claude Agent SDK가 포함된 Python 3.12 Docker image build와 container import 통과
  - 컨테이너 health와 `개인정보 보관 기간 문서 어디 있어?` 검색 HTTP 요청 성공
- 전달 상태: `agent/backend-foundation` branch에 게시 예정. 배포는 수행하지 않음
- 결정:
  - Python-heavy agent/KG/file workflow이므로 FastAPI를 별도 backend로 유지
  - `llm-wiki`를 검색 source of truth로 사용하고 pgvector 중복 적재는 보류
  - LangGraph와 MCP는 단일 agent/tool 흐름이 부족할 때만 추가
  - OS shortcut·symlink 대신 manifest source URI를 사용하고 부분 index update는 active version으로 공개하지 않음
- 남은 일: Claude model session의 API 연결과 실제 allow/deny 통합 검증, Supabase JWT ACL adapter, diff preview, approval/write/Undo, converter·graph sync, Supabase/Railway runtime 결정
