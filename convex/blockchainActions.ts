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
  "function recordHash(string memory messageId, bytes32 messageHash, address sender, address receiver) external",
  "function verifyHash(string memory messageId) external view returns (bytes32)",
  "function verifyUser(address userAddress, string memory role) external",
  "function getUserRole(address userAddress) external view returns (string memory)",
];

// Besu private network runs with zero gas price.
// Explicit gasLimit avoids ethers v6 triggering internal estimateGas RPC calls
// that fail with CALL_EXCEPTION on zero-gas nodes.
const BESU_TX_OVERRIDES = {
  gasLimit: 500_000n,
  gasPrice: 0n,
};

const EXPECTED_CHAIN_ID = 1337n;

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
 * Throws a clear error rather than silently falling back to localhost —
 * connecting to localhost from Convex Cloud would reach the Convex runtime
 * itself, not the Render Besu node.
 */
function requireRpcUrl(): string {
  let url =
    process.env.BESU_RPC_URL ||
    process.env.BLOCKCHAIN_RPC_URL;

  if (!url) {
    throw new Error(
      "[Besu RPC] BESU_RPC_URL is not set in Convex environment variables. " +
      "Run: npx convex env set BESU_RPC_URL https://qcampus-blockchain-nodelast.onrender.com"
    );
  }

  // Guard against the double-prefix typo: BESU_RPC_URL=BESU_RPC_URL=https://...
  if (url.startsWith("BESU_RPC_URL=")) {
    url = url.replace(/^BESU_RPC_URL=/, "");
  }

  return url.trim();
}

/**
 * Pings the Render-hosted Besu RPC endpoint to wake the service if sleeping,
 * and polls until Besu is ready and returns chain ID 1337 (0x539).
 */
