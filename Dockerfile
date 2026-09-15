FROM hyperledger/besu:latest

# Copy the genesis file into the image. This defines your QBFT validator,
# the zero-gas chain rules, and the pre-funded account.
COPY genesis.json /opt/besu/genesis.json

# Render routes external traffic to whatever port you expose here.
# Besu's RPC server below is bound to this same port.
EXPOSE 10000

# Start Besu as a single-validator QBFT network:
# --rpc-http-enabled            turns on the JSON-RPC HTTP API
# --rpc-http-cors-origins=*     allows browser-based clients to call the RPC
# --rpc-http-host=0.0.0.0       listens on all interfaces, required for Render
# --rpc-http-port=10000         matches the exposed port above
# --host-allowlist=*            accepts RPC requests from any host header
# --min-gas-price=0             enforces zero-gas transactions
# --genesis-file=...            loads the QBFT genesis config copied in above
# --data-path=/tmp/besu-data    stores chain data in a writable, ephemeral path
ENTRYPOINT ["besu", "--rpc-http-enabled", "--rpc-http-cors-origins=*", "--rpc-http-host=0.0.0.0", "--rpc-http-port=10000", "--host-allowlist=*", "--min-gas-price=0", "--genesis-file=/opt/besu/genesis.json", "--data-path=/tmp/besu-data"]
