#!/usr/bin/env bash
set -euo pipefail

PULSE_REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "请先安装 Node.js >=22.13 和 pnpm，再运行本脚本。" >&2
  exit 1
fi
exec node "$PULSE_REPO_DIR/scripts/desktop/start-local.mjs" --restart "$@"
