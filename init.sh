#!/usr/bin/env bash
set -euo pipefail

echo "=========================================================="
echo " Agora Canonical Initialization & Baseline Verification"
echo "=========================================================="

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

# 1. Environment Prerequisite Checks
echo "--> [1/6] Checking runtime prerequisites..."
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required but not installed." >&2
  exit 1
fi

NODE_MAJOR="$(node -v | cut -d'.' -f1 | tr -d 'v')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Error: Node.js version 20+ is required. Found $(node -v)." >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "Error: pnpm is required but not installed." >&2
  exit 1
fi
echo "    Node: $(node -v) | pnpm: $(pnpm -v)"

# 2. Dependency Resolution (Non-destructive)
echo "--> [2/6] Verifying workspace dependencies..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

# 3. Mechanical Harness Verification (Practices 2, 4, 7, 8, 10)
echo "--> [3/6] Running mechanical harness checks..."
node harness/validate-harness.mjs
node harness/verify-architecture.mjs

# 4. Strict Typecheck
echo "--> [4/6] Running TypeScript typecheck..."
pnpm run typecheck

# 5. Automated Test Suite
echo "--> [5/6] Running automated test suite..."
pnpm test

# 6. Optional Application Start Mode
if [ "${RUN_START_COMMAND:-0}" = "1" ]; then
  echo "--> [6/6] Starting development services (RUN_START_COMMAND=1)..."
  exec pnpm run dev
else
  echo "--> [6/6] Baseline verification completed successfully!"
fi

echo "=========================================================="
echo " Agora Verification: PASSING"
echo "=========================================================="
