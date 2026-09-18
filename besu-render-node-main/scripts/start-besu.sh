#!/bin/bash
# start-besu.sh

echo "=============================================="
echo " QCampus Connect — Besu Self-Initializing Node "
echo "=============================================="

# Limit JVM memory usage and disable Vert.x background thread checks to prevent Render thread starvation
export JAVA_OPTS="-Xms128m -Xmx256m -Dvertx.disablecontextdata=true -Dvertx.threadChecks=false"

echo "Starting Hyperledger Besu..."
echo "Java constraints enforced: $JAVA_OPTS"

# 💡 THE FIX: We append --Xsnapsync-bft-enabled=true to bypass the 5-peer threshold lock.
# This forces the single validator node to skip full-sync and mine blocks instantly!
exec /opt/besu/bin/besu \
  --rpc-http-enabled \
  --rpc-http-api=ETH,NET,WEB3 \
  --rpc-http-cors-origins="*" \
  --rpc-http-host=0.0.0.0 \
  --rpc-http-port=10000 \
  --host-allowlist="*" \
  --min-gas-price=0 \
  --genesis-file=/opt/besu/genesis.json \
  --data-path=/tmp/besu-data \
  --Xsnapsync-bft-enabled=true
