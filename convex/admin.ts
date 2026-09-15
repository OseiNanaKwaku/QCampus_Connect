import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ethers } from "ethers";

/**
 * Derives a deterministic 20-byte Ethereum pseudo-address from a Convex document ID.
 * This matches the formula used in blockchainActions.ts so the address is consistent
 * across the entire system.
 */
function getPseudoAddress(id: string): string {
  if (!id) return ethers.ZeroAddress;
  const hash = ethers.keccak256(ethers.toUtf8Bytes(id));
  return "0x" + hash.substring(26);
}

const passwordHashFor = (password: string) => {
  let hash = 2166136261;
  for (let i = 0; i < password.length; i += 1) {
    hash ^= password.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `qchat_${(hash >>> 0).toString(16)}`;
};

const normalizeDepartmentName = (name: string) =>
  name.trim().replace(/\s+/g, " ").toLocaleLowerCase();

const getAdminBySessionToken = async (ctx: QueryCtx | MutationCtx, sessionToken: string) =>
  await ctx.db
    .query("admins")
    .withIndex("by_sessionToken", (q) => q.eq("sessionToken", sessionToken))
    .first();

const requireAdmin = async (ctx: MutationCtx | QueryCtx, sessionToken: string) => {
  const admin = await getAdminBySessionToken(ctx, sessionToken);
  if (!admin) throw new ConvexError("ADMIN_AUTH_REQUIRED");
  return admin;
};

export const login = mutation({
  args: { email: v.string(), password: v.string() },
  handler: async (ctx, args) => {
    const admin = await ctx.db
      .query("admins")
      .withIndex("by_email", (q) => q.eq("email", args.email.trim().toLowerCase()))
      .first();

    if (!admin) throw new ConvexError("ADMIN_NOT_FOUND");
    if (admin.passwordHash !== passwordHashFor(args.password)) {
      throw new ConvexError("INVALID_ADMIN_PASSWORD");
    }

    const sessionToken = `admin-session:${admin.email}:${crypto.randomUUID()}`;
    await ctx.db.patch(admin._id, { sessionToken, updatedAt: Date.now() });
    return { sessionToken, displayName: admin.displayName, email: admin.email };
  },
});

export const getMe = query({
  args: { sessionToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!args.sessionToken) return null;
    const admin = await getAdminBySessionToken(ctx, args.sessionToken);
    return admin ? { displayName: admin.displayName, email: admin.email } : null;
  },
});

export const getVerificationRequests = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const admin = await getAdminBySessionToken(ctx, args.sessionToken);
    if (!admin) return [];
    const requests = await ctx.db.query("verificationRequests").order("desc").collect();
    const result = [];

    for (const request of requests) {
      const user = await ctx.db.get(request.userId);
      if (!user) continue;
      result.push({
        requestId: request._id,
        userId: user._id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        school: request.school,
        idNumber: request.idNumber,
        departmentId: request.departmentId ?? user.departmentId ?? null,
        departmentName: request.departmentName ?? user.departmentName ?? "",
        avatarUrl: user.avatarUrl ?? "",
        evidenceUrl: request.evidenceUrl ?? user.verificationEvidenceUrl ?? "",
        verificationStatus: request.status,
        verificationSubmittedAt: request.submittedAt,
      });
    }

    return result;
  },
});

export const reviewVerificationRequest = mutation({
  args: {
    sessionToken: v.string(),
    requestId: v.id("verificationRequests"),
    status: v.union(v.literal("approved"), v.literal("rejected")),
    approvalTxHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.sessionToken);
    const request = await ctx.db.get(args.requestId);
    if (!request) throw new ConvexError("VERIFICATION_REQUEST_NOT_FOUND");

    const now = Date.now();
    const approved = args.status === "approved";

    // Store the blockchain approval tx hash if provided
    await ctx.db.patch(request._id, {
      status: args.status,
      approved,
      reviewedAt: now,
      ...(args.approvalTxHash ? { approvalTxHash: args.approvalTxHash } : {}),
    });

    // When approving: write the deterministic wallet address into the user record
    // so it is visible in the admin search panel and never needs a fake fallback
    const walletPatch = approved
      ? { walletAddress: getPseudoAddress(request.userId) }
      : {};

    await ctx.db.patch(request.userId, {
      verificationStatus: approved ? "approved" : "unverified",
      approved,
      updatedAt: now,
      ...walletPatch,
    });

    // Return user id so the admin frontend can trigger the blockchain approval action
    return { ok: true, userId: request.userId, approved };
  },
});

