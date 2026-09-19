#!/bin/bash
set -e

echo "=============================================="
echo " QCampus Connect — Besu Render Node "
echo "=============================================="

export JAVA_OPTS="-Xms128m -Xmx256m -Dvertx.disablecontextdata=true -Dvertx.threadChecks=false"

echo "Starting Hyperledger Besu..."

# NOTE: /tmp is ephemeral on Render — chain state is intentionally reset on every restart.
# MessageVerifier is always re-deployed during startup by deploy-if-missing.js.
rm -rf /tmp/besu-data
mkdir -p /tmp/besu-data

/opt/besu/bin/besu \
  --genesis-file=/opt/besu/genesis.json \
  --data-path=/tmp/besu-data \
  --node-private-key-file=/opt/besu/keys/validator.key \
  --discovery-enabled=false \
  --p2p-host=0.0.0.0 \
  --p2p-port=30303 \
  --sync-mode=FULL \
  --sync-min-peers=0 \
  --min-gas-price=0 \
  --rpc-http-enabled=true \
  --rpc-http-api=ETH,NET,WEB3,QBFT \
  --rpc-http-cors-origins="*" \
  --rpc-http-host=0.0.0.0 \
  --rpc-http-port=10000 \
  --host-allowlist="*" &

BESU_PID=$!

echo "Besu PID: $BESU_PID"
echo "Waiting for Besu JSON-RPC..."

READY=0

for i in $(seq 1 60); do
  if curl -sf \
    -H "Content-Type: application/json" \
    --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
    http://127.0.0.1:10000 >/dev/null; then
    READY=1
    echo "Besu JSON-RPC is ready."
    break
  fi

  if ! kill -0 "$BESU_PID" 2>/dev/null; then
    echo "ERROR: Besu exited before JSON-RPC became ready."
    exit 1
  fi

  sleep 2
done

if [ "$READY" -ne 1 ]; then
  echo "ERROR: Besu JSON-RPC did not become ready."
  kill "$BESU_PID" 2>/dev/null || true
  exit 1
fi

echo "Waiting for QBFT block production..."

BLOCK_READY=0

for i in $(seq 1 30); do
  CURRENT_BLOCK=$(curl -sf \
    -H "Content-Type: application/json" \
    --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    http://127.0.0.1:10000 \
    | sed -n 's/.*"result":"\([^"]*\)".*/\1/p')

  echo "Current block: ${CURRENT_BLOCK:-unknown}"

  if [ -n "$CURRENT_BLOCK" ] && [ "$CURRENT_BLOCK" != "0x0" ]; then
    BLOCK_READY=1
    echo "QBFT block production confirmed."
    break
  fi

  if ! kill -0 "$BESU_PID" 2>/dev/null; then
    echo "ERROR: Besu exited while waiting for block production."
    exit 1
  fi

  sleep 2
done

if [ "$BLOCK_READY" -ne 1 ]; then
  echo "ERROR: QBFT did not produce a block within the expected startup window."
  kill "$BESU_PID" 2>/dev/null || true
  exit 1
fi

echo "Running MessageVerifier self-initialization..."

node /opt/qcampus/deploy-if-missing.js

# Read and export the confirmed contract address written by deploy-if-missing.js.
ADDRESS_FILE="/opt/qcampus/contract_address.txt"
if [ -f "$ADDRESS_FILE" ]; then
  CONFIRMED_CONTRACT=$(cat "$ADDRESS_FILE")
  export CONTRACT_ADDRESS="$CONFIRMED_CONTRACT"
  echo "Confirmed MessageVerifier address: $CONFIRMED_CONTRACT"
else
  echo "WARNING: contract_address.txt not found — CONTRACT_ADDRESS not exported."
fi

echo "=============================================="
echo " Besu + MessageVerifier ready "
echo "=============================================="

wait "$BESU_PID"
