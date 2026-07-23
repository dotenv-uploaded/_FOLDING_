#!/usr/bin/env bash
set -euo pipefail

project_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
web_root="${project_root}/codegate-2026-web"
env_file="${web_root}/.env"

if [[ ! -f "${env_file}" ]]; then
  echo "codegate-2026-web/.env가 없습니다. 먼저 ./scripts/bootstrap.sh를 실행하세요." >&2
  exit 1
fi

if ! grep -Eq '^CODEGATE_ANTHROPIC_API_KEY=.+$' "${env_file}"; then
  echo "codegate-2026-web/.env에 CODEGATE_ANTHROPIC_API_KEY를 입력하세요." >&2
  exit 1
fi

if command -v corepack >/dev/null 2>&1; then
  pnpm_command=(corepack pnpm)
elif command -v pnpm >/dev/null 2>&1; then
  pnpm_command=(pnpm)
else
  echo "pnpm 또는 corepack을 찾지 못했습니다. 먼저 ./scripts/bootstrap.sh를 실행하세요." >&2
  exit 1
fi

cd "${web_root}"
export CODEGATE_AUTH_MODE=cloud
export CODEGATE_OAUTH_REDIRECT_URI=http://127.0.0.1:47821/auth/callback
export CODEGATE_CLAUDE_MODEL=sonnet
exec "${pnpm_command[@]}" dev:integrated