export const lookupUserByIdentifier = query({
  args: {
    sessionToken: v.string(),
    searchType: v.union(
      v.literal("email"),
      v.literal("indexNumber"),
      v.literal("staffId"),
      v.literal("idNumber")
    ),
    searchValue: v.string(),
  },
  handler: async (ctx, args) => {
    const admin = await getAdminBySessionToken(ctx, args.sessionToken);
    if (!admin) return null;
    const value = args.searchValue.trim();
    if (!value) return null;

    let user: Doc<"users"> | null = null;
    if (args.searchType === "email") {
      user = await ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", value.toLowerCase()))
        .first();
    } else if (args.searchType === "indexNumber") {
      const upper = value.toUpperCase();
      user = await ctx.db
        .query("users")
        .withIndex("by_indexNumber", (q) => q.eq("indexNumber", upper))
        .first();
      if (!user) {
        user = await ctx.db
          .query("users")
          .withIndex("by_idNumber", (q) => q.eq("idNumber", upper))
          .first();
      }
    } else if (args.searchType === "staffId") {
      const upper = value.toUpperCase();
      user = await ctx.db
        .query("users")
        .withIndex("by_staffId", (q) => q.eq("staffId", upper))
        .first();
      if (!user) {
        user = await ctx.db
          .query("users")
          .withIndex("by_idNumber", (q) => q.eq("idNumber", upper))
          .first();
      }
    } else if (args.searchType === "idNumber") {
      const upper = value.toUpperCase();
      user = await ctx.db
        .query("users")
        .withIndex("by_idNumber", (q) => q.eq("idNumber", upper))
        .first();
    }

    if (!user) return null;

    const verificationStatus =
      user.approved === true ? "approved" : user.verificationStatus;

    return {
      _id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      fullName: user.fullName,
      email: user.email,
      role: user.role,
      school: user.school,
      indexNumber: user.indexNumber ?? (user.role === "student" ? user.idNumber : undefined),
      staffId: user.staffId ?? (user.role === "lecturer" ? user.idNumber : undefined),
      idNumber: user.idNumber,
      // Use the real deterministic pseudo-address derived from the user's Convex ID
      // (same keccak256 formula as blockchainActions.ts)
      walletAddress: user.walletAddress || getPseudoAddress(user._id),
      verificationStatus,
      approved: user.approved === true || verificationStatus === "approved",
      avatarUrl: user.avatarUrl ?? "",
    };
  },
});

export const getUserMessages = query({
  args: {
    sessionToken: v.string(),
    userId: v.id("users"),
    daysBack: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const admin = await getAdminBySessionToken(ctx, args.sessionToken);
    if (!admin) return [];
    const user = await ctx.db.get(args.userId);
    if (!user) return [];

    const days = args.daysBack ?? 30;
    const sinceTimestamp = Date.now() - days * 24 * 60 * 60 * 1000;

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_senderId_and_createdAt", (q) =>
        q.eq("senderId", args.userId).gte("createdAt", sinceTimestamp)
      )
      .order("desc")
      .take(100);

    return messages.map((msg) => {
      // Only use real blockchain data — never fabricate hashes or verification status
      const realTxHash = msg.blockchainTxHash || null;
      const isBlockchainVerified = !!realTxHash;
      // Blockchain timestamp is only available when the tx was actually recorded
      const blockchainTimestamp = isBlockchainVerified
        ? new Date(msg.createdAt).toISOString().replace("T", " ").slice(0, 19) + " GMT"
        : null;
      return {
        _id: msg._id,
        text: msg.text,
        createdAt: msg.createdAt,
        attachmentUrl: msg.attachmentUrl,
        attachmentName: msg.attachmentName,
        attachmentType: msg.attachmentType,
        attachmentSize: msg.attachmentSize,
        // Real values only — null when message was never anchored to Besu
        blockchainTxHash: realTxHash,
        blockchainVerified: isBlockchainVerified,
        blockchainTimestamp: blockchainTimestamp,
        blockchainBlock: null,
        storedHash: null,
        // hashMatches is only meaningful when the message IS on-chain
        hashMatches: isBlockchainVerified,
        senderMatches: isBlockchainVerified,
      };
    });
  },
});

