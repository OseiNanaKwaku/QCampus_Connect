import { ethers } from "hardhat";

// Use Hardhat's selected network provider.
// This means:
//   --network besu        -> local Besu
//   --network besu-render -> Render Besu
async function assertBesuReady(
  provider: any,
  deployer: any,
): Promise<void> {
  const [chainId, balance, blockNumber, mining] = await Promise.all([
    provider.getNetwork().then((n: any) => Number(n.chainId)),
    provider.getBalance(deployer.address),
    provider.getBlockNumber(),
    provider.send("eth_mining", []),
  ]);

  console.log("Pre-flight check:");
  console.log("  Chain ID:", chainId);
  console.log("  Block:", blockNumber);
  console.log("  Mining:", mining);
  console.log("  Deployer:", deployer.address);
  console.log(
    "  Balance:",
    ethers.formatEther(balance),
    "ETH",
  );

  if (chainId !== 1337) {
    throw new Error(`Expected Besu chain ID 1337, got ${chainId}.`);
  }

  if (balance === 0n) {
    throw new Error(
      `Deployer ${deployer.address} has zero balance.`,
    );
  }

  if (blockNumber === 0 && !mining) {
    throw new Error(
      "Besu is not mining. Check the Besu node before deploying.",
    );
  }
}

async function main(): Promise<void> {
  // IMPORTANT:
  // ethers.provider comes from the Hardhat network selected with
  // --network besu-render. Do NOT create a localhost JsonRpcProvider here.
  const provider = ethers.provider;
  const [deployer] = await ethers.getSigners();

  await assertBesuReady(provider, deployer);

  console.log("\nDeploying MessageVerifier...");
  console.log("Network: Besu / chain 1337");
  console.log("Deployer:", deployer.address);

  const MessageVerifier = await ethers.getContractFactory(
    "MessageVerifier",
    deployer,
  );

  console.log("Sending deployment transaction to Hyperledger Besu...");

  const messageVerifier = await MessageVerifier.deploy({
    gasLimit: 5000000,
    gasPrice: 0,
  });

  console.log("Transaction submitted:", messageVerifier.deploymentTransaction()?.hash);
  console.log("Waiting for deployment confirmation...");

  await messageVerifier.waitForDeployment();

  const address = await messageVerifier.getAddress();

  console.log("\n==================================================");
  console.log("🚀 SUCCESS: MessageVerifier deployed to Besu!");
  console.log(`CONTRACT_ADDRESS=${address}`);
  console.log("==================================================\n");
}

main().catch((error: unknown) => {
  console.error("\n❌ Deployment failed:");
  console.error(error);
  process.exitCode = 1;
});
