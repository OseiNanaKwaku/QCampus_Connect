"use node";

declare const process: { env: Record<string, string | undefined> };

import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { ethers } from "ethers";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONTRACT_ADDRESS =
  process.env.CONTRACT_ADDRESS ||
  process.env.VITE_CONTRACT_ADDRESS ||
  "0xa50a51c09a5c451C52BB714527E1974b686D8e77";

// Human-Readable ABI matching the deployed MessageVerifier.sol
const CONTRACT_ABI = [
  "function recordHash(string memory messageId, bytes32 messageHash, address sender, address receiver) external returns (bool)",
  "function verifyHash(string memory messageId) external view returns (bytes32)",
  "function verifyUser(address userAddress, string memory role) external returns (bool)",
  "function getUserRole(address userAddress) external view returns (string memory)",
  "event MessageHashRecorded(string indexed messageId, bytes32 messageHash, address indexed sender, address indexed receiver, uint256 timestamp)",
  "event UserVerified(address indexed userAddress, string role, string indexOrStaffId)",
];

const EXPECTED_CHAIN_ID = 1337n;
const CHAIN_NETWORK_NAME = "hyperledger-besu-private";
const RPC_TIMEOUT_MS = 60_000; // 60 seconds (60,000ms) to swallow Render free-tier cold-start delays

// ---------------------------------------------------------------------------
// Gas Limit Handler Tree for Free-Gas Private Network
// ---------------------------------------------------------------------------

export type BlockchainActionType =
  | "APPROVE_USER"
  | "RECORD_MESSAGE"
  | "RELAY_HASH"
  | "RECORD_PROFILE_HASH";

export interface GasOverrides {
  gasLimit: bigint;
  gasPrice: bigint;
  type: number;
}

/**
 * Custom gas-limit handler tree that allocates deterministic gas parameters
 * and forces zero gas price, completely bypassing ethers standard auto-estimation
 * loops (estimateGas RPC calls) on our free-gas Hyperledger Besu private network.
 */
