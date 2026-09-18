#!/bin/bash
# start-besu.sh

echo "=============================================="
echo " QCampus Connect — Besu Self-Initializing Node "
echo "=============================================="

# 💡 MEMORY ALLOCATION: Hard cap the Java Virtual Machine heap to 256MB.
# This leaves 256MB of free breathing room on Render's 512MB free tier plan.
export BESU_MEM_OPTS="-Xms128m -Xmx256m"

echo "Starting Hyperledger Besu..."
echo "Java options: $BESU_MEM_OPTS"

exec /opt/besu/bin/besu $BESU_MEM_OPTS \
  --rpc-http-enabled \
  --rpc-http-cors-origins="*" \
  --rpc-http-host=0.0.0.0 \
  --rpc-http-port=10000 \
  --host-allowlist="*" \
  --min-gas-price=0 \
  --genesis-file=/opt/besu/genesis.json \
  --data-path=/tmp/besu-data
