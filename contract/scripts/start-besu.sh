#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="${BESU_CONTAINER_NAME:-besu-local}"
RPC_PORT="${BESU_RPC_PORT:-8545}"

if podman ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  echo "Stopping existing container: $CONTAINER_NAME"
  podman stop "$CONTAINER_NAME" >/dev/null
fi

if podman ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  podman rm "$CONTAINER_NAME" >/dev/null
fi

echo "Starting Besu dev node with mining enabled on port $RPC_PORT..."
podman run -d \
  --name "$CONTAINER_NAME" \
  -p "${RPC_PORT}:8545" \
  hyperledger/besu:latest \
  --network=dev \
  --rpc-http-enabled \
  --rpc-http-host=0.0.0.0 \
  --rpc-http-port=8545 \
  --rpc-http-cors-origins='*' \
  --host-allowlist='*' \
  --rpc-http-api=ETH,NET,WEB3

echo "Waiting for RPC..."
for _ in $(seq 1 30); do
  if curl -sf -X POST "http://127.0.0.1:${RPC_PORT}" \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' >/dev/null; then
    break
  fi
  sleep 1
done

MINING=$(curl -s -X POST "http://127.0.0.1:${RPC_PORT}" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_mining","params":[],"id":1}' | sed -n 's/.*"result":\([^,}]*\).*/\1/p')

echo "Besu RPC: http://127.0.0.1:${RPC_PORT}"
echo "Mining enabled: ${MINING:-unknown}"
