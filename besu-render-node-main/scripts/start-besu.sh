#!/usr/bin/env bash

set -u

RPC_PORT="${BESU_RPC_PORT:-10000}"
RPC_URL="http://127.0.0.1:${RPC_PORT}"

echo "=============================================="
echo " QCampus Connect — Besu Self-Initializing Node"
echo "=============================================="
echo

# Keep the Java heap below Render's 512 MB container limit.
# This leaves memory available for Besu's native JVM memory,
# Node.js, and the container itself.
export JAVA_OPTS="${JAVA_OPTS:-} -Xms128m -Xmx256m"

echo "Starting Hyperledger Besu..."
echo "Java options: ${JAVA_OPTS}"

besu \
  --rpc-http-enabled \
  --rpc-http-api=ETH,NET,WEB3,QBFT \
  --rpc-http-cors-origins="*" \
  --rpc-http-host=0.0.0.0 \
  --rpc-http-port="${RPC_PORT}" \
  --host-allowlist="*" \
  --min-gas-price=0 \
  --genesis-file=/opt/besu/genesis.json \
  --data-path=/tmp/besu-data \
  --node-private-key-file=/opt/besu/keys/validator.key \
  --sync-min-peers=0 \
  > /tmp/besu.log 2>&1 &

BESU_PID=$!

cleanup() {
  echo
  echo "Stopping Besu..."
  kill "$BESU_PID" 2>/dev/null || true
  wait "$BESU_PID" 2>/dev/null || true
}

trap cleanup SIGTERM SIGINT

echo "Besu PID: ${BESU_PID}"
echo
echo "Waiting for Besu JSON-RPC..."

READY=0

for i in $(seq 1 60); do
  if curl -s --max-time 2 \
      -H "Content-Type: application/json" \
      --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
      "${RPC_URL}" >/dev/null 2>&1; then
    READY=1
    break
  fi

  sleep 2
done

if [ "$READY" -ne 1 ]; then
  echo "❌ Besu did not become ready."
  echo
  echo "Besu log:"
  cat /tmp/besu.log
  exit 1
fi

echo "✅ Besu JSON-RPC is ready."
echo

export BESU_LOCAL_RPC_URL="${RPC_URL}"

echo "Checking MessageVerifier..."
node /opt/qcampus/deploy-if-missing.js

INIT_STATUS=$?

if [ "$INIT_STATUS" -ne 0 ]; then
  echo
  echo "❌ Contract initialization failed."
  echo
  echo "Besu log:"
  tail -100 /tmp/besu.log
  exit "$INIT_STATUS"
fi

echo
echo "=============================================="
echo " Besu node is ready"
echo "=============================================="
echo

# Keep the container alive while Besu runs.
wait "$BESU_PID"
