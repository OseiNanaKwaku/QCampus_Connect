#!/bin/bash
# start-besu.sh

echo "=============================================="
echo " QCampus Connect — Besu Self-Initializing Node "
echo "=============================================="

# 💡 THE CORRECT JAVA METHOD: Pass the caps into JAVA_OPTS. 
# The Java runtime will read this environment variable automatically on launch!
export JAVA_OPTS="-Xms128m -Xmx256m"

echo "Starting Hyperledger Besu..."
echo "Java constraints enforced: $JAVA_OPTS"

# Cleanly launch the binary without passing raw Java options to the Besu CLI array
exec /opt/besu/bin/besu \
  --rpc-http-enabled \
  --rpc-http-api=ETH,NET,WEB3 \
  --rpc-http-cors-origins="*" \
  --rpc-http-host=0.0.0.0 \
  --rpc-http-port=10000 \
  --host-allowlist="*" \
  --min-gas-price=0 \
  --genesis-file=/opt/besu/genesis.json \
  --data-path=/tmp/besu-data
