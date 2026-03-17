#!/usr/bin/env bash
set -euo pipefail

echo "=== Step 1: TypeScript check on container agent-runner ==="
cd container
npx tsc --noEmit -p agent-runner/tsconfig.json
echo "✓ TypeScript passes"

echo "=== Step 2: Docker build ==="
docker build --no-cache . -t nanoclaw-agent-test
echo "✓ Docker build succeeded"

echo "=== Step 3: All done ==="
echo "Note: Full integration test (proxy + Anthropic API smoke test) requires a running"
echo "nanoclaw instance. Run 'npm run test' for unit/integration tests."
