/**
 * deploy-if-missing.js
 *
 * Self-initialization script for QCampus Connect Hyperledger Besu node.
 *
 * Behaviour:
 *   1. Waits for JSON-RPC to be available (handled by start-besu.sh before invocation).
 *   2. Checks whether MessageVerifier is already deployed at CONTRACT_ADDRESS (if set).
 *   3. If not deployed, deploys it and accepts the actual EVM-assigned address.
 *   4. Validates that bytecode exists at the confirmed address.
 *   5. Writes the confirmed address to /opt/qcampus/contract_address.txt for downstream use.
 *
 * Why we do NOT assert a specific expected address:
 *   The Render deployment stores chain data in /tmp (ephemeral — wiped on every restart).
 *   Every restart boots a fresh genesis chain. The deployed contract address is deterministic
 *   (keccak256(rlp(deployerAddress, nonce))[12:]) but the "expected" value baked into an
 *   old build came from a different chain instance and will never match a fresh one.
 *   We validate interface correctness (bytecode presence) rather than a specific 20-byte address.
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const { ethers } = require("ethers");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const RPC_URL =
  process.env.BESU_LOCAL_RPC_URL || "http://127.0.0.1:10000";

/**
 * Optional: if CONTRACT_ADDRESS is set in the environment, the script first
 * checks whether the contract is already deployed there and skips deployment
 * if so.  This supports the persistent-chain case.
 * On a fresh ephemeral chain this variable will usually be absent or stale,
 * so the script falls through to deployment.
 */
const KNOWN_ADDRESS = process.env.CONTRACT_ADDRESS || "";

const PRIVATE_KEY =
  process.env.BESU_DEV_PRIVATE_KEY ||
  process.env.SYSTEM_PRIVATE_KEY;

const ARTIFACT_PATH = "/opt/qcampus/MessageVerifier.json";
const ADDRESS_OUTPUT_PATH = "/opt/qcampus/contract_address.txt";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write the confirmed contract address to a file that start-besu.sh can source. */
function persistAddress(address) {
  try {
    fs.writeFileSync(ADDRESS_OUTPUT_PATH, address, "utf8");
    console.log("Contract address persisted to:", ADDRESS_OUTPUT_PATH);
  } catch (err) {
    // Non-fatal — log but continue. start-besu.sh will still work.
    console.warn("Warning: could not write address file:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!PRIVATE_KEY) {
    console.error(
      "Neither BESU_DEV_PRIVATE_KEY nor SYSTEM_PRIVATE_KEY is configured."
    );
    process.exit(1);
  }

  console.log("RPC:", RPC_URL);

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

  // ------------------------------------------------------------------
  // 1. Check whether a contract is already deployed at a known address.
  //    This handles the persistent-chain / same-session restart case.
  // ------------------------------------------------------------------
  if (KNOWN_ADDRESS) {
    console.log("Checking known address:", KNOWN_ADDRESS);
    const code = await provider.getCode(KNOWN_ADDRESS, "latest");
    if (code !== "0x") {
      console.log("MessageVerifier already deployed at known address.");
      console.log("Address  :", KNOWN_ADDRESS);
      console.log("Code size:", (code.length - 2) / 2, "bytes");
      persistAddress(KNOWN_ADDRESS);
      return;
    }
    console.log(
      "No contract at known address",
      KNOWN_ADDRESS,
      "— proceeding with deployment."
    );
  } else {
    console.log(
      "CONTRACT_ADDRESS not set — will deploy and use the EVM-assigned address."
    );
  }

  // ------------------------------------------------------------------
  // 2. Deploy MessageVerifier.
  // ------------------------------------------------------------------
  if (!fs.existsSync(ARTIFACT_PATH)) {
    throw new Error(
      `Artifact not found at ${ARTIFACT_PATH}. ` +
      "Ensure the Dockerfile COPY step includes MessageVerifier.json."
    );
  }

  const artifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, "utf8"));

  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log("Deployer:", wallet.address);

  const balance = await provider.getBalance(wallet.address);
  console.log("Balance:", ethers.formatEther(balance), "ETH");

  if (balance === 0n) {
    throw new Error(
      `Deployer ${wallet.address} has zero balance. ` +
      "Ensure the genesis alloc includes this address."
    );
  }

  const factory = new ethers.ContractFactory(
    artifact.abi,
    artifact.bytecode,
    wallet
  );

  console.log("MessageVerifier is not deployed.");
  console.log("Deploying automatically...");
  console.log("Sending deployment transaction...");

  const contract = await factory.deploy({
    gasLimit: 5_000_000n,
    gasPrice: 0n,
  });

  const deploymentTx = contract.deploymentTransaction();
  if (deploymentTx) {
    console.log("Deployment transaction:", deploymentTx.hash);
  }

  console.log("Waiting for confirmation...");
  await contract.waitForDeployment();

  // ------------------------------------------------------------------
  // 3. Accept the actual EVM-assigned address — do NOT assert a
  //    specific expected address.  Address is deterministic from
  //    (deployerAddress, nonce) so it will be stable per deployer key,
  //    but may differ from addresses minted on a previous chain instance.
  // ------------------------------------------------------------------
  const deployedAddress = await contract.getAddress();
  console.log("Deployed address:", deployedAddress);

  // ------------------------------------------------------------------
  // 4. Validate that bytecode is actually present (real validation).
  // ------------------------------------------------------------------
  const deployedCode = await provider.getCode(deployedAddress, "latest");
  if (deployedCode === "0x") {
    throw new Error(
      "Deployment transaction confirmed but contract bytecode is missing at " +
      deployedAddress +
      ". This is unexpected — check Besu logs."
    );
  }

  console.log(
    "Bytecode verified:",
    (deployedCode.length - 2) / 2,
    "bytes at",
    deployedAddress
  );
  console.log("MessageVerifier deployed and verified.");

  // ------------------------------------------------------------------
  // 5. Persist the confirmed address for start-besu.sh and downstream.
  // ------------------------------------------------------------------
  persistAddress(deployedAddress);
}

main().catch((error) => {
  console.error("Self-initialization error:");
  console.error(error);
  process.exit(1);
});
