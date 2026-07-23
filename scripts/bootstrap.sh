#!/usr/bin/env bash
set -euo pipefail

project_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
web_root="${project_root}/codegate-2026-web"
backend_root="${project_root}/Backend"
doc2md_root="${project_root}/codegate-2026-api/services/doc2md"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "필수 도구를 찾지 못했습니다: $1" >&2
    exit 1
  fi
}

require_command node
require_command uv

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 18 )); then
  echo "Node.js 18 이상이 필요합니다. 현재 버전: $(node --version)" >&2
  exit 1
fi

if command -v corepack >/dev/null 2>&1; then
  pnpm_command=(corepack pnpm)
elif command -v pnpm >/dev/null 2>&1; then
  pnpm_command=(pnpm)
else
  echo "pnpm 또는 corepack을 찾지 못했습니다." >&2
  exit 1
fi

echo "Electron 의존성을 lockfile 그대로 설치합니다."
(
  cd "${web_root}"
  "${pnpm_command[@]}" install --frozen-lockfile
)

echo "로컬 문서 에이전트를 Python 3.12 환경에 설치합니다."
uv sync --project "${backend_root}" --python 3.12 --frozen --all-groups

echo "문서 변환기를 Python 3.12 환경에 설치합니다."
uv sync --project "${doc2md_root}" --python 3.12 --frozen

if [[ ! -f "${web_root}/.env" ]]; then
  cp "${web_root}/.env.example" "${web_root}/.env"
  echo "codegate-2026-web/.env를 만들었습니다."
fi

echo
echo "설치가 끝났습니다."
echo "실행 전 codegate-2026-web/.env에 CODEGATE_ANTHROPIC_API_KEY를 안전하게 입력하세요."
echo "그 다음 저장소 루트에서 ./scripts/run-app.sh 를 실행하세요."
