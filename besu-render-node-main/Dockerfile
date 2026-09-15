FROM hyperledger/besu:24.12.2

COPY genesis.json /opt/besu/genesis.json
# Copy the validator key so this node's identity matches the genesis QBFT validator.
# Without this Besu generates a random key; the node won't be recognised as a
# validator, QBFT never reaches quorum, and blocks are never produced.
COPY keys/validator.key /opt/besu/keys/validator.key

EXPOSE 10000

ENTRYPOINT ["besu", \
  "--rpc-http-enabled", \
  "--rpc-http-api=ETH,NET,WEB3,QBFT", \
  "--rpc-http-cors-origins=*", \
  "--rpc-http-host=0.0.0.0", \
  "--rpc-http-port=10000", \
  "--host-allowlist=*", \
  "--min-gas-price=0", \
  "--genesis-file=/opt/besu/genesis.json", \
  "--data-path=/tmp/besu-data", \
  "--node-private-key-file=/opt/besu/keys/validator.key", \
  "--sync-min-peers=0"]
