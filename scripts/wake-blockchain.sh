#!/usr/bin/env bash

set -u

RPC_URL="https://qcampus-blockchain-nodelast.onrender.com"
CONTRACT_ADDRESS="0x42699A7612A82f1d9C36148af9C77354759b210b"

echo "=============================================="
echo " QCampus Connect — Besu Wake-Up"
echo "=============================================="
echo
echo "Checking Render Besu node..."
echo

RPC_RESPONSE=$(curl -s --max-time 30 \
  -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  "$RPC_URL")

if [ $? -ne 0 ] || [ -z "$RPC_RESPONSE" ]; then
  echo "❌ Could not reach the Render Besu node."
  echo "   Wake the Render service and try again."
  exit 1
fi

BLOCK_HEX=$(echo "$RPC_RESPONSE" | sed -n 's/.*"result":"\([^"]*\)".*/\1/p')

if [ -z "$BLOCK_HEX" ]; then
  echo "❌ Besu returned an unexpected response:"
  echo "$RPC_RESPONSE"
  exit 1
fi

BLOCK_DEC=$((16#${BLOCK_HEX#0x}))

echo "Current block: $BLOCK_DEC"
echo "Chain ID: 1337"
echo

echo "Checking MessageVerifier contract..."
echo

CODE_RESPONSE=$(curl -s --max-time 30 \
  -H "Content-Type: application/json" \
  --data "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getCode\",\"params\":[\"$CONTRACT_ADDRESS\",\"latest\"],\"id\":1}" \
  "$RPC_URL")

CODE=$(echo "$CODE_RESPONSE" | sed -n 's/.*"result":"\([^"]*\)".*/\1/p')

if [ -z "$CODE" ]; then
  echo "❌ Could not read contract code."
  echo "$CODE_RESPONSE"
  exit 1
fi

if [ "$CODE" = "0x" ]; then
  echo "⚠️  MessageVerifier is NOT deployed."
  echo
  echo "Deploying MessageVerifier..."
  echo

  (
    cd contract || exit 1
    npx hardhat run scripts/deploy.ts --network besu-render
  )

  if [ $? -ne 0 ]; then
    echo
    echo "❌ Contract deployment failed."
    exit 1
  fi

  echo
  echo "Verifying contract deployment..."
  echo

  CODE_RESPONSE=$(curl -s --max-time 30 \
    -H "Content-Type: application/json" \
    --data "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getCode\",\"params\":[\"$CONTRACT_ADDRESS\",\"latest\"],\"id\":1}" \
    "$RPC_URL")

  CODE=$(echo "$CODE_RESPONSE" | sed -n 's/.*"result":"\([^"]*\)".*/\1/p')
fi

if [ "$CODE" = "0x" ] || [ -z "$CODE" ]; then
  echo "❌ MessageVerifier is still unavailable."
  exit 1
fi

echo "✅ Besu is awake."
echo "✅ MessageVerifier contract is deployed."
echo
echo "Contract:"
echo "$CONTRACT_ADDRESS"
echo
echo "Current block:"
echo "$BLOCK_DEC"
echo
echo "=============================================="
echo " Blockchain is ready for QCampus Connect"
echo "=============================================="
