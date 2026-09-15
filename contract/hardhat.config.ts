import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

// Besu dev.json "Test Account 1" — same key as the genesis validator.
// See https://docs.besu-eth.org/private-networks/reference/accounts-for-testing
const BESU_DEV_PRIVATE_KEY =
  "0x8f2a55949038a9610f50fb23b5883af3b4ecb3c3bb792cbcefbd1542c692be63";

const config: HardhatUserConfig = {
  solidity: "0.8.20",
  networks: {
    // Local two-node Docker Compose setup (besu-render-node-main/docker-compose.yml)
    besu: {
      url: "http://127.0.0.1:8545",
      chainId: 1337,
      gasPrice: 0,
      gas: 60000000,
      accounts: [BESU_DEV_PRIVATE_KEY],
    },
    // Render-hosted single-validator Besu node
    // Deploy with: npx hardhat run scripts/deploy.ts --network besu-render
    "besu-render": {
      url: "https://qcampus-blockchain-setup.onrender.com",
      chainId: 1337,
      gasPrice: 0,
      gas: 60000000,
      accounts: [BESU_DEV_PRIVATE_KEY],
    },
    hardhat: {
      gasPrice: 0,
      initialBaseFeePerGas: 0,
    },
  },
};

export default config;

