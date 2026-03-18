#!/usr/bin/env bash
set -euo pipefail

# Create the nanoclaw-proxy Docker bridge network.
# Used to isolate permission-approval containers from each other while
# allowing them to reach the host credential proxy via host.docker.internal.
# Note: --internal is NOT used because it blocks host routing on macOS
# Docker Desktop, preventing containers from reaching the proxy.
# Idempotent: safe to run multiple times.

NETWORK_NAME="nanoclaw-proxy"

if docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
  echo "nanoclaw-proxy network already exists"
  exit 0
fi

docker network create \
  --driver bridge \
  --opt com.docker.network.bridge.name=nanoclaw-proxy \
  "$NETWORK_NAME"

echo "nanoclaw-proxy network created"