async function waitForBesu(
  rpcUrl: string,
  timeoutMs = 90_000
): Promise<void> {
  const started = Date.now();
  let attempt = 0;

  while (Date.now() - started < timeoutMs) {
    attempt++;

    try {
      console.log(`[Besu Wake] Attempt ${attempt}: pinging ${rpcUrl}`);

      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_chainId",
          params: [],
          id: Date.now(),
        }),
      });

      const body = await response.json();

      if (body?.result === "0x539") {
        console.log("[Besu Wake] Besu is ready. Chain ID 1337.");
        return;
      }

      console.log("[Besu Wake] RPC responded but Besu is not ready:", body);
    } catch (error: any) {
      console.log(
        `[Besu Wake] Render/Besu not ready yet: ${
          error?.message || String(error)
        }`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  throw new Error(
    `[Besu Wake] Timed out after ${timeoutMs}ms waiting for Render/Besu`
  );
}

/**
 * Resolves the system private key from environment variables.
 * Never falls back to a hardcoded key. Throws if missing.
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
 * Creates an ethers JsonRpcProvider, Wallet signer, and Contract instance.
 * Transport: HTTP JSON-RPC over HTTPS only. No WebSocket.
 * Dynamically detects the chain ID and validates it equals 1337.
 */
async function getBlockchainConnection() {
  const rpcUrl = requireRpcUrl();
  const privateKey = requirePrivateKey();

  // --- Stage: RPC ---
  console.log("[Besu RPC] URL configured:", rpcUrl.replace(/https?:\/\//, "").split("/")[0]);
  console.log("[Besu RPC] Connecting through HTTP JSON-RPC...");

  const provider = new ethers.JsonRpcProvider(rpcUrl);

  let network: ethers.Network;
  try {
    network = await provider.getNetwork();
  } catch (err: any) {
    throw new Error(
      `[Besu RPC] Cannot connect to ${rpcUrl}. ` +
      `Error: ${err?.message || String(err)}`
    );
  }

  console.log("[Besu Network] Chain ID:", network.chainId.toString());

  if (network.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(
      `[Besu Network] Wrong chain ID. Expected ${EXPECTED_CHAIN_ID}, got ${network.chainId}. ` +
      `Check BESU_RPC_URL points to the correct Render Besu node.`
    );
  }

  // Re-initialise with the confirmed network so ethers doesn't re-query it
  const fixedProvider = new ethers.JsonRpcProvider(rpcUrl, network, {
    staticNetwork: network,
  });

  // --- Stage: Wallet ---
  let wallet: ethers.Wallet;
  try {
    wallet = new ethers.Wallet(privateKey, fixedProvider);
  } catch (err: any) {
    throw new Error(
      `[Besu Wallet] Failed to initialise wallet: ${err?.message || String(err)}`
    );
  }
  console.log("[Besu Wallet] Address:", wallet.address);

  // --- Stage: Contract ---
  const code = await fixedProvider.getCode(CONTRACT_ADDRESS);
  if (code === "0x") {
    throw new Error(
      `[Besu Contract] No bytecode found at ${CONTRACT_ADDRESS} on chain ${network.chainId}. ` +
      `The contract has not been deployed to this Besu node. ` +
      `Deploy it with: npx hardhat run scripts/deploy.ts --network besu-render`
    );
  }
  console.log("[Besu Contract] Bytecode verified at", CONTRACT_ADDRESS, `(${(code.length - 2) / 2} bytes)`);

  const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);

  const txOverrides = {
    gasLimit: BESU_TX_OVERRIDES.gasLimit,
    gasPrice: BESU_TX_OVERRIDES.gasPrice,
    chainId: network.chainId,
  };

  return { provider: fixedProvider, wallet, contract, chainId: network.chainId, txOverrides };
}

// ---------------------------------------------------------------------------
// Diagnostic action — run this first to prove connectivity
// ---------------------------------------------------------------------------

/**
 * Diagnostic action: proves Convex → HTTPS → Render → Besu connectivity.
 * Tests each stage independently so failures are precisely identified.
 * Does NOT send any transaction.
 *
 * Call from the Convex dashboard or via:
 *   npx convex run blockchainActions:testBesuConnection
 */
export const testBesuConnection = action({
  args: {},
  handler: async (_ctx, _args) => {
    const result: Record<string, any> = {
      success: false,
      stages: {},
    };

    // Stage A: URL configured?
    let rpcUrl: string;
    try {
      rpcUrl = requireRpcUrl();
      result.stages.rpcUrl = { ok: true, host: rpcUrl.replace(/https?:\/\//, "").split("/")[0] };
      console.log("[Besu RPC] URL configured:", result.stages.rpcUrl.host);
    } catch (err: any) {
      result.stages.rpcUrl = { ok: false, error: err.message };
      console.error("[Besu RPC] URL missing:", err.message);
      return { ...result, error: err.message, stage: "rpc_url" };
    }

    // Stage B: HTTP JSON-RPC connectivity + chain ID
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    let network: ethers.Network;
    try {
      network = await provider.getNetwork();
      const chainId = network.chainId.toString();
      const chainIdOk = network.chainId === EXPECTED_CHAIN_ID;
      result.stages.network = { ok: chainIdOk, chainId, expected: EXPECTED_CHAIN_ID.toString() };
      console.log("[Besu RPC] Chain ID:", chainId, chainIdOk ? "✓" : `✗ (expected ${EXPECTED_CHAIN_ID})`);
      if (!chainIdOk) {
        return { ...result, error: `Wrong chain ID: ${chainId}`, stage: "network" };
      }
    } catch (err: any) {
      result.stages.network = { ok: false, error: err.message };
      console.error("[Besu RPC] Cannot connect:", err.message);
      return { ...result, error: `RPC unreachable: ${err.message}`, stage: "rpc_connect" };
    }

    // Stage C: Block number (and whether blocks are advancing)
    let blockA: bigint;
    let blockB: bigint;
    try {
      blockA = await provider.getBlockNumber().then(BigInt);
      console.log("[Besu RPC] Block number (A):", blockA.toString());

      await new Promise((r) => setTimeout(r, 6000)); // wait 6s (~3 blocks at 2s period)

      blockB = await provider.getBlockNumber().then(BigInt);
      console.log("[Besu RPC] Block number (B):", blockB.toString());

      const advancing = blockB > blockA;
      result.stages.blockProduction = {
        ok: advancing,
        blockA: blockA.toString(),
        blockB: blockB.toString(),
        warning: advancing ? undefined : "Block number did not advance — QBFT may not be producing blocks. Check the Render Besu validator key configuration.",
      };

      if (!advancing) {
        console.warn("[Besu Network] ⚠ Block number did not advance in 6s. QBFT block production may be broken.");
      } else {
        console.log("[Besu Network] Block production confirmed ✓");
      }
    } catch (err: any) {
      result.stages.blockProduction = { ok: false, error: err.message };
      console.error("[Besu RPC] eth_blockNumber failed:", err.message);
    }

    // Stage D: Contract exists?
    try {
      const code = await provider.getCode(CONTRACT_ADDRESS);
      const hasCode = code !== "0x";
      const byteLength = hasCode ? (code.length - 2) / 2 : 0;
      result.stages.contract = { ok: hasCode, address: CONTRACT_ADDRESS, bytes: byteLength };
      if (hasCode) {
        console.log(`[Besu Contract] Bytecode found at ${CONTRACT_ADDRESS} (${byteLength} bytes) ✓`);
      } else {
        console.warn(`[Besu Contract] ⚠ No bytecode at ${CONTRACT_ADDRESS}. Deploy the contract first.`);
      }
    } catch (err: any) {
      result.stages.contract = { ok: false, error: err.message };
    }

    // Stage E: Wallet loaded?
    let walletAddress = "(not checked — SYSTEM_PRIVATE_KEY missing)";
    let walletBalance = "(n/a)";
    try {
      const pk = requirePrivateKey();
      const wallet = new ethers.Wallet(pk, provider);
      walletAddress = wallet.address;
      const balanceWei = await provider.getBalance(walletAddress);
      walletBalance = ethers.formatEther(balanceWei) + " ETH";
      result.stages.wallet = { ok: true, address: walletAddress, balance: walletBalance };
      console.log("[Besu Wallet] Address:", walletAddress);
      console.log("[Besu Wallet] Balance:", walletBalance);
    } catch (err: any) {
      result.stages.wallet = { ok: false, error: err.message };
      console.error("[Besu Wallet]", err.message);
    }

    // Summary
    const allOk = Object.values(result.stages).every((s: any) => s.ok !== false);
    result.success = allOk;

    if (allOk) {
      console.log("[Besu RPC] ✅ All connectivity checks passed.");
    } else {
      console.warn("[Besu RPC] ⚠ Some checks failed — see stages for details.");
    }

    return result;
  },
});

// ---------------------------------------------------------------------------
// approveUser — registers a user role on Besu
// ---------------------------------------------------------------------------

/**
 * Approves a user's role on the Hyperledger Besu private network.
 * Transport: HTTP JSON-RPC over HTTPS (ethers.JsonRpcProvider). No WebSocket.
 */
export const approveUser = action({
  args: {
    userId: v.string(),
    role: v.optional(v.string()),
    name: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    try {
      const { contract, txOverrides, chainId } = await getBlockchainConnection();
      const userAddress = getPseudoAddress(args.userId);
      const userRole = args.role || "student";

      console.log(`[Besu Transaction] Sending verifyUser for ${args.userId} (${userAddress}, role: ${userRole})`);

      const tx = await contract.verifyUser(userAddress, userRole, txOverrides);
      console.log("[Besu Transaction] Hash:", tx.hash);
      console.log("[Besu Transaction] Waiting for receipt...");

      let receipt: any = null;
      try {
        receipt = await tx.wait(1);
      } catch (waitErr: any) {
        // tx.wait() throws if the block never arrives (e.g. chain not mining).
        // Return the hash so the caller knows the tx was submitted but not confirmed.
        console.error("[Besu Transaction] tx.wait() failed:", waitErr?.message || waitErr);
        return {
          success: false,
          txHash: tx.hash,
          chainId: chainId.toString(),
          error: `Transaction submitted but not confirmed: ${waitErr?.message || "tx.wait() timeout"}`,
          stage: "confirmation" as const,
        };
      }

      const txHash = receipt?.hash || tx.hash;
      const blockNumber = receipt?.blockNumber?.toString() ?? "unknown";
      const status = receipt?.status;

      console.log("[Besu Receipt] Block:", blockNumber);
      console.log("[Besu Receipt] Status:", status === 1 ? "1 (success)" : `${status} (FAILED)`);

      if (status !== 1) {
        return {
          success: false,
          txHash,
          blockNumber,
          chainId: chainId.toString(),
          error: `Transaction reverted on-chain (status=${status})`,
          stage: "transaction" as const,
        };
      }

      console.log("[Besu Receipt] ✅ verifyUser confirmed on Besu. Tx:", txHash);
      return { success: true, txHash, blockNumber, chainId: chainId.toString() };

    } catch (error: any) {
      const message: string = error?.message || String(error);
      const stage = message.includes("[Besu RPC]")
        ? "rpc"
        : message.includes("[Besu Network]")
        ? "network"
        : message.includes("[Besu Wallet]")
        ? "wallet"
        : message.includes("[Besu Contract]")
        ? "contract"
        : "unknown";

      console.error(`[Besu ${stage.toUpperCase()}] approveUser failed:`, message);
      return {
        success: false,
        error: message,
        stage: stage as "rpc" | "network" | "wallet" | "contract" | "transaction" | "confirmation" | "unknown",
      };
    }
  },
});

// ---------------------------------------------------------------------------
// recordMessage — records a message hash on Besu
// ---------------------------------------------------------------------------

/**
 * Records a message hash onto the Hyperledger Besu private network.
 * Transport: HTTP JSON-RPC over HTTPS. No WebSocket.
 */
interface RecordMessageResult {
  success: boolean;
  txHash?: string;
  blockNumber?: string;
  chainId?: string;
  error?: string;
  stage?: "confirmation" | "transaction" | "unknown";
}

/**
 * Shared executor for recording message hashes to Besu.
 * Reused by both the public recordMessage action and the internal anchorMessage action.
 */
async function executeRecordMessage(args: {
  messageId: string;
  content: string;
  senderId?: string;
  receiverId?: string;
}): Promise<RecordMessageResult> {
  try {
    const { contract, txOverrides, chainId } = await getBlockchainConnection();
    const contentHash = computeSHA256Bytes32(args.content);
    const senderAddr = getPseudoAddress(args.senderId || "admin");
    const receiverAddr = getPseudoAddress(args.receiverId || "public");

    console.log(`[Besu Transaction] Sending recordHash for message ${args.messageId}`);
    console.log(`[Besu Transaction] Hash payload: ${contentHash}`);

    const tx = await contract.recordHash(
      args.messageId,
      contentHash,
      senderAddr,
      receiverAddr,
      txOverrides
    );
    console.log("[Besu Transaction] Hash:", tx.hash);
    console.log("[Besu Transaction] Waiting for receipt...");

    let receipt: any = null;
    try {
      receipt = await tx.wait(1);
    } catch (waitErr: any) {
      console.error("[Besu Transaction] tx.wait() failed:", waitErr?.message || waitErr);
      return {
        success: false,
        txHash: tx.hash,
        chainId: chainId.toString(),
        error: `Transaction submitted but not confirmed: ${waitErr?.message || "tx.wait() timeout"}`,
        stage: "confirmation",
      };
    }

    const txHash = receipt?.hash || tx.hash;
    const blockNumber = receipt?.blockNumber?.toString() ?? "unknown";
    const status = receipt?.status;

    console.log("[Besu Receipt] Block:", blockNumber);
    console.log("[Besu Receipt] Status:", status === 1 ? "1 (success)" : `${status} (FAILED)`);

    if (status !== 1) {
      return {
        success: false,
        txHash,
        blockNumber,
        chainId: chainId.toString(),
        error: `Transaction reverted on-chain (status=${status})`,
        stage: "transaction",
      };
    }

    console.log("[Besu Receipt] ✅ recordHash confirmed on Besu. Tx:", txHash);
    return { success: true, txHash, blockNumber, chainId: chainId.toString() };

  } catch (error: any) {
    const message: string = error?.message || String(error);
    console.error("[Besu Contract] recordMessage failed:", message);
    return {
      success: false,
      error: message,
      stage: "unknown",
    };
  }
}

/**
 * Records a message hash onto the Hyperledger Besu private network.
 * Transport: HTTP JSON-RPC over HTTPS. No WebSocket.
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
 * Automatically scheduled backend action that wakes Render/Besu if asleep,
 * waits until Besu is ready, records the message on-chain, waits for confirmation,
 * and writes the transaction hash back into the Convex message document.
 */
export const anchorMessage = internalAction({
  args: {
    messageId: v.id("messages"),
  },
  handler: async (ctx, args) => {
    console.log(`[Message Anchor] Starting blockchain anchor for message ${args.messageId}`);

    // 1. Retrieve message details from Convex
    let messageInfo: any;
    try {
      messageInfo = await ctx.runQuery(internal.qchat.getMessageForAnchoring, {
        messageId: args.messageId,
      });
    } catch (queryErr: any) {
      console.error(
        `[Message Anchor] Failed looking up message ${args.messageId}:`,
        queryErr?.message || queryErr
      );
      return { success: false, error: queryErr?.message || "Message query failed", stage: "message_lookup" };
    }

    if (!messageInfo) {
      console.warn(`[Message Anchor] Message ${args.messageId} no longer exists in Convex. Skipping.`);
      return { success: false, error: "Message not found", stage: "message_lookup" };
    }

    // 2. Idempotency check: already anchored in Convex?
    if (messageInfo.blockchainTxHash) {
      console.log(
        `[Message Anchor] Message already anchored (${messageInfo.blockchainTxHash}), skipping`
      );
      return { success: true, txHash: messageInfo.blockchainTxHash, alreadyAnchored: true };
    }

    // 3. Resolve RPC URL and wake Render/Besu if sleeping
    let rpcUrl: string;
    try {
      rpcUrl = requireRpcUrl();
    } catch (urlErr: any) {
      console.error(`[Message Anchor] RPC URL resolution error:`, urlErr?.message || urlErr);
      return { success: false, error: urlErr?.message, stage: "rpc_url" };
    }

    try {
      await waitForBesu(rpcUrl);
    } catch (wakeErr: any) {
      console.error(`[Message Anchor] Render/Besu wake-up failed:`, wakeErr?.message || wakeErr);
      // Message remains in Convex safe and sound
      return { success: false, error: wakeErr?.message || "Besu not ready", stage: "render_wake" };
    }

    // 4. Contract-level idempotency check: verify if message already recorded on-chain
    try {
      const { contract } = await getBlockchainConnection();
      const existingHash = await contract.verifyHash(args.messageId);
      if (existingHash && existingHash !== ethers.ZeroHash) {
        console.log(
          `[Message Anchor] Message ${args.messageId} is already recorded on-chain with hash ${existingHash}. Skipping duplicate transaction.`
        );
        return { success: true, alreadyRecordedOnChain: true };
      }
    } catch (checkErr: any) {
      // verifyHash reverts when messageId is not found ("MessageVerifier: messageId not found").
      // That is the normal expected case for a message that hasn't been anchored yet.
      const errMsg = checkErr?.message || String(checkErr);
      if (!errMsg.includes("not found")) {
        console.warn(`[Message Anchor] verifyHash check notice:`, errMsg);
      }
    }

    // 5. Call existing recordMessage infrastructure
    console.log(`[Message Anchor] Calling recordMessage for ${args.messageId}`);
    const recordResult = await executeRecordMessage({
      messageId: args.messageId,
      content: messageInfo.text,
      senderId: messageInfo.senderId,
      receiverId: messageInfo.receiverId,
    });

    if (!recordResult.success || !recordResult.txHash) {
      console.error(
        `[Message Anchor] Failed to anchor message ${args.messageId}:`,
        recordResult.error
      );
      return {
        success: false,
        error: recordResult.error,
        stage: recordResult.stage || "record",
      };
    }

    console.log(`[Message Anchor] Transaction submitted: ${recordResult.txHash}`);
    console.log(`[Message Anchor] Transaction confirmed in block ${recordResult.blockNumber}`);

    // 6. Save confirmed tx hash to Convex message document via internal mutation
    try {
      await ctx.runMutation(internal.qchat.updateMessageTxHashFromBlockchain, {
        messageId: args.messageId,
        txHash: recordResult.txHash,
      });
      console.log(`[Message Anchor] Saved tx hash to Convex`);
    } catch (mutationErr: any) {
      console.error(
        `[Message Anchor] Failed saving txHash to Convex for message ${args.messageId}:`,
        mutationErr?.message || mutationErr
      );
      return {
        success: false,
        txHash: recordResult.txHash,
        error: mutationErr?.message || "Failed updating Convex document",
        stage: "convex_update",
      };
    }

    return {
      success: true,
      txHash: recordResult.txHash,
      blockNumber: recordResult.blockNumber,
    };
  },
});

// ---------------------------------------------------------------------------
// relayHash — universal relay (APPROVE_USER or RECORD_MESSAGE)
// ---------------------------------------------------------------------------

/**
 * Universal relay action handling either APPROVE_USER or RECORD_MESSAGE.
 * Transport: HTTP JSON-RPC over HTTPS. No WebSocket.
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
      const { contract, txOverrides, chainId } = await getBlockchainConnection();

      if (args.actionType === "APPROVE_USER") {
        const userAddress = getPseudoAddress(args.identifier);
        const role = args.role || "student";
        console.log(`[Besu Transaction] relayHash APPROVE_USER for ${args.identifier} (${userAddress}, role: ${role})`);

        const tx = await contract.verifyUser(userAddress, role, txOverrides);
        console.log("[Besu Transaction] Hash:", tx.hash);
        const receipt = await tx.wait(1);
        const txHash = receipt?.hash || tx.hash;
        const blockNumber = receipt?.blockNumber?.toString() ?? "unknown";
        console.log("[Besu Receipt] Block:", blockNumber, "Status:", receipt?.status);
        return { success: true, txHash, blockNumber, chainId: chainId.toString() };

      } else if (args.actionType === "RECORD_MESSAGE") {
        const contentHash = computeSHA256Bytes32(args.rawTextPayload || "");
        const senderAddr = getPseudoAddress(args.senderId || "admin");
        const receiverAddr = getPseudoAddress(args.receiverId || "public");
        console.log(`[Besu Transaction] relayHash RECORD_MESSAGE for ${args.identifier}`);

        const tx = await contract.recordHash(
          args.identifier,
          contentHash,
          senderAddr,
          receiverAddr,
          txOverrides
        );
        console.log("[Besu Transaction] Hash:", tx.hash);
        const receipt = await tx.wait(1);
        const txHash = receipt?.hash || tx.hash;
        const blockNumber = receipt?.blockNumber?.toString() ?? "unknown";
        console.log("[Besu Receipt] Block:", blockNumber, "Status:", receipt?.status);
        return { success: true, txHash, blockNumber, chainId: chainId.toString() };
      }

      return { success: false, error: `Unsupported action type: ${args.actionType}`, stage: "unknown" as const };

    } catch (error: any) {
      const message: string = error?.message || String(error);
      console.error("[Besu Contract] relayHash failed:", message);
      return {
        success: false,
        error: message,
        stage: "unknown" as const,
      };
    }
  },
});

// ---------------------------------------------------------------------------
// recordProfileHash — anchors a user verification profile hash to Besu
// ---------------------------------------------------------------------------

/**
 * Records a profile hash for a verification submission onto Besu.
 * Called when a user submits their verification request so the data is
 * cryptographically anchored before the admin reviews it.
 * Transport: HTTP JSON-RPC over HTTPS. No WebSocket.
 */
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
      const { contract, txOverrides, chainId } = await getBlockchainConnection();

      // Build a deterministic payload string from the user's profile fields
      const payload = `${args.userId}|${args.idNumber}|${args.email}|${args.school}|${args.role}`;
      const profileHash = computeSHA256Bytes32(payload);
      const userAddress = getPseudoAddress(args.userId);

      console.log(`[Besu Transaction] Anchoring profile hash for user ${args.userId}`);
      console.log(`[Besu Transaction] Profile hash: ${profileHash}`);
      console.log(`[Besu Wallet] Pseudo-address: ${userAddress}`);

      const messageId = args.requestId || `profile:${args.userId}`;
      const tx = await contract.recordHash(
        messageId,
        profileHash,
        userAddress,
        ethers.ZeroAddress,
        txOverrides,
      );
      console.log("[Besu Transaction] Hash:", tx.hash);
      console.log("[Besu Transaction] Waiting for receipt...");

      let receipt: any = null;
      try {
        receipt = await tx.wait(1);
      } catch (waitErr: any) {
        console.error("[Besu Transaction] tx.wait() failed:", waitErr?.message || waitErr);
        return {
          success: false,
          txHash: tx.hash,
          chainId: chainId.toString(),
          profileHash,
          error: `Transaction submitted but not confirmed: ${waitErr?.message || "tx.wait() timeout"}`,
          stage: "confirmation" as const,
        };
      }

      const txHash = receipt?.hash || tx.hash;
      const blockNumber = receipt?.blockNumber?.toString() ?? "unknown";
      const status = receipt?.status;

      console.log("[Besu Receipt] Block:", blockNumber);
      console.log("[Besu Receipt] Status:", status === 1 ? "1 (success)" : `${status} (FAILED)`);

      if (status !== 1) {
        return {
          success: false,
          txHash,
          blockNumber,
          chainId: chainId.toString(),
          profileHash,
          error: `Transaction reverted on-chain (status=${status})`,
          stage: "transaction" as const,
        };
      }

      console.log("[Besu Receipt] ✅ Profile hash anchored to Besu. Tx:", txHash);
      return { success: true, txHash, blockNumber, chainId: chainId.toString(), profileHash };

    } catch (error: any) {
      const message: string = error?.message || String(error);
      console.error("[Besu Contract] recordProfileHash failed:", message);
      return {
        success: false,
        error: message,
        txHash: null,
        profileHash: null,
        stage: "unknown" as const,
      };
    }
  },
});
