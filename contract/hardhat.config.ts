import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

// Keep the Besu account private key outside the source code.
// Set BESU_DEV_PRIVATE_KEY in your local shell and in Render's environment.
const BESU_DEV_PRIVATE_KEY = process.env.BESU_DEV_PRIVATE_KEY || "";

if (!BESU_DEV_PRIVATE_KEY) {
  throw new Error(
    "BESU_DEV_PRIVATE_KEY is not set. Configure it in the environment.",
  );
}

const config: HardhatUserConfig = {
  solidity: "0.8.20",

  networks: {
    // Local two-node Besu setup
    besu: {
      url: "http://127.0.0.1:8545",
      chainId: 1337,
      gasPrice: 0,
      gas: 60000000,
      accounts: [BESU_DEV_PRIVATE_KEY],
    },

    // Render-hosted Besu node
    "besu-render": {
      url: "https://qcampus-blockchain-nodelast.onrender.com",
      chainId: 1337,
      gasPrice: 0,
      gas: 60000000,
      accounts: [BESU_DEV_PRIVATE_KEY],
    },

    // Hardhat's in-memory network
    hardhat: {
      gasPrice: 0,
      initialBaseFeePerGas: 0,
    },
  },
};

export default config;
