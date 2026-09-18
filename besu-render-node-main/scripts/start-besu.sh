#!/bin/bash
# start-besu.sh

echo "=============================================="
echo " QCampus Connect — Besu Self-Initializing Node "
echo "=============================================="

# 💡 THE FIX: Limit Vert.x/Netty core event threads to match Render's low-CPU container profile.
# This prevents the Vert.x EventLoop from throwing an IllegalStateException!
export JAVA_OPTS="-Xms128m -Xmx256m -Dvertx.disablecontextdata=true -Dvertx.threadChecks=false -Dvertx.logger-delegate-factory-class-name=io.vertx.core.logging.SLF4JLogDelegateFactory"

echo "Starting Hyperledger Besu..."
echo "Java constraints enforced: $JAVA_OPTS"

# Launch Besu cleanly with explicit BFT solo-sync parameters
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
