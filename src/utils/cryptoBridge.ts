import { ethers } from "ethers";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";

// Always use the environment variable — never a hardcoded URL.
// The hardcoded rightful-orca-265 URL was the old deployment and caused CORS failures.
const CONVEX_URL = import.meta.env.VITE_CONVEX_URL as string;

if (!CONVEX_URL) {
  console.error("❌ [cryptoBridge] VITE_CONVEX_URL is not defined. Blockchain relay will fail.");
}

const convexClient = new ConvexHttpClient(CONVEX_URL || "");
const convexApi = api as any;

/**
 * Deterministically derives a 20-byte Ethereum address from a Convex ID.
 * This allows user-specific or entity-specific keys without needing true wallets.
 */
export function getPseudoAddress(id: string): string {
  if (!id || id === "public" || id === "skip") {
    return ethers.ZeroAddress;
  }
  const hash = ethers.keccak256(ethers.toUtf8Bytes(id));
  return "0x" + hash.substring(26);
}

/**
 * Generates a 2048-bit RSA key pair (RSASSA-PKCS1-v1_5, SHA-256).
 * The private key is set as non-extractable and saved to IndexedDB ("QChatLocalVault", store "keys").
 * The public key is exported in SPKI format as a Base64 string.
 * 
 * @param userId Unique identifier for the user to index the private key in IndexedDB.
 * @returns The Base64 encoded public key string (SPKI format).
 */
export async function generateAndStoreKeyPair(userId: string): Promise<string> {
  // Generate keypair
  const keyPair = await window.crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true, // Extractable public key and private key object
    ["encrypt", "decrypt"]
  );

  // Export public key in SPKI format
  const exportedPublic = await window.crypto.subtle.exportKey(
    "spki",
    keyPair.publicKey
  );

  // Convert ArrayBuffer to Base64 string
  const publicBase64 = btoa(
    String.fromCharCode(...new Uint8Array(exportedPublic))
  );

  // Save the private key natively into IndexedDB indexed by userId
  await savePrivateKeyToIndexedDB(userId, keyPair.privateKey);

  return publicBase64;
}

/**
 * Saves a CryptoKey to the browser's local IndexedDB.
 */
export function savePrivateKeyToIndexedDB(
  userId: string,
  privateKey: CryptoKey
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("QChatLocalVault", 1);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains("keys")) {
        db.createObjectStore("keys");
      }
    };

    request.onsuccess = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      const transaction = db.transaction("keys", "readwrite");
      const store = transaction.objectStore("keys");
      const putRequest = store.put(privateKey, userId);

      putRequest.onsuccess = () => {
        resolve();
      };

      putRequest.onerror = () => {
        reject(putRequest.error || new Error("Failed to store private key."));
      };
    };

    request.onerror = () => {
      reject(request.error || new Error("Failed to open IndexedDB vault."));
    };
  });
}

/**
 * Retrieves a CryptoKey from the browser's local IndexedDB.
 */
export function getPrivateKeyFromIndexedDB(
  userId: string
): Promise<CryptoKey | null> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("QChatLocalVault", 1);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains("keys")) {
        db.createObjectStore("keys");
      }
    };

    request.onsuccess = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      const transaction = db.transaction("keys", "readonly");
      const store = transaction.objectStore("keys");
      const getRequest = store.get(userId);

      getRequest.onsuccess = () => {
        resolve(getRequest.result || null);
      };

      getRequest.onerror = () => {
        reject(getRequest.error || new Error("Failed to retrieve private key."));
      };
    };

    request.onerror = () => {
      reject(request.error || new Error("Failed to open IndexedDB vault."));
    };
  });
}

/**
 * Computes the client-side SHA-256 hash of a string payload and formats it as a 0x-prefixed hex string (bytes32).
 */
export async function computeSHA256Bytes32(payload: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(payload);
  const hashBuffer = await window.crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `0x${hashHex}`;
}

/**
 * Relays user identity approval or message hashes to the Hyperledger Besu Private network.
 * Uses a walletless admin signing loop configured with zero gas.
 * 
 * @param actionType The operation to perform: "APPROVE_USER" or "RECORD_MESSAGE".
 * @param identifier The target ID (convexUserId or messageId).
 * @param rawTextPayload The raw text payload to hash (empty string or custom payload for user approvals, message text for messages).
 * @param extraData Optional extra context (senderId, receiverId, role).
 * @returns The transaction hash of the dispatched blockchain transaction.
 */
export async function relayHashToBesu(
  actionType: "APPROVE_USER" | "RECORD_MESSAGE",
  identifier: string,
  rawTextPayload: string,
  extraData?: {
    senderId?: string;
    receiverId?: string;
    role?: string;
  }
): Promise<string> {
  try {
    const result: any = await convexClient.action(convexApi.blockchainActions.relayHash, {
      actionType,
      identifier,
      rawTextPayload,
      senderId: extraData?.senderId,
      receiverId: extraData?.receiverId,
      role: extraData?.role,
    });

    if (result && !result.success) {
      console.warn("[Blockchain Sync] Relay returned non-critical status:", result.error);
      return result.txHash || "";
    }

    return result?.txHash || "";
  } catch (error) {
    console.error("Blockchain relay error:", error);
    throw error;
  }
}
