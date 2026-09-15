FROM hyperledger/besu:24.12.2

COPY genesis.json /opt/besu/genesis.json

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
  "--sync-min-peers=0"]
