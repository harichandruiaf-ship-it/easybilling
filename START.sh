#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8080}"
if ! command -v python3 >/dev/null 2>&1; then
  echo "Install Python 3 or use: npx serve -p $PORT"
  exit 1
fi
echo "Easy Billing — http://127.0.0.1:$PORT/"
(sleep 1 && open "http://127.0.0.1:$PORT/" 2>/dev/null || true) &
exec python3 -m http.server "$PORT"
