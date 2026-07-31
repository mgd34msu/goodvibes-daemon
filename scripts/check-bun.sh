#!/bin/sh
set -eu

if ! command -v bun >/dev/null 2>&1; then
  cat >&2 <<'EOF'
goodvibes-daemon requires Bun.

Install Bun first, then install the daemon from the npm registry with:

  bun add -g goodvibes-daemon

npm install -g goodvibes-daemon also works, but Bun must already be installed and available on PATH.
EOF
  exit 1
fi

if ! bun --version >/dev/null 2>&1; then
  echo "goodvibes-daemon requires a working Bun executable on PATH." >&2
  exit 1
fi