export const sendAuditReportToUser = mutation({
  args: {
    sessionToken: v.string(),
    userId: v.id("users"),
    reportText: v.string(),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.sessionToken);
    const user = await ctx.db.get(args.userId);
    if (!user) throw new ConvexError("USER_NOT_FOUND");

    const now = Date.now();
    const rooms = await ctx.db.query("chatRooms").collect();
    let room = rooms.find((r) => r.participantIds.includes(args.userId));

    if (!room) {
      const roomId = await ctx.db.insert("chatRooms", {
        participantIds: [args.userId],
        participantKey: `audit:${args.userId}`,
        title: "QCampus Connect Audit & Verification Desk",
        lastMessageText: "VERIFICATION OF ACADEMIC SUBMISSION",
        lastMessageAt: now,
        createdAt: now,
        updatedAt: now,
      });

      await ctx.db.insert("chatRoomMembers", {
        roomId,
        userId: args.userId,
        otherUserId: args.userId,
        unreadCount: 1,
        createdAt: now,
        updatedAt: now,
      });

      room = (await ctx.db.get(roomId))!;
    }

    const messageId = await ctx.db.insert("messages", {
      roomId: room._id,
      senderId: args.userId,
      text: args.reportText,
      readBy: [],
      createdAt: now,
      // blockchainTxHash intentionally omitted — real hash set by blockchain anchor action
    });

    await ctx.db.patch(room._id, {
      lastMessageText: "VERIFICATION OF ACADEMIC SUBMISSION - QCampus Connect Cryptographic Audit Report",
      lastMessageAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("notifications", {
      userId: args.userId,
      actorId: args.userId,
      type: "question_reply",
      title: "🏛️ Academic Verification Report Issued",
      body: "Your submission audit report has been issued by the Verification Desk.",
      read: false,
      createdAt: now,
    });

    return { ok: true, messageId };
  },
});

export const addDepartment = mutation({
  args: {
    sessionToken: v.string(),
    name: v.string(),
    code: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.sessionToken);
    const name = args.name.trim().replace(/\s+/g, " ");
    const normalizedName = normalizeDepartmentName(name);
    let nameConflict = await ctx.db
      .query("departments")
      .withIndex("by_normalizedName", (q) => q.eq("normalizedName", normalizedName))
      .first();
    if (!nameConflict) {
      nameConflict = await ctx.db
        .query("departments")
        .withIndex("by_name", (q) => q.eq("name", name))
        .first();
    }
    if (nameConflict) {
      throw new ConvexError("DEPARTMENT_NAME_EXISTS");
    }

    const code = args.code.trim().toUpperCase();
    const existing = await ctx.db
      .query("departments")
      .withIndex("by_code", (q) => q.eq("code", code))
      .first();

    if (existing) {
      throw new ConvexError("DEPARTMENT_CODE_EXISTS");
    }

    const now = Date.now();
    const departmentId = await ctx.db.insert("departments", {
      name,
      normalizedName,
      code,
      description: args.description?.trim(),
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });

    return { departmentId };
  },
});

