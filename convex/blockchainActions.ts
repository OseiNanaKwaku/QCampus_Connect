"use node";

declare const process: { env: Record<string, string | undefined> };

import { action } from "./_generated/server";
import { v } from "convex/values";
import { ethers } from "ethers";

// Default contract address from environment or deployed contract fallback
const CONTRACT_ADDRESS =
  process.env.CONTRACT_ADDRESS ||
  process.env.VITE_CONTRACT_ADDRESS ||
  "0xa50a51c09a5c451C52BB714527E1974b686D8e77";

// Human-Readable ABI matching the Besu Solidity contract
const CONTRACT_ABI = [
  "function recordHash(string memory messageId, bytes32 messageHash, address sender, address receiver) external",
  "function verifyHash(string memory messageId) external view returns (bytes32)",
  "function verifyUser(address userAddress, string memory role) external",
  "function getUserRole(address userAddress) external view returns (string memory)",
];

/**
 * Deterministically derives a 20-byte Ethereum address from a Convex ID.
 */
function getPseudoAddress(id: string): string {
  if (!id || id === "public" || id === "skip") {
    return ethers.ZeroAddress;
  }
  const hash = ethers.keccak256(ethers.toUtf8Bytes(id));
  return "0x" + hash.substring(26);
}

/**
 * Computes a SHA-256 hash in bytes32 format (0x prefixed hex).
 */
function computeSHA256Bytes32(payload: string): string {
  if (payload.startsWith("0x") && payload.length === 66) {
    return payload;
  }
  return ethers.sha256(ethers.toUtf8Bytes(payload));
}

/**
 * Creates an ethers JsonRpcProvider, Wallet signer, and Contract instance.
 * Runs on the Convex Node.js serverless runtime, bypassing all browser CORS restrictions.
 */
function getBlockchainConnection() {
  const rpcUrl =
    process.env.BESU_RPC_URL ||
    process.env.BLOCKCHAIN_RPC_URL ||
    process.env.VITE_BESU_RPC_URL ||
    "http://127.0.0.1:8545";

  const privateKey =
    process.env.SYSTEM_PRIVATE_KEY ||
    process.env.ADMIN_PRIVATE_KEY ||
    process.env.VITE_SYSTEM_PRIVATE_KEY ||
    "0x8f2a55949038a9610f50fb23b5883af3b4ecb3c3bb792cbcefbd1542c692be63";

  // Use staticNetwork: true to avoid continuous network detection retries if node is starting up
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
  const wallet = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);

  return { provider, wallet, contract };
}

/**
 * Approves a user's role on the Hyperledger Besu private network.
 */
export const approveUser = action({
  args: {
    userId: v.string(),
    role: v.optional(v.string()),
    name: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    try {
      const { contract } = getBlockchainConnection();
      const userAddress = getPseudoAddress(args.userId);
      const userRole = args.role || "student";

      console.log(`[Blockchain Action] Approving user on Besu: ${args.userId} (${userAddress}, role: ${userRole})`);

      const tx = await contract.verifyUser(userAddress, userRole, {
        gasPrice: 0n,
      });

      const receipt = await tx.wait();
      const txHash = receipt?.hash || tx.hash;
      console.log(`[Blockchain Action] User successfully verified on Besu. Tx: ${txHash}`);
      return { success: true, txHash };
    } catch (error: any) {
      console.error("[Blockchain Action] Failed to approve user on Besu:", error?.message || error);
      return {
        success: false,
        error: error?.message || "Failed to communicate with Besu blockchain node",
      };
    }
  },
});

/**
 * Records a message hash onto the Hyperledger Besu private network.
 */
export const recordMessage = action({
  args: {
    messageId: v.string(),
    content: v.string(),
    senderId: v.optional(v.string()),
    receiverId: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    try {
      const { contract } = getBlockchainConnection();
      const contentHash = computeSHA256Bytes32(args.content);
      const senderAddr = getPseudoAddress(args.senderId || "admin");
      const receiverAddr = getPseudoAddress(args.receiverId || "public");

      console.log(`[Blockchain Action] Recording message hash on Besu: ${args.messageId} -> ${contentHash}`);

      const tx = await contract.recordHash(args.messageId, contentHash, senderAddr, receiverAddr, {
        gasPrice: 0n,
      });

      const receipt = await tx.wait();
      const txHash = receipt?.hash || tx.hash;
      console.log(`[Blockchain Action] Message hash recorded on Besu. Tx: ${txHash}`);
      return { success: true, txHash };
    } catch (error: any) {
      console.error("[Blockchain Action] Failed to record message hash on Besu:", error?.message || error);
      return {
        success: false,
        error: error?.message || "Failed to communicate with Besu blockchain node",
      };
    }
  },
});

/**
 * Universal relay action handling either APPROVE_USER or RECORD_MESSAGE.
 */
export const relayHash = action({
  args: {
    actionType: v.union(v.literal("APPROVE_USER"), v.literal("RECORD_MESSAGE")),
    identifier: v.string(),
    rawTextPayload: v.optional(v.string()),
    senderId: v.optional(v.string()),
    receiverId: v.optional(v.string()),
    role: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    try {
      const { contract } = getBlockchainConnection();

      if (args.actionType === "APPROVE_USER") {
        const userAddress = getPseudoAddress(args.identifier);
        const role = args.role || "student";
        const tx = await contract.verifyUser(userAddress, role, { gasPrice: 0n });
        const receipt = await tx.wait();
        const txHash = receipt?.hash || tx.hash;
        return { success: true, txHash };
      } else if (args.actionType === "RECORD_MESSAGE") {
        const contentHash = computeSHA256Bytes32(args.rawTextPayload || "");
        const senderAddr = getPseudoAddress(args.senderId || "admin");
        const receiverAddr = getPseudoAddress(args.receiverId || "public");
        const tx = await contract.recordHash(args.identifier, contentHash, senderAddr, receiverAddr, { gasPrice: 0n });
        const receipt = await tx.wait();
        const txHash = receipt?.hash || tx.hash;
        return { success: true, txHash };
      }

      return { success: false, error: `Unsupported action type: ${args.actionType}` };
    } catch (error: any) {
      console.error("[Blockchain Action] Relay error on Besu:", error?.message || error);
      return {
        success: false,
        error: error?.message || "Failed to relay to Besu",
      };
    }
  },
});
