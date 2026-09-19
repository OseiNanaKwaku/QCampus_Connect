const fs = require("fs");
const { ethers } = require("ethers");

const RPC_URL =
  process.env.BESU_LOCAL_RPC_URL || "http://127.0.0.1:10000";

const CONTRACT_ADDRESS =
  process.env.CONTRACT_ADDRESS ||
  "0x42699A7612A82f1d9C36148af9C77354759b210b";

const PRIVATE_KEY =
  process.env.BESU_DEV_PRIVATE_KEY ||
  process.env.SYSTEM_PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error(
    "Neither BESU_DEV_PRIVATE_KEY nor SYSTEM_PRIVATE_KEY is configured."
  );
  process.exit(1);
}

async function main() {
  console.log("RPC:", RPC_URL);
  console.log("Expected contract:", CONTRACT_ADDRESS);

  const provider = new ethers.JsonRpcProvider(
    RPC_URL,
    1337,
    { staticNetwork: true }
  );

  const network = await provider.getNetwork();

  console.log("Chain ID:", network.chainId.toString());

  if (network.chainId !== 1337n) {
    throw new Error(
      `Expected chain ID 1337, got ${network.chainId.toString()}`
    );
  }

  const code = await provider.getCode(
    CONTRACT_ADDRESS,
    "latest"
  );

  if (code !== "0x") {
    console.log("MessageVerifier already exists.");
    console.log("Address:", CONTRACT_ADDRESS);
    console.log("Code size:", code.length, "hex chars");
    return;
  }

  console.log("MessageVerifier is not deployed.");
  console.log("Deploying automatically...");

  const artifact = JSON.parse(
    fs.readFileSync(
      "/opt/qcampus/MessageVerifier.json",
      "utf8"
    )
  );

  const wallet = new ethers.Wallet(
    PRIVATE_KEY,
    provider
  );

  console.log("Deployer:", wallet.address);

  const balance = await provider.getBalance(wallet.address);

  console.log(
    "Balance:",
    ethers.formatEther(balance),
    "ETH"
  );

  if (balance === 0n) {
    throw new Error(
      `Deployer ${wallet.address} has zero balance.`
    );
  }

  const factory = new ethers.ContractFactory(
    artifact.abi,
    artifact.bytecode,
    wallet
  );

  console.log("Sending deployment transaction...");

  const contract = await factory.deploy({
    gasLimit: 5000000n,
    gasPrice: 0n,
  });

  const deploymentTx = contract.deploymentTransaction();

  if (deploymentTx) {
    console.log(
      "Deployment transaction:",
      deploymentTx.hash
    );
  }

  console.log("Waiting for confirmation...");

  await contract.waitForDeployment();

  const deployedAddress = await contract.getAddress();

  console.log("Deployed address:", deployedAddress);

  if (
    deployedAddress.toLowerCase() !==
    CONTRACT_ADDRESS.toLowerCase()
  ) {
    throw new Error(
      `Unexpected contract address. Expected ${CONTRACT_ADDRESS}, got ${deployedAddress}`
    );
  }

  const deployedCode = await provider.getCode(
    CONTRACT_ADDRESS,
    "latest"
  );

  if (deployedCode === "0x") {
    throw new Error(
      "Deployment transaction confirmed but contract code is missing."
    );
  }

  console.log("MessageVerifier deployed and verified.");
}

main().catch((error) => {
  console.error("Self-initialization error:");
  console.error(error);
  process.exit(1);
});