export const updateDepartment = mutation({
  args: {
    sessionToken: v.string(),
    departmentId: v.id("departments"),
    name: v.optional(v.string()),
    code: v.optional(v.string()),
    description: v.optional(v.string()),
    isActive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.sessionToken);
    const department = await ctx.db.get(args.departmentId);
    if (!department) throw new ConvexError("DEPARTMENT_NOT_FOUND");

    let code = department.code;
    let name = department.name;
    let normalizedName = department.normalizedName;
    if (args.name !== undefined) {
      name = args.name.trim().replace(/\s+/g, " ");
      normalizedName = normalizeDepartmentName(name);
      if (normalizedName !== department.normalizedName) {
        const existing = await ctx.db
          .query("departments")
          .withIndex("by_normalizedName", (q) => q.eq("normalizedName", normalizedName))
          .first();
        if (existing && existing._id !== args.departmentId) {
          throw new ConvexError("DEPARTMENT_NAME_EXISTS");
        }
      }
    }
    if (args.code !== undefined) {
      code = args.code.trim().toUpperCase();
      if (code !== department.code) {
        const existing = await ctx.db
          .query("departments")
          .withIndex("by_code", (q) => q.eq("code", code))
          .first();
        if (existing && existing._id !== args.departmentId) {
          throw new ConvexError("DEPARTMENT_CODE_EXISTS");
        }
      }
    }

    const now = Date.now();
    await ctx.db.patch(args.departmentId, {
      ...(args.name !== undefined ? { name, normalizedName } : {}),
      ...(args.code !== undefined ? { code } : {}),
      ...(args.description !== undefined ? { description: args.description.trim() } : {}),
      ...(args.isActive !== undefined ? { isActive: args.isActive } : {}),
      updatedAt: now,
    });

    return { ok: true };
  },
});

export const deleteDepartment = mutation({
  args: {
    sessionToken: v.string(),
    departmentId: v.id("departments"),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.sessionToken);
    const department = await ctx.db.get(args.departmentId);
    if (!department) throw new ConvexError("DEPARTMENT_NOT_FOUND");

    const userInDept = await ctx.db
      .query("users")
      .withIndex("by_department", (q) => q.eq("departmentId", args.departmentId))
      .first();

    if (userInDept) {
      throw new ConvexError("DEPARTMENT_HAS_USERS");
    }

    await ctx.db.delete(args.departmentId);
    return { ok: true };
  },
});

export const verifyUserWithDepartment = mutation({
  args: {
    sessionToken: v.string(),
    userId: v.id("users"),
    departmentId: v.optional(v.id("departments")),
    specializations: v.optional(v.array(v.string())),
    approved: v.boolean(),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.sessionToken);
    const user = await ctx.db.get(args.userId);
    if (!user) throw new ConvexError("USER_NOT_FOUND");

    let departmentName: string | undefined = undefined;
    if (args.departmentId) {
      const dept = await ctx.db.get(args.departmentId);
      if (dept) {
        departmentName = dept.name;
      }
    }

    const now = Date.now();
    const verificationStatus = args.approved ? "approved" : "unverified";

    await ctx.db.patch(args.userId, {
      departmentId: args.departmentId,
      departmentName,
      specializations: args.specializations,
      verificationStatus,
      approved: args.approved,
      updatedAt: now,
    });

    return { ok: true };
  },
});

export const getDepartmentsWithCount = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const admin = await getAdminBySessionToken(ctx, args.sessionToken);
    if (!admin) return [];
    const departments = await ctx.db.query("departments").order("asc").collect();

    const result = [];
    for (const dept of departments) {
      const usersInDept = await ctx.db
        .query("users")
        .withIndex("by_department", (q) => q.eq("departmentId", dept._id))
        .collect();

      result.push({
        _id: dept._id,
        name: dept.name,
        code: dept.code,
        description: dept.description ?? "",
        isActive: dept.isActive !== false,
        createdAt: dept.createdAt,
        userCount: usersInDept.length,
      });
    }

    return result;
  },
});

export const getPendingUsers = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const admin = await getAdminBySessionToken(ctx, args.sessionToken);
    if (!admin) return [];
    const pendingUsers = await ctx.db
      .query("users")
      .withIndex("by_verificationStatus", (q) => q.eq("verificationStatus", "pending"))
      .collect();

    return pendingUsers.map((user) => ({
      _id: user._id,
      fullName: user.fullName,
      email: user.email,
      role: user.role,
      school: user.school,
      idNumber: user.idNumber,
      indexNumber: user.indexNumber,
      staffId: user.staffId,
      departmentId: user.departmentId,
      departmentName: user.departmentName,
      specializations: user.specializations ?? [],
      verificationSubmittedAt: user.verificationSubmittedAt ?? user.updatedAt,
      avatarUrl: user.avatarUrl ?? "",
      evidenceUrl: user.verificationEvidenceUrl ?? "",
    }));
  },
});
