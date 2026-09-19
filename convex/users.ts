import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";

// Existing query – left unchanged
export const getMe = query({
  args: {
    sessionToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!args.sessionToken) return null;

    const user = await ctx.db
      .query("users")
      .withIndex("by_sessionToken", (q) =>
        q.eq("sessionToken", args.sessionToken as string),
      )
      .first();

    if (!user) return null;

    const verificationStatus =
      user.approved === true ? "approved" : user.verificationStatus;

    return {
      ...user,
      institution: user.school,
      verificationStatus,
      isVerified: user.approved === true || verificationStatus === "approved",
    };
  },
});

// 1. Fetch a user by their Convex document ID
export const getById = query({
  args: {
    id: v.id("users"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const registerUserInDatabase = mutation({
  args: {
    email: v.string(),
    firstName: v.string(),
    lastName: v.string(),
    indexNumber: v.string(),
    role: v.string(),
    walletAddress: v.string(),
    passwordHash: v.string(),
  },
  handler: async (ctx, args) => {
    // Verify duplicate emails are caught beforehand
    const cleanEmail = args.email.trim().toLowerCase();
    const existing = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", cleanEmail))
      .first();

    if (existing) {
      throw new Error("An account with this email address already exists.");
    }

    const cleanFirstName = args.firstName.trim();
    const cleanLastName = args.lastName.trim();
    const fullName = `${cleanFirstName} ${cleanLastName}`.trim();
    const now = Date.now();
    const sessionToken = `session:${cleanEmail}:${crypto.randomUUID()}`;

    // Securely lock the user profile data row into Convex cloud tables permanently
    const newUserId = await ctx.db.insert("users", {
      email: cleanEmail,
      firstName: cleanFirstName,
      lastName: cleanLastName,
      fullName,
      school: "University of Energy and Natural Resources (UENR)",
      indexNumber: args.indexNumber.trim().toUpperCase(),
      idNumber: args.indexNumber.trim().toUpperCase(),
      role: args.role === "lecturer" ? "lecturer" : "student",
      walletAddress: args.walletAddress,
      blockchainVerified: false,
      txHash: "",
      blockNumber: "",
      passwordHash: args.passwordHash,
      sessionToken,
      verificationStatus: "unverified",
      approved: false,
      updatedAt: now,
    });

    // Decoupled background scheduling to push blockchain anchoring to worker queue
    await ctx.scheduler.runAfter(0, internal.blockchainActions.approveUserOnBlockchain, {
      userId: newUserId,
      role: args.role,
      name: fullName,
    });

    return newUserId;
  },
});

export const updateBlockchainStatus = mutation({
  args: { userId: v.id("users"), txHash: v.string(), blockNumber: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      blockchainVerified: true,
      txHash: args.txHash,
      blockNumber: args.blockNumber,
      verificationStatus: "approved",
      approved: true,
    });
    console.log(`[Database Sync] Successfully updated user ${args.userId} with Tx Hash: ${args.txHash}`);
  },
});

export const updateUserBlockchainStatus = internalMutation({
  args: {
    userId: v.string(),
    txHash: v.string(),
    blockNumber: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userDocId = ctx.db.normalizeId("users", args.userId);
    if (!userDocId) {
      console.warn(`[User Blockchain Sync] Invalid user ID: ${args.userId}`);
      return;
    }
    await ctx.db.patch(userDocId, {
      blockchainVerified: true,
      txHash: args.txHash,
      ...(args.blockNumber ? { blockNumber: args.blockNumber } : {}),
      verificationStatus: "approved",
      approved: true,
    });
    console.log(`[Database Sync] Successfully updated user ${args.userId} with Tx Hash: ${args.txHash}`);
  },
});

// 2. Store the Web Crypto public key + hasKeypair flag
export const updateProfileKeys = mutation({
  args: {
    id: v.id("users"),
    publicKey: v.string(),
    hasKeypair: v.boolean(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      publicKey: args.publicKey,
      hasKeypair: args.hasKeypair,
    });

    console.log(
      `🔒 Secure identity parameters successfully bound to user: ${args.id}`,
    );
  },
});

// 3. Lookup user by Email
export const getByEmail = query({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const cleanEmail = args.email.trim().toLowerCase();
    return await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", cleanEmail))
      .first();
  },
});

// 4. Lookup student user by Index Number (e.g. UEB3509022)
export const getByIndexNumber = query({
  args: { indexNumber: v.string() },
  handler: async (ctx, args) => {
    const cleanIndex = args.indexNumber.trim().toUpperCase();
    const byIndex = await ctx.db
      .query("users")
      .withIndex("by_indexNumber", (q) => q.eq("indexNumber", cleanIndex))
      .first();

    if (byIndex) return byIndex;

    // Fallback: search by idNumber
    return await ctx.db
      .query("users")
      .withIndex("by_idNumber", (q) => q.eq("idNumber", cleanIndex))
      .first();
  },
});

// 5. Lookup lecturer user by Staff ID (e.g. PS001, PS123)
export const getByStaffId = query({
  args: { staffId: v.string() },
  handler: async (ctx, args) => {
    const cleanStaffId = args.staffId.trim().toUpperCase();
    const byStaff = await ctx.db
      .query("users")
      .withIndex("by_staffId", (q) => q.eq("staffId", cleanStaffId))
      .first();

    if (byStaff) return byStaff;

    // Fallback: search by idNumber
    return await ctx.db
      .query("users")
      .withIndex("by_idNumber", (q) => q.eq("idNumber", cleanStaffId))
      .first();
  },
});

// 6. Generic lookup by ID Number (student index or lecturer staffId)
export const getByIdNumber = query({
  args: { idNumber: v.string() },
  handler: async (ctx, args) => {
    const cleanId = args.idNumber.trim().toUpperCase();
    return await ctx.db
      .query("users")
      .withIndex("by_idNumber", (q) => q.eq("idNumber", cleanId))
      .first();
  },
});
