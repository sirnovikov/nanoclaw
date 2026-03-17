#!/usr/bin/env bash
set -euo pipefail

# Create the nanoclaw-proxy Docker bridge network.
# --internal: blocks all external routing at the kernel level (iptables).
#             Containers can only reach host.docker.internal (host gateway).
# Idempotent: safe to run multiple times.

NETWORK_NAME="nanoclaw-proxy"

if docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
  echo "nanoclaw-proxy network already exists"
  exit 0
fi

docker network create \
  --driver bridge \
  --internal \
  --opt com.docker.network.bridge.name=nanoclaw-proxy \
  "$NETWORK_NAME"

echo "nanoclaw-proxy network created"
