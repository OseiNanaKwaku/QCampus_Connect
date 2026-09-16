FROM docker.io/hyperledger/besu:24.12.2

USER root

# Install Node.js, npm, curl, and CA certificates.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        nodejs \
        npm \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/qcampus

# Copy the compiled MessageVerifier artifact.
COPY contract/artifacts/contracts/MessageVerifier.sol/MessageVerifier.json ./MessageVerifier.json

# Copy the Besu genesis configuration.
COPY besu-render-node-main/genesis.json /opt/besu/genesis.json

# Copy the self-initialization script.
COPY besu-render-node-main/scripts/deploy-if-missing.js ./deploy-if-missing.js

# Copy the Besu validator key.
# This must match the validator configured in genesis.json.
COPY besu-render-node-main/keys/validator.key /opt/besu/keys/validator.key

# Install only the runtime dependency needed by the initializer.
RUN npm init -y \
    && npm install --omit=dev ethers@6

# Copy the startup script.
COPY besu-render-node-main/scripts/start-besu.sh /opt/qcampus/start-besu.sh

RUN chmod +x /opt/qcampus/start-besu.sh

EXPOSE 10000

ENTRYPOINT ["/opt/qcampus/start-besu.sh"]