export function getBesuGasOverrides(
  actionType: BlockchainActionType,
  customLimit?: bigint | number
): GasOverrides {
  if (customLimit) {
    return {
      gasLimit: BigInt(customLimit),
      gasPrice: 0n,
      type: 0,
    };
  }

  // Hierarchical gas limit allocation based on EVM opcode consumption:
  // - APPROVE_USER: Updates userRoles mapping + emits UserVerified event (~65,000 gas, 400,000 ceiling)
  // - RECORD_MESSAGE: Stores MessageRecord struct + emits MessageHashRecorded event (~85,000 gas, 500,000 ceiling)
  // - RELAY_HASH: Universal dispatch routing (~500,000 ceiling)
  // - RECORD_PROFILE_HASH: Cryptographic identity anchoring (~500,000 ceiling)
  switch (actionType) {
    case "APPROVE_USER":
      return { gasLimit: 400_000n, gasPrice: 0n, type: 0 };
    case "RECORD_MESSAGE":
      return { gasLimit: 500_000n, gasPrice: 0n, type: 0 };
    case "RELAY_HASH":
      return { gasLimit: 500_000n, gasPrice: 0n, type: 0 };
    case "RECORD_PROFILE_HASH":
      return { gasLimit: 500_000n, gasPrice: 0n, type: 0 };
    default:
      return { gasLimit: 500_000n, gasPrice: 0n, type: 0 };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
 * Computes a SHA-256 hash in bytes32 format (0x-prefixed hex).
 */
function computeSHA256Bytes32(payload: string): string {
  if (payload.startsWith("0x") && payload.length === 66) {
    return payload;
  }
  return ethers.sha256(ethers.toUtf8Bytes(payload));
}

/**
 * Resolves the RPC URL from environment variables.
 */
function requireRpcUrl(): string {
  let url =
    process.env.BESU_RPC_URL ||
    process.env.BLOCKCHAIN_RPC_URL;

  if (!url) {
    throw new Error(
      "[Besu RPC] BESU_RPC_URL is not set in Convex environment variables. " +
      "Run: npx convex env set BESU_RPC_URL https://<your-besu-node>.onrender.com"
    );
  }

  if (url.startsWith("BESU_RPC_URL=")) {
    url = url.replace(/^BESU_RPC_URL=/, "");
  }

  return url.trim();
}

/**
 * Resolves the system private key from environment variables.
 */
function requirePrivateKey(): string {
  const key =
    process.env.SYSTEM_PRIVATE_KEY ||
    process.env.ADMIN_PRIVATE_KEY;

  if (!key) {
    throw new Error(
      "[Besu Wallet] SYSTEM_PRIVATE_KEY is not set in Convex environment variables. " +
      "Run: npx convex env set SYSTEM_PRIVATE_KEY <0x-prefixed-key>"
    );
  }

  return key;
}

/**
 * Initializes a resilient blockchain connection designed for cold-start environments:
 * 1. Explicit FetchRequest with a 60,000ms client-side timeout swallows Render sleep cycles safely.
 * 2. Static network profile eliminates redundant pre-flight network probing loops (eth_chainId)
 *    while the Besu container boots.
 */
async function getBlockchainConnection() {
  const rpcUrl = requireRpcUrl();
  const privateKey = requirePrivateKey();

  // 1. Explicit FetchRequest with 60,000ms client-side timeout
  const fetchRequest = new ethers.FetchRequest(rpcUrl);
  fetchRequest.timeout = RPC_TIMEOUT_MS;

  // 2. Static network profile matching our custom QBFT genesis settings (Chain ID 1337)
  const staticNetwork = new ethers.Network(CHAIN_NETWORK_NAME, EXPECTED_CHAIN_ID);
  const provider = new ethers.JsonRpcProvider(fetchRequest, staticNetwork, {
    staticNetwork,
  });

  // 3. Ethers wallet signer and contract instance
  const wallet = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);

  return {
    provider,
    wallet,
    contract,
    chainId: EXPECTED_CHAIN_ID,
  };
}

// ---------------------------------------------------------------------------
// 1. Diagnostic Action — Verifies Connectivity & Cold-Start Behavior
// ---------------------------------------------------------------------------

export const testBesuConnection = action({
  args: {},
  handler: async (_ctx, _args) => {
    const result: Record<string, any> = {
      success: false,
      stages: {},
    };

    let rpcUrl: string;
    try {
      rpcUrl = requireRpcUrl();
      result.stages.rpcUrl = { ok: true, host: rpcUrl.replace(/https?:\/\//, "").split("/")[0] };
    } catch (err: any) {
      result.stages.rpcUrl = { ok: false, error: err.message };
      return { ...result, error: err.message, stage: "rpc_url" };
    }

    try {
      const { provider, wallet, contract } = await getBlockchainConnection();

      // Stage B: Network check (statically resolved, verified with ping)
      const network = await provider.getNetwork();
      const chainId = network.chainId.toString();
      const chainIdOk = network.chainId === EXPECTED_CHAIN_ID;
      result.stages.network = { ok: chainIdOk, chainId, expected: EXPECTED_CHAIN_ID.toString() };

      // Stage C: Block Number check
      const blockNumber = await provider.getBlockNumber();
      result.stages.blockProduction = { ok: true, blockNumber: blockNumber.toString() };

      // Stage D: Contract existence
      const code = await provider.getCode(CONTRACT_ADDRESS);
      const hasCode = code !== "0x";
      result.stages.contract = { ok: hasCode, address: CONTRACT_ADDRESS, bytes: hasCode ? (code.length - 2) / 2 : 0 };

      // Stage E: Wallet loaded
      result.stages.wallet = { ok: true, address: wallet.address };

      result.success = chainIdOk && hasCode;
      return result;
    } catch (err: any) {
      console.error("[Besu Diagnostic] Connection failed:", err?.message || err);
      return {
        ...result,
        success: false,
        error: err?.message || String(err),
      };
    }
  },
});

// ---------------------------------------------------------------------------
// 2. User Verification Actions (approveUser & approveUserOnBlockchain)
// ---------------------------------------------------------------------------

/**
 * Public action: Invoked from frontend (Admin.tsx, Register.tsx) to record user role on Besu.
 * Uses 60s timeout provider and free-gas override tree to eliminate auto-estimation loops.
 */
export const approveUser = action({
  args: {
    userId: v.string(),
    role: v.optional(v.string()),
    name: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    try {
      const { contract, chainId } = await getBlockchainConnection();
      const userAddress = getPseudoAddress(args.userId);
      const userRole = args.role || "student";
      const txOverrides = getBesuGasOverrides("APPROVE_USER");

      console.log(`[Relay Engine] Anchoring approval record for: ${args.name || args.userId} (${userAddress}, role: ${userRole})`);

      const tx = await contract.verifyUser(userAddress, userRole, txOverrides);
      console.log(`[Relay Engine] User approval tx broadcast: ${tx.hash}. Awaiting block confirmation...`);

      let receipt: any = null;
      try {
        receipt = await tx.wait(1);
      } catch (waitErr: any) {
        console.warn("[Relay Engine] tx.wait() warning:", waitErr?.message || waitErr);
        return {
          success: false,
          txHash: tx.hash,
          chainId: chainId.toString(),
          error: `Transaction submitted but delayed in block: ${waitErr?.message || "confirmation timeout"}`,
          stage: "confirmation" as const,
        };
      }

      const txHash = receipt?.hash || tx.hash;
      const blockNumber = receipt?.blockNumber?.toString() ?? "unknown";
      console.log(`[Relay Engine] User approval successfully mined in block: ${blockNumber}`);

      return {
        success: true,
        txHash,
        blockNumber,
        chainId: chainId.toString(),
      };
    } catch (error: any) {
      console.warn("⚠️ Blockchain user approval delayed or bypassed safely:", error.message);
      return {
        success: false,
        error: error.message,
        stage: "transaction" as const,
      };
    }
  },
});

/**
 * Internal background action: Invoked asynchronously via ctx.scheduler.runAfter.
 * Handles dynamic student profile verification anchoring in the background.
 */
export const approveUserOnBlockchain = internalAction({
  args: {
    userId: v.string(),
    role: v.string(),
    name: v.string(),
  },
  handler: async (_ctx, args) => {
    try {
      const { contract } = await getBlockchainConnection();
      const userAddress = getPseudoAddress(args.userId);
      const txOverrides = getBesuGasOverrides("APPROVE_USER");

      console.log(`[Relay Engine] Anchoring background approval record for: ${args.name}`);

      const tx = await contract.verifyUser(userAddress, args.role, txOverrides);
      const receipt = await tx.wait(1);
      console.log(`[Relay Engine] Background user approval successfully mined in block: ${receipt.blockNumber}`);

      return { success: true, txHash: tx.hash };
    } catch (error: any) {
      console.warn("⚠️ Blockchain user approval delayed or bypassed safely:", error.message);
      return { success: false, error: error.message };
    }
  },
});

// ---------------------------------------------------------------------------
// 3. Message / DM Hash Anchoring Actions
// ---------------------------------------------------------------------------

interface RecordMessageResult {
  success: boolean;
  txHash?: string;
  blockNumber?: string;
  chainId?: string;
  error?: string;
  stage?: "confirmation" | "transaction" | "unknown";
}

/**
 * Core execution helper for recording cryptographic message hashes onto Besu.
 * Bypasses auto-gas estimation using getBesuGasOverrides("RECORD_MESSAGE").
 */
async function executeRecordMessage(args: {
  messageId: string;
  content: string;
  senderId?: string;
  receiverId?: string;
}): Promise<RecordMessageResult> {
  try {
    const { contract, chainId } = await getBlockchainConnection();
    const contentHash = computeSHA256Bytes32(args.content);
    const senderAddr = getPseudoAddress(args.senderId || "admin");
    const receiverAddr = getPseudoAddress(args.receiverId || "public");
    const txOverrides = getBesuGasOverrides("RECORD_MESSAGE");

    console.log(`[Relay Engine] Anchoring DM hash for message reference ID: ${args.messageId}`);
    console.log(`[Relay Engine] SHA-256 payload hash: ${contentHash}`);

    const tx = await contract.recordHash(
      args.messageId,
      contentHash,
      senderAddr,
      receiverAddr,
      txOverrides
    );
    console.log(`[Relay Engine] Broadcast tx: ${tx.hash}. Waiting for receipt...`);

    let receipt: any = null;
    try {
      receipt = await tx.wait(1);
    } catch (waitErr: any) {
      console.warn("[Relay Engine] tx.wait() notice:", waitErr?.message || waitErr);
      return {
        success: false,
        txHash: tx.hash,
        chainId: chainId.toString(),
        error: `Transaction submitted but receipt delayed: ${waitErr?.message || "timeout"}`,
        stage: "confirmation",
      };
    }

    const txHash = receipt?.hash || tx.hash;
    const blockNumber = receipt?.blockNumber?.toString() ?? "unknown";
    console.log(`[Relay Engine] DM transaction successfully mined in block: ${blockNumber}`);

    return {
      success: true,
      txHash,
      blockNumber,
      chainId: chainId.toString(),
    };
  } catch (error: any) {
    console.warn("⚠️ Blockchain message anchor fell back to safety block:", error.message);
    return {
      success: false,
      error: error.message,
      stage: "transaction",
    };
  }
}

/**
 * Public action: Directly invoked by client Web3 services (web3Service.ts).
 */
export const recordMessage = action({
  args: {
    messageId: v.string(),
    content: v.string(),
    senderId: v.optional(v.string()),
    receiverId: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    return await executeRecordMessage(args);
  },
});

/**
 * Internal background worker: Scheduled asynchronously by sendMessage mutation in qchat.ts.
 * 1. Pulls the committed message record from Convex DB.
 * 2. Connects to Besu with 60s cold-start timeout.
 * 3. Records message SHA-256 hash using free-gas overrides.
 * 4. Patches the confirmed txHash back into Convex messages table.
 */
export const anchorMessage = internalAction({
  args: {
    messageId: v.id("messages"),
  },
  handler: async (ctx, args) => {
    console.log(`[Relay Engine] Starting background blockchain anchor for message ${args.messageId}`);

    // 1. Retrieve message details from Convex
    let messageInfo: any;
    try {
      messageInfo = await ctx.runQuery(internal.qchat.getMessageForAnchoring, {
        messageId: args.messageId,
      });
    } catch (queryErr: any) {
      console.error(`[Relay Engine] Failed looking up message ${args.messageId}:`, queryErr?.message);
      return { success: false, error: queryErr?.message || "Lookup failed" };
    }

    if (!messageInfo) {
      console.warn(`[Relay Engine] Message ${args.messageId} no longer in Convex. Skipping.`);
      return { success: false, error: "Message not found" };
    }

    // 2. Idempotency check: already anchored in Convex?
    if (messageInfo.blockchainTxHash) {
      console.log(`[Relay Engine] Message already anchored (${messageInfo.blockchainTxHash}), skipping duplicate.`);
      return { success: true, txHash: messageInfo.blockchainTxHash, alreadyAnchored: true };
    }

    // 3. Contract-level idempotency check: check if already mined on Besu
    try {
      const { contract } = await getBlockchainConnection();
      const existingHash = await contract.verifyHash(args.messageId);
      if (existingHash && existingHash !== ethers.ZeroHash) {
        console.log(`[Relay Engine] Message ${args.messageId} already recorded on-chain (${existingHash}). Patching Convex.`);
        await ctx.runMutation(internal.qchat.updateMessageTxHashFromBlockchain, {
          messageId: args.messageId,
          txHash: existingHash,
        });
        return { success: true, alreadyRecordedOnChain: true };
      }
    } catch (checkErr: any) {
      // Normal path: verifyHash reverts when messageId is not yet on-chain
    }

    // 4. Submit to Besu using high-timeout provider and custom gas overrides
    const recordResult = await executeRecordMessage({
      messageId: args.messageId,
      content: messageInfo.text,
      senderId: messageInfo.senderId,
      receiverId: messageInfo.receiverId,
    });

    if (!recordResult.success || !recordResult.txHash) {
      console.warn(`[Relay Engine] Blockchain anchor delayed for ${args.messageId}:`, recordResult.error);
      return { success: false, error: recordResult.error };
    }

    // 5. Write confirmed transaction hash back to Convex message row
    try {
      await ctx.runMutation(internal.qchat.updateMessageTxHashFromBlockchain, {
        messageId: args.messageId,
        txHash: recordResult.txHash,
      });
      console.log(`[Relay Engine] ✅ Saved tx hash to Convex: ${recordResult.txHash} for message ${args.messageId}`);
    } catch (mutationErr: any) {
      console.error(`[Relay Engine] Failed updating Convex txHash:`, mutationErr?.message);
    }

    return {
      success: true,
      txHash: recordResult.txHash,
      blockNumber: recordResult.blockNumber,
    };
  },
});

/**
 * Internal action: Alternative standalone anchor matching (messageId, textPayload).
 * Generates SHA-256 hash and commits to Besu with 60-second timeout safety.
 */
export const anchorMessageHash = internalAction({
  args: {
    messageId: v.string(),
    textPayload: v.string(),
  },
  handler: async (ctx, args) => {
    try {
      const { contract } = await getBlockchainConnection();
      const messageHash = ethers.sha256(ethers.toUtf8Bytes(args.textPayload));
      const senderAddr = ethers.ZeroAddress;
      const receiverAddr = ethers.ZeroAddress;
      const txOverrides = getBesuGasOverrides("RECORD_MESSAGE");

      console.log(`[Relay Engine] Anchoring DM hash for message reference ID: ${args.messageId}`);

      const tx = await contract.recordHash(
        args.messageId,
        messageHash,
        senderAddr,
        receiverAddr,
        txOverrides
      );
      const receipt = await tx.wait(1);
      console.log(`[Relay Engine] DM transaction successfully mined in block: ${receipt.blockNumber}`);

      // If messageId is a valid Convex ID, attempt patching the row
      try {
        await ctx.runMutation(internal.qchat.updateMessageTxHashFromBlockchain, {
          messageId: args.messageId as any,
          txHash: tx.hash,
        });
      } catch {
        // Non-fatal if messageId is an external or custom string key
      }

      return { success: true, txHash: tx.hash };
    } catch (error: any) {
      console.warn("⚠️ Blockchain message anchor fell back to safety block:", error.message);
      return { success: false, error: error.message };
    }
  },
});

// ---------------------------------------------------------------------------
// 4. Universal Relay Action (relayHash)
// ---------------------------------------------------------------------------

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
      const { contract, chainId } = await getBlockchainConnection();

      if (args.actionType === "APPROVE_USER") {
        const userAddress = getPseudoAddress(args.identifier);
        const role = args.role || "student";
        const txOverrides = getBesuGasOverrides("APPROVE_USER");
        console.log(`[Relay Engine] relayHash APPROVE_USER for ${args.identifier} (${userAddress}, role: ${role})`);

        const tx = await contract.verifyUser(userAddress, role, txOverrides);
        const receipt = await tx.wait(1);
        const txHash = receipt?.hash || tx.hash;
        const blockNumber = receipt?.blockNumber?.toString() ?? "unknown";
        return { success: true, txHash, blockNumber, chainId: chainId.toString() };

      } else if (args.actionType === "RECORD_MESSAGE") {
        const contentHash = computeSHA256Bytes32(args.rawTextPayload || "");
        const senderAddr = getPseudoAddress(args.senderId || "admin");
        const receiverAddr = getPseudoAddress(args.receiverId || "public");
        const txOverrides = getBesuGasOverrides("RECORD_MESSAGE");
        console.log(`[Relay Engine] relayHash RECORD_MESSAGE for ${args.identifier}`);

        const tx = await contract.recordHash(
          args.identifier,
          contentHash,
          senderAddr,
          receiverAddr,
          txOverrides
        );
        const receipt = await tx.wait(1);
        const txHash = receipt?.hash || tx.hash;
        const blockNumber = receipt?.blockNumber?.toString() ?? "unknown";
        return { success: true, txHash, blockNumber, chainId: chainId.toString() };
      }

      return { success: false, error: `Unsupported action type: ${args.actionType}` };
    } catch (error: any) {
      console.error("[Relay Engine] relayHash failed:", error?.message || error);
      return { success: false, error: error?.message || String(error) };
    }
  },
});

