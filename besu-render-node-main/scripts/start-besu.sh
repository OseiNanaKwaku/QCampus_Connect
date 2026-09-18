#!/bin/bash
# start-besu.sh

echo "=============================================="
echo " QCampus Connect — Besu Self-Initializing Node "
echo "=============================================="

# 💡 THE CEILING FIX: Pin heap to 128MB and hard ceiling to 256MB.
# This prevents Besu from ballooning and crashing Render's 512MB RAM ceiling!
export JAVA_OPTS="-Xms128m -Xmx256m -Dvertx.disablecontextdata=true -Dvertx.threadChecks=false"

echo "Starting Hyperledger Besu..."
echo "Java options: $JAVA_OPTS"

# Launch Besu with completely disabled block, worldstate, and header caches
/opt/besu/bin/besu $JAVA_OPTS \
  --rpc-http-enabled \
  --rpc-http-api=ETH,NET,WEB3 \
  --rpc-http-cors-origins="*" \
  --rpc-http-host=127.0.0.1 \
  --rpc-http-port=10000 \
  --host-allowlist="*" \
  --min-gas-price=0 \
  --cache-last-blocks=0 \
  --cache-last-block-headers=0 \
  --tx-pool-max-size=500 \
  --Xsnapsync-bft-enabled=true \
  --data-path=/tmp/besu-data &

Besu_PID=$!
echo "Besu PID: $Besu_PID"

echo "Waiting for Besu JSON-RPC..."
until curl -s -o /dev/null -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  http://127.0.0.1:10000; do
  sleep 1
done

echo "✅ Besu JSON-RPC is ready."
echo "Checking MessageVerifier..."

# Execute your built-in custom contract initializer script
node /opt/qcampus/deploy-if-missing.js

echo "=============================================="
echo " Besu node is ready "
echo "=============================================="

# Keep the shell container alive by foregrounding the backgrounded Besu process execution loop
wait $Besu_PID