// ---------------------------------------------------------------------------
// 5. User Profile Hash Anchoring (recordProfileHash)
// ---------------------------------------------------------------------------

export const recordProfileHash = action({
  args: {
    userId: v.string(),
    idNumber: v.string(),
    email: v.string(),
    school: v.string(),
    role: v.string(),
    requestId: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    try {
      const { contract, chainId } = await getBlockchainConnection();
      const payload = `${args.userId}|${args.idNumber}|${args.email}|${args.school}|${args.role}`;
      const profileHash = computeSHA256Bytes32(payload);
      const userAddress = getPseudoAddress(args.userId);
      const messageId = args.requestId || `profile:${args.userId}`;
      const txOverrides = getBesuGasOverrides("RECORD_PROFILE_HASH");

      console.log(`[Relay Engine] Anchoring profile hash for user ${args.userId}: ${profileHash}`);

      const tx = await contract.recordHash(
        messageId,
        profileHash,
        userAddress,
        ethers.ZeroAddress,
        txOverrides
      );
      const receipt = await tx.wait(1);
      const txHash = receipt?.hash || tx.hash;
      const blockNumber = receipt?.blockNumber?.toString() ?? "unknown";

      return {
        success: true,
        txHash,
        blockNumber,
        chainId: chainId.toString(),
        profileHash,
      };
    } catch (error: any) {
      console.error("[Relay Engine] recordProfileHash failed:", error?.message || error);
      return {
        success: false,
        error: error?.message || String(error),
        txHash: null,
        profileHash: null,
      };
    }
  },
});
