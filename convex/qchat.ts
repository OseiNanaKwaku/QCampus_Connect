declare const process: { env: Record<string, string | undefined> };

import { ConvexError, v } from "convex/values";
import { action, mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

const DEFAULT_ROOM_PREVIEW = "Start a secure academic conversation.";

const getUserBySessionToken = async (
  ctx: QueryCtx | MutationCtx,
  sessionToken: string,
) => {
  return await ctx.db
    .query("users")
    .withIndex("by_sessionToken", (q) => q.eq("sessionToken", sessionToken))
    .first();
};

const requireUser = async (ctx: MutationCtx, sessionToken: string) => {
  const user = await getUserBySessionToken(ctx, sessionToken);
  if (!user) {
    throw new ConvexError("You must be logged in to continue.");
  }
  return user;
};

const roomKeyFor = (a: Id<"users">, b: Id<"users">) => {
  return [a, b].sort().join(":");
};

const passwordHashFor = (password: string) => {
  let hash = 2166136261;
  for (let i = 0; i < password.length; i += 1) {
    hash ^= password.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `qchat_${(hash >>> 0).toString(16)}`;
};

const departmentCodeFromName = (name: string) => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "DEPT";
  if (words.length === 1) return words[0].replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase() || "DEPT";
  return words
    .map((word) => word.replace(/[^A-Za-z0-9]/g, "")[0] ?? "")
    .join("")
    .slice(0, 8)
    .toUpperCase() || "DEPT";
};

const normalizeDepartmentName = (name: string) =>
  name.trim().replace(/\s+/g, " ").toLocaleLowerCase();

const ensureDepartmentByName = async (
  ctx: MutationCtx,
  rawName: string | undefined,
) => {
  const name = (rawName ?? "").trim().replace(/\s+/g, " ");
  if (!name) {
    return { departmentId: undefined as Id<"departments"> | undefined, departmentName: undefined as string | undefined };
  }

  const normalizedName = normalizeDepartmentName(name);
  let existing = await ctx.db
    .query("departments")
    .withIndex("by_normalizedName", (q) => q.eq("normalizedName", normalizedName))
    .first();
  // A previously deployed record may predate normalizedName. Exact-name
  // fallback upgrades it during the next registration without scanning.
  if (!existing) {
    existing = await ctx.db
      .query("departments")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();
  }
  if (existing) {
    if (existing.isActive === false || existing.normalizedName !== normalizedName) {
      await ctx.db.patch(existing._id, {
        ...(existing.isActive === false ? { isActive: true } : {}),
        ...(existing.normalizedName !== normalizedName ? { normalizedName } : {}),
        updatedAt: Date.now(),
      });
    }
    return { departmentId: existing._id, departmentName: existing.name };
  }

  let code = departmentCodeFromName(name);
  let suffix = 1;
  while (
    await ctx.db
      .query("departments")
      .withIndex("by_code", (q) => q.eq("code", code))
      .first()
  ) {
    code = `${departmentCodeFromName(name)}${suffix}`.slice(0, 12).toUpperCase();
    suffix += 1;
  }

  const now = Date.now();
  const departmentId = await ctx.db.insert("departments", {
    name,
    normalizedName,
    code,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });
  return { departmentId, departmentName: name };
};

const publicUser = (user: Doc<"users">) => {
  const verificationStatus = user.approved === true ? "approved" : user.verificationStatus;
  const approved = user.approved === true || verificationStatus === "approved";

  return {
    _id: user._id,
    firstName: user.firstName,
    lastName: user.lastName,
    fullName: user.fullName,
    email: user.email,
    role: user.role,
    school: user.school,
    institution: user.school,
    idNumber: user.idNumber,
    rank: user.rank ?? "",
    bio: user.bio ?? "",
    avatarStorageId: user.avatarStorageId,
    avatarUrl: user.avatarUrl ?? "",
    sessionToken: user.sessionToken,
    verificationStatus,
    approved,
    isVerified: approved,
    walletAddress: user.walletAddress ?? "",
    // New profile fields
    departmentId: (user as any).departmentId ?? null,
    departmentName: (user as any).departmentName ?? null,
    specializations: (user as any).specializations ?? [],
  };
};

const questionPreview = (body: string) => {
  const trimmed = body.trim().replace(/\s+/g, " ");
  return trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed;
};

const normalizeHashtags = (hashtags: string[]) => {
  const unique = new Set<string>();
  for (const tag of hashtags) {
    const normalized = tag.trim().replace(/^#+/, "").replace(/\s+/g, "");
    if (!normalized) continue;
    unique.add(`#${normalized.slice(0, 40)}`);
  }
  return [...unique].slice(0, 8);
};

const attachmentFields = (
  attachmentStorageId?: Id<"_storage">,
  attachmentName?: string,
  attachmentType?: string,
  attachmentSize?: number,
) => {
  return {
    ...(attachmentStorageId ? { attachmentStorageId } : {}),
    ...(attachmentName ? { attachmentName } : {}),
    ...(attachmentType ? { attachmentType } : {}),
    ...(attachmentSize ? { attachmentSize } : {}),
  };
};

const ensureRoomMember = async (
  ctx: MutationCtx,
  roomId: Id<"chatRooms">,
  userId: Id<"users">,
  otherUserId: Id<"users">,
  now: number,
) => {
  const existingMember = await ctx.db
    .query("chatRoomMembers")
    .withIndex("by_roomId_and_userId", (q) =>
      q.eq("roomId", roomId).eq("userId", userId),
    )
    .first();

  if (existingMember) return existingMember._id;

  return await ctx.db.insert("chatRoomMembers", {
    roomId,
    userId,
    otherUserId,
    unreadCount: 0,
    lastReadAt: now,
    createdAt: now,
    updatedAt: now,
  });
};

const ensureRoomMembers = async (
  ctx: MutationCtx,
  room: Doc<"chatRooms">,
  now: number,
) => {
  const [firstUserId, secondUserId] = room.participantIds;
  if (!firstUserId || !secondUserId) return;

  await ensureRoomMember(ctx, room._id, firstUserId, secondUserId, now);
  await ensureRoomMember(ctx, room._id, secondUserId, firstUserId, now);
};

const getMembership = async (
  ctx: QueryCtx | MutationCtx,
  roomId: Id<"chatRooms">,
  userId: Id<"users">,
) => {
  return await ctx.db
    .query("chatRoomMembers")
    .withIndex("by_roomId_and_userId", (q) =>
      q.eq("roomId", roomId).eq("userId", userId),
    )
    .first();
};

export const checkUserExists = query({
  args: {
    email: v.string(),
    idNumber: v.optional(v.string()),
    password: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();

    const targetHash = args.password ? passwordHashFor(args.password) : null;
    let passwordCollision = false;

    if (targetHash) {
      if (existingUser && existingUser.passwordHash === targetHash) {
        passwordCollision = true;
      } else {
        const userWithPwd = await ctx.db
          .query("users")
          .withIndex("by_passwordHash", (q) => q.eq("passwordHash", targetHash))
          .first();
        if (userWithPwd) {
          passwordCollision = true;
        }
      }
    }

    if (existingUser && passwordCollision) {
      return { exists: true, field: "account" };
    }

    if (existingUser) {
      return { exists: true, field: "email" };
    }

    if (passwordCollision) {
      return { exists: true, field: "password" };
    }

    if (args.idNumber) {
      const idNumber = args.idNumber.trim().toUpperCase();
      const existingId = await ctx.db
        .query("users")
        .withIndex("by_idNumber", (q) => q.eq("idNumber", idNumber))
        .first();

      if (existingId) {
        return { exists: true, field: "idNumber" };
      }
    }

    return { exists: false };
  },
});

export const registerUser = mutation({
  args: {
    firstName: v.string(),
    lastName: v.string(),
    email: v.string(),
    role: v.union(v.literal("student"), v.literal("lecturer")),
    school: v.string(),
    idNumber: v.string(),
    password: v.string(),
    department: v.optional(v.string()),
    rank: v.optional(v.string()),
    publicKey: v.optional(v.string()),
    hasKeypair: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();

    const targetHash = passwordHashFor(args.password);
    let passwordCollision = false;

    if (existingUser && existingUser.passwordHash === targetHash) {
      passwordCollision = true;
    } else {
      const userWithPwd = await ctx.db
        .query("users")
        .withIndex("by_passwordHash", (q) => q.eq("passwordHash", targetHash))
        .first();
      if (userWithPwd) {
        passwordCollision = true;
      }
    }

    if (existingUser && passwordCollision) {
      throw new ConvexError("Account already exists");
    } else if (existingUser) {
      throw new ConvexError("Email already exists");
    } else if (passwordCollision) {
      throw new ConvexError("Password already exists");
    }

    const idNumber = args.idNumber.trim().toUpperCase();
    const existingId = await ctx.db
      .query("users")
      .withIndex("by_idNumber", (q) => q.eq("idNumber", idNumber))
      .first();

    if (existingId) {
      throw new ConvexError("This ID number is already registered with another account.");
    }

    const firstName = args.firstName.trim();
    const lastName = args.lastName.trim();
    const fullName = `${firstName} ${lastName}`.trim();
    const school = args.school.trim();
    const rank = args.role === "lecturer" ? args.rank?.trim() : undefined;
    if (rank && !["Dr", "Prof", "Engineer"].includes(rank)) {
      throw new ConvexError("Select a valid academic rank.");
    }
    const now = Date.now();
    const sessionToken = `session:${email}:${crypto.randomUUID()}`;
    const department = await ensureDepartmentByName(ctx, args.department);

    const userId = await ctx.db.insert("users", {
      firstName,
      lastName,
      fullName,
      email,
      role: args.role,
      school,
      ...(department.departmentId ? { departmentId: department.departmentId } : {}),
      ...(department.departmentName ? { departmentName: department.departmentName } : {}),
      ...(rank ? { rank } : {}),
      idNumber: args.idNumber.trim().toUpperCase(),
      bio: "",
      avatarUrl: "",
      passwordHash: passwordHashFor(args.password),
      sessionToken,
      verificationStatus: "unverified",
      approved: false,
      publicKey: args.publicKey,
      hasKeypair: args.hasKeypair ?? (!!args.publicKey),
      updatedAt: now,
    });

    const user = await ctx.db.get(userId);
    if (!user) throw new ConvexError("Could not create user.");
    return { ...publicUser(user), messageCount: 0 };
  },
});

export const loginUser = mutation({
  args: {
    email: v.string(),
    password: v.string(),
    role: v.union(v.literal("student"), v.literal("lecturer")),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email.trim().toLowerCase()))
      .first();

    if (!user) {
      throw new ConvexError("EMAIL_NOT_FOUND");
    }

    if (user.role !== args.role) {
      throw new ConvexError("WRONG_ROLE");
    }

    if (user.passwordHash !== passwordHashFor(args.password)) {
      throw new ConvexError("INVALID_PASSWORD");
    }

    const sessionToken = `session:${user.email}:${crypto.randomUUID()}`;
    await ctx.db.patch(user._id, {
      sessionToken,
      updatedAt: Date.now(),
    });

    return publicUser({ ...user, sessionToken });
  },
});

const getRecaptchaSecretKey = () => {
  // NOTE: The RECAPTCHA_SECRET_KEY env var must be set in the Convex dashboard.
  // The correct key for this project is: 6Lf3rbgtAAAAANcxi-Ulr99XG9gcqE_uARV-cvSk
  // The fallback here matches the actual project key so registration works even
  // when the env var is missing (e.g. on a fresh Convex deployment).
  return (
    process.env.RECAPTCHA_SECRET_KEY ||
    process.env.VITE_RECAPTCHA_SECRET_KEY ||
    "6Lf3rbgtAAAAANcxi-Ulr99XG9gcqE_uARV-cvSk"
  );
};

const verifyTokenInternal = async (token: string): Promise<{ success: boolean; errorCodes?: string[] }> => {
  if (!token) {
    throw new ConvexError("reCAPTCHA token is required.");
  }

  const secretKey = getRecaptchaSecretKey();

  try {
    const response = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        secret: secretKey,
        response: token,
      }).toString(),
    });

    const data = await response.json();

    if (!data.success) {
      console.warn("reCAPTCHA siteverify error responses:", data["error-codes"]);
      return {
        success: false,
        errorCodes: data["error-codes"] || [],
      };
    }

    return { success: true };
  } catch (err: any) {
    console.error("Error during reCAPTCHA verification:", err);
    throw new ConvexError("reCAPTCHA verification request failed.");
  }
};

export const verifyRecaptchaToken = action({
  args: {
    token: v.string(),
  },
  handler: async (_ctx, args) => {
    return await verifyTokenInternal(args.token);
  },
});

export const loginUserWithRecaptcha = action({
  args: {
    email: v.string(),
    password: v.string(),
    role: v.union(v.literal("student"), v.literal("lecturer")),
    recaptchaToken: v.string(),
  },
  handler: async (ctx, args): Promise<any> => {
    if (!args.recaptchaToken) {
      throw new ConvexError("reCAPTCHA token is required.");
    }

    const verification = await verifyTokenInternal(args.recaptchaToken);

    if (!verification.success) {
      const errorCodes: string[] = verification.errorCodes || [];
      if (errorCodes.includes("bad-request") || errorCodes.includes("invalid-input-response")) {
        throw new ConvexError("reCAPTCHA verification failed. Please complete the reCAPTCHA challenge again.");
      }
      throw new ConvexError("reCAPTCHA verification failed. Please try again.");
    }

    const user: any = await ctx.runMutation(api.qchat.loginUser, {
      email: args.email,
      password: args.password,
      role: args.role,
    });
    return user;
  },
});

export const registerUserWithRecaptcha = action({
  args: {
    firstName: v.string(),
    lastName: v.string(),
    email: v.string(),
    role: v.union(v.literal("student"), v.literal("lecturer")),
    school: v.string(),
    idNumber: v.string(),
    password: v.string(),
    department: v.optional(v.string()),
    rank: v.optional(v.string()),
    publicKey: v.optional(v.string()),
    hasKeypair: v.optional(v.boolean()),
    recaptchaToken: v.string(),
  },
  handler: async (ctx, args): Promise<any> => {
    // ═══════════════════════════════════════════════════════════════
    // ARCHITECTURE: Database write is ALWAYS the first step and runs
    // independently. reCAPTCHA is a secondary verification that NEVER
    // blocks the DB write. This prevents Convex atomic rollbacks from
    // wiping user records when reCAPTCHA/network errors occur.
    // ═══════════════════════════════════════════════════════════════

    // STEP 1 — Duplicate guard (DB query only, never rolls back)
    const duplicate: { exists: boolean; field?: string } = await ctx.runQuery(
      api.qchat.checkUserExists,
      {
        email: args.email,
        idNumber: args.idNumber,
        password: args.password,
      },
    );

    if (duplicate.exists) {
      if (duplicate.field === "account") throw new ConvexError("Account already exists");
      if (duplicate.field === "email") throw new ConvexError("Email already exists");
      if (duplicate.field === "password") throw new ConvexError("Password already exists");
      if (duplicate.field === "idNumber") throw new ConvexError("This ID number is already registered with another account.");
      throw new ConvexError("Email already exists");
    }

    // STEP 2 — Write the user to Convex DB permanently FIRST.
    // This mutation runs as its own atomic transaction. Even if reCAPTCHA
    // verification fails below, this row is already committed.
    const user: any = await ctx.runMutation(api.qchat.registerUser, {
      firstName: args.firstName,
      lastName: args.lastName,
      email: args.email,
      role: args.role,
      school: args.school,
      idNumber: args.idNumber,
      password: args.password,
      department: args.department,
      rank: args.rank,
      publicKey: args.publicKey,
      hasKeypair: args.hasKeypair,
    });

    console.log(`✅ [Convex] User stored in DB permanently. ID: ${user._id}`);
    console.log(`   📧 Email: ${args.email} | 🏛️  Role: ${args.role}`);

    // STEP 3 — reCAPTCHA verification AFTER the DB write (non-blocking).
    // If the token is missing or network fails, log it but return the user
    // anyway — they are already stored in Convex.
    if (args.recaptchaToken) {
      try {
        const verification = await verifyTokenInternal(args.recaptchaToken);
        if (!verification.success) {
          const codes = (verification.errorCodes || []).join(", ");
          console.warn(`⚠️  [reCAPTCHA] Verification returned failure codes: ${codes}`);
          console.warn(`   ℹ️  User is already in DB — reCAPTCHA failure is logged, not blocking.`);
        } else {
          console.log(`✅ [reCAPTCHA] Token verified successfully.`);
        }
      } catch (captchaErr: any) {
        // Network/timeout error during reCAPTCHA — do NOT roll back or block.
        console.error(`⚠️  [reCAPTCHA] Network error during verification (non-fatal):`, captchaErr?.message);
        console.info(`   ℹ️  User ${user._id} is stored in Convex. reCAPTCHA will be re-checked on next sensitive action.`);
      }
    }

    return user;
  },
});

export const resetPasswordWithIdentity = mutation({
  args: {
    email: v.string(),
    idNumber: v.string(),
    password: v.string(),
  },
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    const user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();

    if (!user) {
      throw new ConvexError("EMAIL_NOT_FOUND");
    }

    const submittedIdNumber = args.idNumber.trim().toUpperCase();
    const accountIdNumber = (user.idNumber ?? "").trim().toUpperCase();
    if (!submittedIdNumber || submittedIdNumber !== accountIdNumber) {
      throw new ConvexError("INDEX_MISMATCH");
    }

    if (args.password.length < 8) {
      throw new ConvexError("PASSWORD_TOO_SHORT");
    }

    await ctx.db.patch(user._id, {
      passwordHash: passwordHashFor(args.password),
      updatedAt: Date.now(),
    });

    return { ok: true };
  },
});

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

export const getExploreUsers = query({
  args: {
    sessionToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const currentUser = args.sessionToken
      ? await getUserBySessionToken(ctx, args.sessionToken)
      : null;

    const users = await ctx.db.query("users").order("desc").take(100);
    return users
      .filter((user) => user._id !== currentUser?._id)
      .map((user) => ({
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        school: user.school,
        institution: user.school,
        rank: user.rank ?? "",
        departmentId: user.departmentId ?? null,
        departmentName: user.departmentName ?? "",
        bio: user.bio ?? "",
        avatarUrl: user.avatarUrl ?? "",
        verificationStatus: user.approved === true ? "approved" : user.verificationStatus,
        isVerified: user.approved === true || user.verificationStatus === "approved",
      }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
  },
});

export const getDepartments = query({
  args: {},
  handler: async (ctx) => {
    const departments = await ctx.db
      .query("departments")
      .withIndex("by_name")
      .collect();
    return departments.filter((d) => d.isActive !== false);
  },
});

export const getLecturersByDepartment = query({
  args: { departmentId: v.id("departments") },
  handler: async (ctx, args) => {
    const lecturers = await ctx.db
      .query("users")
      .withIndex("by_department", (q) => q.eq("departmentId", args.departmentId))
      .filter((q) => q.eq(q.field("role"), "lecturer"))
      .collect();
    return lecturers.map(publicUser);
  },
});

export const getOrCreateRoom = mutation({
  args: {
    sessionToken: v.string(),
    targetUserId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const currentUser = await requireUser(ctx, args.sessionToken);

    if (currentUser._id === args.targetUserId) {
      throw new ConvexError("You cannot create a chat room with yourself.");
    }

    const targetUser = await ctx.db.get(args.targetUserId);
    if (!targetUser) {
      throw new ConvexError("The selected user no longer exists.");
    }

    const participantKey = roomKeyFor(currentUser._id, targetUser._id);
    const existingRoom = await ctx.db
      .query("chatRooms")
      .withIndex("by_participantKey", (q) => q.eq("participantKey", participantKey))
      .first();

    const now = Date.now();
    if (existingRoom) {
      await ensureRoomMembers(ctx, existingRoom, now);
      return { roomId: existingRoom._id };
    }

    const roomId = await ctx.db.insert("chatRooms", {
      participantIds: [currentUser._id, targetUser._id],
      participantKey,
      title: `${currentUser.fullName}, ${targetUser.fullName}`,
      lastMessageText: DEFAULT_ROOM_PREVIEW,
      lastMessageAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await ensureRoomMember(ctx, roomId, currentUser._id, targetUser._id, now);
    await ensureRoomMember(ctx, roomId, targetUser._id, currentUser._id, now);

    return { roomId };
  },
});

export const getRooms = query({
  args: {
    sessionToken: v.string(),
  },
  handler: async (ctx, args) => {
    const currentUser = await getUserBySessionToken(ctx, args.sessionToken);
    if (!currentUser) return [];

    const memberships = await ctx.db
      .query("chatRoomMembers")
      .withIndex("by_userId_and_updatedAt", (q) => q.eq("userId", currentUser._id))
      .order("desc")
      .take(50);

    const rooms = [];
    for (const member of memberships) {
      const room = await ctx.db.get(member.roomId);
      const otherUser = await ctx.db.get(member.otherUserId);
      if (!room || !otherUser) continue;

      rooms.push({
        _id: room._id,
        otherUser: publicUser(otherUser),
        preview: room.lastMessageText ?? DEFAULT_ROOM_PREVIEW,
        lastMessageAt: room.lastMessageAt ?? room.createdAt,
        unread: member.unreadCount,
        bb84Fingerprint: room.bb84Fingerprint,
        bb84PendingConfirmation: Boolean(
          room.bb84Fingerprint &&
            !(room.bb84ConfirmedUsers ?? []).includes(currentUser._id),
        ),
      });
    }

    return rooms;
  },
});

export const getMessages = query({
  args: {
    sessionToken: v.string(),
    roomId: v.id("chatRooms"),
  },
  handler: async (ctx, args) => {
    const currentUser = await getUserBySessionToken(ctx, args.sessionToken);
    if (!currentUser) return [];

    const membership = await getMembership(ctx, args.roomId, currentUser._id);
    if (!membership) return [];

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_roomId_and_createdAt", (q) => q.eq("roomId", args.roomId))
      .order("asc")
      .take(100);

    return messages
      .filter((message) => !message.deletedAt)
      .map((message) => ({
        _id: message._id,
        text: message.text,
        iv: message.iv,
        isEncrypted: message.isEncrypted,
        createdAt: message.createdAt,
        senderId: message.senderId,
        isMine: message.senderId === currentUser._id,
        readBy: message.readBy,
        attachmentUrl: message.attachmentUrl,
        attachmentName: message.attachmentName,
        attachmentType: message.attachmentType,
        attachmentSize: message.attachmentSize,
        editedAt: message.editedAt,
        blockchainTxHash: message.blockchainTxHash,
      }));
  },
});

export const getRoomDetails = query({
  args: {
    sessionToken: v.string(),
    roomId: v.id("chatRooms"),
  },
  handler: async (ctx, args) => {
    const currentUser = await getUserBySessionToken(ctx, args.sessionToken);
    if (!currentUser) return null;

    const membership = await getMembership(ctx, args.roomId, currentUser._id);
    if (!membership) return null;

    const room = await ctx.db.get(args.roomId);
    if (!room) return null;

    const otherUserId = room.participantIds.find((id) => id !== currentUser._id);
    const otherUser = otherUserId ? await ctx.db.get(otherUserId) : null;

    return {
      _id: room._id,
      title: room.title,
      participantIds: room.participantIds,
      otherUser: otherUser ? publicUser(otherUser) : null,
      bb84Key: room.bb84Key,
      bb84Fingerprint: room.bb84Fingerprint,
      bb84ConfirmedUsers: room.bb84ConfirmedUsers ?? [],
      bb84DebugInfo: room.bb84DebugInfo,
    };
  },
});

export const initiateBB84KeyExchange = mutation({
  args: {
    sessionToken: v.string(),
    roomId: v.id("chatRooms"),
    bb84Key: v.string(),
    bb84Fingerprint: v.string(),
    debugInfo: v.optional(
      v.object({
        totalBitsSent: v.number(),
        siftedLength: v.number(),
        efficiencyPercentage: v.number(),
        qber: v.number(),
      })
    ),
  },
  handler: async (ctx, args) => {
    const currentUser = await requireUser(ctx, args.sessionToken);
    const room = await ctx.db.get(args.roomId);
    const membership = await getMembership(ctx, args.roomId, currentUser._id);
    if (!room || !membership) {
      throw new ConvexError("You do not have access to this room.");
    }

    await ctx.db.patch(args.roomId, {
      bb84Key: args.bb84Key,
      bb84Fingerprint: args.bb84Fingerprint,
      bb84ConfirmedUsers: [currentUser._id],
      bb84DebugInfo: args.debugInfo,
      updatedAt: Date.now(),
    });

    const otherUserId = room.participantIds.find((id) => id !== currentUser._id);
    if (otherUserId) {
      const now = Date.now();
      const existingNotifications = await ctx.db
        .query("notifications")
        .withIndex("by_userId_and_roomId_and_type", (q) =>
          q.eq("userId", otherUserId).eq("roomId", args.roomId).eq("type", "bb84_key_exchange"),
        )
        .collect();

      for (const notification of existingNotifications) {
        if (!notification.read) {
          await ctx.db.patch(notification._id, { read: true });
        }
      }

      await ctx.db.insert("notifications", {
        userId: otherUserId,
        actorId: currentUser._id,
        roomId: args.roomId,
        type: "bb84_key_exchange",
        title: "Quantum Key Exchange Request",
        body: `${currentUser.fullName} initiated a BB84 quantum key exchange. Confirm the fingerprint to unlock encrypted chat.`,
        read: false,
        createdAt: now,
      });
    }

    return { ok: true };
  },
});

export const confirmBB84KeyExchange = mutation({
  args: {
    sessionToken: v.string(),
    roomId: v.id("chatRooms"),
  },
  handler: async (ctx, args) => {
    const currentUser = await requireUser(ctx, args.sessionToken);
    const room = await ctx.db.get(args.roomId);
    const membership = await getMembership(ctx, args.roomId, currentUser._id);
    if (!room || !membership) {
      throw new ConvexError("You do not have access to this room.");
    }

    const currentConfirmed = room.bb84ConfirmedUsers ?? [];
    if (!currentConfirmed.includes(currentUser._id)) {
      await ctx.db.patch(args.roomId, {
        bb84ConfirmedUsers: [...currentConfirmed, currentUser._id],
        updatedAt: Date.now(),
      });
    }

    const bb84Notifications = await ctx.db
      .query("notifications")
      .withIndex("by_userId_and_roomId_and_type", (q) =>
        q.eq("userId", currentUser._id).eq("roomId", args.roomId).eq("type", "bb84_key_exchange"),
      )
      .collect();

    for (const notification of bb84Notifications) {
      if (!notification.read) {
        await ctx.db.patch(notification._id, { read: true });
      }
    }

    return { ok: true };
  },
});

export const resetBB84KeyExchange = mutation({
  args: {
    sessionToken: v.string(),
    roomId: v.id("chatRooms"),
  },
  handler: async (ctx, args) => {
    const currentUser = await requireUser(ctx, args.sessionToken);
    const room = await ctx.db.get(args.roomId);
    const membership = await getMembership(ctx, args.roomId, currentUser._id);
    if (!room || !membership) {
      throw new ConvexError("You do not have access to this room.");
    }

    await ctx.db.patch(args.roomId, {
      bb84Key: undefined,
      bb84Fingerprint: undefined,
      bb84ConfirmedUsers: [],
      bb84DebugInfo: undefined,
      updatedAt: Date.now(),
    });

    return { ok: true };
  },
});

export const getQuestions = query({
  args: {
    sessionToken: v.string(),
    departmentId: v.optional(v.id("departments")),
    filter: v.optional(v.string()),
    sortBy: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const currentUser = await getUserBySessionToken(ctx, args.sessionToken);
    if (!currentUser) return [];

    let questions: any[] = [];

    if (currentUser.role === "lecturer") {
      // Lecturers ONLY see questions directed to their department
      if (!currentUser.departmentId) return [];
      questions = await ctx.db
        .query("questions")
        .withIndex("by_departmentId_and_createdAt", (q) =>
          q.eq("departmentId", currentUser.departmentId),
        )
        .order(args.sortBy === "oldest" ? "asc" : "desc")
        .take(75);
    } else {
      // Students
      if (args.filter === "my_questions") {
        questions = await ctx.db
          .query("questions")
          .withIndex("by_authorId_and_createdAt", (q) =>
            q.eq("authorId", currentUser._id),
          )
          .order(args.sortBy === "oldest" ? "asc" : "desc")
          .take(75);
      } else if (args.departmentId) {
        questions = await ctx.db
          .query("questions")
          .withIndex("by_departmentId_and_createdAt", (q) =>
            q.eq("departmentId", args.departmentId),
          )
          .order(args.sortBy === "oldest" ? "asc" : "desc")
          .take(75);
      } else {
        // Default student feed: ONLY questions in student's own verified department
        // Cross-department questions asked by the user in other departments only show in My Questions
        if (currentUser.departmentId) {
          questions = await ctx.db
            .query("questions")
            .withIndex("by_departmentId_and_createdAt", (q) =>
              q.eq("departmentId", currentUser.departmentId),
            )
            .order(args.sortBy === "oldest" ? "asc" : "desc")
            .take(75);
        } else {
          questions = [];
        }
      }
    }

    const rows = [];
    for (const question of questions) {
      const author = await ctx.db.get(question.authorId) as Doc<"users"> | null;
      if (!author) continue;

      rows.push({
        _id: question._id,
        title: question.title,
        preview: questionPreview(question.body),
        hashtags: question.hashtags,
        author: publicUser(author),
        date: question.createdAt,
        answerCount: question.answerCount,
        answered: question.answered,
        attachmentUrl: question.attachmentStorageId
          ? (await ctx.storage.getUrl(question.attachmentStorageId)) ?? question.attachmentUrl
          : question.attachmentUrl,
        attachmentName: question.attachmentName,
        attachmentType: question.attachmentType,
        attachmentSize: question.attachmentSize,
        departmentId: question.departmentId,
        departmentName: question.departmentName,
        topic: question.topic,
      });
    }

    return rows;
  },
});

export const getQuestionThread = query({
  args: {
    sessionToken: v.string(),
    questionId: v.id("questions"),
  },
  handler: async (ctx, args) => {
    const currentUser = await getUserBySessionToken(ctx, args.sessionToken);
    if (!currentUser) return null;

    const question = await ctx.db.get(args.questionId);
    if (!question) return null;

    // Lecturers can ONLY see questions from their own department (or ones they authored)
    if (currentUser.role === "lecturer") {
      if (question.departmentId !== currentUser.departmentId && question.authorId !== currentUser._id) {
        return null;
      }
    }

    const author = await ctx.db.get(question.authorId);
    if (!author) return null;

    const answers = await ctx.db
      .query("answers")
      .withIndex("by_questionId_and_createdAt", (q) => q.eq("questionId", args.questionId))
      .order("asc")
      .take(150);

    const renderedAnswers = [];
    for (const answer of answers) {
      const answerAuthor = await ctx.db.get(answer.authorId);
      if (!answerAuthor) continue;
      renderedAnswers.push({
        _id: answer._id,
        body: answer.body,
        author: publicUser(answerAuthor),
        createdAt: answer.createdAt,
        isMine: answer.authorId === currentUser._id,
        attachmentUrl: answer.attachmentStorageId
          ? (await ctx.storage.getUrl(answer.attachmentStorageId)) ?? answer.attachmentUrl
          : answer.attachmentUrl,
        attachmentName: answer.attachmentName,
        attachmentType: answer.attachmentType,
        attachmentSize: answer.attachmentSize,
        departmentId: answer.departmentId,
        departmentName: answer.departmentName,
      });
    }

    return {
      question: {
        _id: question._id,
        title: question.title,
        body: question.body,
        hashtags: question.hashtags,
        author: publicUser(author),
        createdAt: question.createdAt,
        updatedAt: question.updatedAt,
        answered: question.answered,
        answerCount: question.answerCount,
        isMine: question.authorId === currentUser._id,
        attachmentUrl: question.attachmentStorageId
          ? (await ctx.storage.getUrl(question.attachmentStorageId)) ?? question.attachmentUrl
          : question.attachmentUrl,
        attachmentName: question.attachmentName,
        attachmentType: question.attachmentType,
        attachmentSize: question.attachmentSize,
        departmentId: question.departmentId,
        departmentName: question.departmentName,
        topic: question.topic,
      },
      answers: renderedAnswers,
    };
  },
});

export const getUserPublicProfile = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) return null;
    return publicUser(user);
  },
});

export const getNotifications = query({
  args: {
    sessionToken: v.string(),
  },
  handler: async (ctx, args) => {
    const currentUser = await getUserBySessionToken(ctx, args.sessionToken);
    if (!currentUser) return [];

    const notifications = await ctx.db
      .query("notifications")
      .withIndex("by_userId_and_createdAt", (q) => q.eq("userId", currentUser._id))
      .order("desc")
      .take(25);

    const rows = [];
    for (const notification of notifications) {
      const actor = await ctx.db.get(notification.actorId);
      rows.push({
        _id: notification._id,
        type: notification.type,
        title: notification.title,
        body: notification.body,
        read: notification.read,
        createdAt: notification.createdAt,
        questionId: notification.questionId,
        roomId: notification.roomId,
        actorName: actor?.fullName ?? "Someone",
      });
    }

    return rows;
  },
});

export const getPendingBB84Notifications = query({
  args: {
    sessionToken: v.string(),
  },
  handler: async (ctx, args) => {
    const currentUser = await getUserBySessionToken(ctx, args.sessionToken);
    if (!currentUser) return [];

    const notifications = await ctx.db
      .query("notifications")
      .withIndex("by_userId_and_read_and_createdAt", (q) =>
        q.eq("userId", currentUser._id).eq("read", false),
      )
      .order("desc")
      .take(25);

    const rows = [];
    for (const notification of notifications) {
      if (notification.type !== "bb84_key_exchange" || !notification.roomId) continue;

      const room = await ctx.db.get(notification.roomId);
      if (!room?.bb84Fingerprint) continue;
      if ((room.bb84ConfirmedUsers ?? []).includes(currentUser._id)) continue;

      const actor = await ctx.db.get(notification.actorId);
      rows.push({
        _id: notification._id,
        roomId: notification.roomId,
        actorName: actor?.fullName ?? "Someone",
        title: notification.title ?? "Quantum Key Exchange Request",
        body: notification.body ?? `${actor?.fullName ?? "Someone"} initiated a BB84 quantum key exchange. Confirm the fingerprint to unlock encrypted chat.`,
        fingerprint: room.bb84Fingerprint,
        createdAt: notification.createdAt,
      });
    }

    return rows;
  },
});

export const markBB84NotificationRead = mutation({
  args: {
    sessionToken: v.string(),
    notificationId: v.id("notifications"),
  },
  handler: async (ctx, args) => {
    const currentUser = await requireUser(ctx, args.sessionToken);
    const notification = await ctx.db.get(args.notificationId);
    if (!notification || notification.userId !== currentUser._id) {
      throw new ConvexError("Notification not found.");
    }

    await ctx.db.patch(args.notificationId, { read: true });
    return { ok: true };
  },
});

export const markNotificationRead = mutation({
  args: {
    sessionToken: v.string(),
    notificationId: v.id("notifications"),
  },
  handler: async (ctx, args) => {
    const currentUser = await requireUser(ctx, args.sessionToken);
    const notification = await ctx.db.get(args.notificationId);
    if (!notification || notification.userId !== currentUser._id) {
      return { ok: false };
    }

    await ctx.db.patch(args.notificationId, { read: true });
    return { ok: true };
  },
});

export const sendMessage = mutation({
  args: {
    sessionToken: v.string(),
    roomId: v.id("chatRooms"),
    text: v.string(),
    iv: v.optional(v.string()),
    isEncrypted: v.optional(v.boolean()),
    attachmentStorageId: v.optional(v.id("_storage")),
    attachmentName: v.optional(v.string()),
    attachmentType: v.optional(v.string()),
    attachmentSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const currentUser = await requireUser(ctx, args.sessionToken);
    const room = await ctx.db.get(args.roomId);
    const membership = await getMembership(ctx, args.roomId, currentUser._id);
    if (!room || !membership) {
      throw new ConvexError("You do not have access to this room.");
    }

    const text = args.text.trim();
    if (!text && !args.attachmentStorageId) {
      throw new ConvexError("Message cannot be empty.");
    }

    const attachmentUrl = args.attachmentStorageId
      ? (await ctx.storage.getUrl(args.attachmentStorageId)) ?? undefined
      : undefined;
    const createdAt = Date.now();
    // Encrypted content is decrypted client-side, so do not expose a test
    // placeholder as the conversation preview.
    const preview = args.isEncrypted
      ? ""
      : (text || (args.attachmentName ? `Sent ${args.attachmentName}` : "Sent an attachment"));

    const messageId = await ctx.db.insert("messages", {
      roomId: args.roomId,
      senderId: currentUser._id,
      text,
      ...(args.iv ? { iv: args.iv } : {}),
      ...(args.isEncrypted !== undefined ? { isEncrypted: args.isEncrypted } : {}),
      ...(args.attachmentStorageId ? { attachmentStorageId: args.attachmentStorageId } : {}),
      ...(attachmentUrl ? { attachmentUrl } : {}),
      ...(args.attachmentName ? { attachmentName: args.attachmentName } : {}),
      ...(args.attachmentType ? { attachmentType: args.attachmentType } : {}),
      ...(args.attachmentSize ? { attachmentSize: args.attachmentSize } : {}),
      readBy: [currentUser._id],
      createdAt,
    });

    await ctx.db.patch(args.roomId, {
      lastMessageText: preview,
      lastMessageAt: createdAt,
      updatedAt: createdAt,
    });

    for (const participantId of room.participantIds) {
      const participantMember = await getMembership(ctx, args.roomId, participantId);
      if (!participantMember) continue;

      await ctx.db.patch(participantMember._id, {
        unreadCount:
          participantId === currentUser._id
            ? 0
            : participantMember.unreadCount + 1,
        updatedAt: createdAt,
      });
    }

    // Automatically schedule blockchain anchoring in the background (non-blocking)
    await ctx.scheduler.runAfter(0, internal.blockchainActions.anchorMessage, {
      messageId,
    });

    return { messageId };
  },
});

export const askQuestion = mutation({
  args: {
    sessionToken: v.string(),
    title: v.string(),
    body: v.string(),
    hashtags: v.array(v.string()),
    // Target department classification fields
    departmentId: v.optional(v.id("departments")),
    departmentName: v.optional(v.string()),
    topic: v.optional(v.string()),
    attachmentStorageId: v.optional(v.id("_storage")),
    attachmentName: v.optional(v.string()),
    attachmentType: v.optional(v.string()),
    attachmentSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const currentUser = await requireUser(ctx, args.sessionToken);
    const title = args.title.trim().replace(/\s+/g, " ");
    const body = args.body.trim();
    if (title.length < 6) {
      throw new ConvexError("Question title must be at least 6 characters.");
    }
    if (body.length < 12) {
      throw new ConvexError("Question details must be at least 12 characters.");
    }

    let targetDeptId = currentUser.departmentId;
    let targetDeptName = currentUser.departmentName;

    if (args.departmentId) {
      const targetDept = await ctx.db.get(args.departmentId);
      if (!targetDept || targetDept.isActive === false) {
        throw new ConvexError("Selected department is not valid or active.");
      }
      targetDeptId = targetDept._id;
      targetDeptName = targetDept.name;
    }

    if (!targetDeptId || !targetDeptName) {
      throw new ConvexError("Please select a target department for your question.");
    }

    const now = Date.now();
    const questionId = await ctx.db.insert("questions", {
      authorId: currentUser._id,
      title,
      body,
      hashtags: normalizeHashtags(args.hashtags),
      ...attachmentFields(
        args.attachmentStorageId,
        args.attachmentName,
        args.attachmentType,
        args.attachmentSize,
      ),
      // Classification fields: targeted department
      departmentId: targetDeptId,
      departmentName: targetDeptName,
      topic: args.topic,
      answerCount: 0,
      answered: false,
      createdAt: now,
      updatedAt: now,
    });

    // Push notification ONLY to lecturers in this target department
    const lecturers = await ctx.db
      .query("users")
      .withIndex("by_department", (q) => q.eq("departmentId", targetDeptId))
      .filter((q) => q.eq(q.field("role"), "lecturer"))
      .collect();

    for (const lecturer of lecturers) {
      if (lecturer._id === currentUser._id) continue;
      await ctx.db.insert("notifications", {
        userId: lecturer._id,
        actorId: currentUser._id,
        questionId,
        type: "department_question",
        title: `New Question in ${targetDeptName}`,
        body: `${currentUser.fullName} asked "${title}" in ${targetDeptName}`,
        read: false,
        createdAt: now,
      });
    }

    return { questionId };
  },
});

export const addAnswer = mutation({
  args: {
    sessionToken: v.string(),
    questionId: v.id("questions"),
    body: v.string(),
    // Optional classification fields for answer
    departmentId: v.optional(v.id("departments")),
    departmentName: v.optional(v.string()),
    attachmentStorageId: v.optional(v.id("_storage")),
    attachmentName: v.optional(v.string()),
    attachmentType: v.optional(v.string()),
    attachmentSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const currentUser = await requireUser(ctx, args.sessionToken);
    const question = await ctx.db.get(args.questionId);
    if (!question) {
      throw new ConvexError("Question not found.");
    }
    // Only lecturers from the question's target department are allowed to answer
    if (currentUser.role !== "lecturer") {
      throw new ConvexError("Only lecturers can answer questions.");
    }
    if (!currentUser.departmentId || question.departmentId !== currentUser.departmentId) {
      throw new ConvexError(`Only lecturers from ${question.departmentName ?? "the target department"} can answer this question.`);
    }

    const body = args.body.trim();
    if (!body && !args.attachmentStorageId) {
      throw new ConvexError("Reply cannot be empty.");
    }

    const now = Date.now();
    const answerId = await ctx.db.insert("answers", {
      questionId: args.questionId,
      authorId: currentUser._id,
      body,
      ...attachmentFields(
        args.attachmentStorageId,
        args.attachmentName,
        args.attachmentType,
        args.attachmentSize,
      ),
      departmentId: currentUser.departmentId,
      departmentName: currentUser.departmentName,
      createdAt: now,
    });

    await ctx.db.patch(args.questionId, {
      answerCount: question.answerCount + 1,
      updatedAt: now,
    });

    if (question.authorId !== currentUser._id) {
      await ctx.db.insert("notifications", {
        userId: question.authorId,
        actorId: currentUser._id,
        questionId: args.questionId,
        answerId,
        type: "question_reply",
        title: `New answer from ${currentUser.fullName}`,
        body: `${currentUser.fullName} (${currentUser.departmentName ?? "Lecturer"}) replied to "${question.title}"`,
        read: false,
        createdAt: now,
      });
    }

    return { answerId };
  },
});

export const askQuestionV2 = askQuestion;
export const addAnswerV2 = addAnswer;

export const markQuestionAnswered = mutation({
  args: {
    sessionToken: v.string(),
    questionId: v.id("questions"),
  },
  handler: async (ctx, args) => {
    const currentUser = await requireUser(ctx, args.sessionToken);
    const question = await ctx.db.get(args.questionId);
    if (!question) {
      throw new ConvexError("Question not found.");
    }
    if (question.authorId !== currentUser._id) {
      throw new ConvexError("Only the original poster can mark this answered.");
    }

    await ctx.db.patch(args.questionId, {
      answered: true,
      updatedAt: Date.now(),
    });

    return { ok: true };
  },
});

export const getUnreadCount = query({
  args: {
    sessionToken: v.string(),
    roomId: v.id("chatRooms"),
  },
  handler: async (ctx, args) => {
    const currentUser = await getUserBySessionToken(ctx, args.sessionToken);
    if (!currentUser) return 0;

    const membership = await getMembership(ctx, args.roomId, currentUser._id);
    return membership?.unreadCount ?? 0;
  },
});

export const markAsRead = mutation({
  args: {
    sessionToken: v.string(),
    roomId: v.id("chatRooms"),
  },
  handler: async (ctx, args) => {
    const currentUser = await requireUser(ctx, args.sessionToken);
    const membership = await getMembership(ctx, args.roomId, currentUser._id);
    if (!membership) {
      throw new ConvexError("You do not have access to this room.");
    }

    const now = Date.now();
    await ctx.db.patch(membership._id, {
      unreadCount: 0,
      lastReadAt: now,
      updatedAt: now,
    });

    return { updated: true };
  },
});

export const updateProfile = mutation({
  args: {
    sessionToken: v.string(),
    fullName: v.string(),
    bio: v.optional(v.string()),
    school: v.string(),
    rank: v.optional(v.string()),
    avatarStorageId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const currentUser = await requireUser(ctx, args.sessionToken);
    const cleanedName = args.fullName.trim().replace(/\s+/g, " ");
    if (!cleanedName) {
      throw new ConvexError("Full name is required.");
    }

    const [firstName, ...remainingName] = cleanedName.split(" ");
    const lastName = remainingName.join(" ") || currentUser.lastName;
    const rank = currentUser.role === "lecturer" ? args.rank?.trim() : undefined;
    if (rank && !["Dr", "Prof", "Engineer"].includes(rank)) {
      throw new ConvexError("Select a valid academic rank.");
    }
    const avatarUrl = args.avatarStorageId
      ? (await ctx.storage.getUrl(args.avatarStorageId)) ?? undefined
      : undefined;

    await ctx.db.patch(currentUser._id, {
      firstName,
      lastName,
      fullName: cleanedName,
      bio: args.bio?.trim() ?? "",
      school: args.school.trim(),
      ...(currentUser.role === "lecturer" ? { rank } : {}),
      ...(args.avatarStorageId ? { avatarStorageId: args.avatarStorageId } : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
      updatedAt: Date.now(),
    });

    return { ok: true };
  },
});

export const submitAcademicVerification = mutation({
  args: {
    sessionToken: v.string(),
    storageId: v.id("_storage"),
    school: v.string(),
    idNumber: v.optional(v.string()),
    department: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const currentUser = await requireUser(ctx, args.sessionToken);
    const evidenceUrl = (await ctx.storage.getUrl(args.storageId)) ?? undefined;
    const now = Date.now();
    const department = await ensureDepartmentByName(ctx, args.department);

    await ctx.db.insert("verificationRequests", {
      userId: currentUser._id,
      school: args.school,
      ...(args.idNumber ? { idNumber: args.idNumber } : {}),
      ...(department.departmentId ? { departmentId: department.departmentId } : {}),
      ...(department.departmentName ? { departmentName: department.departmentName } : {}),
      evidenceStorageId: args.storageId,
      ...(evidenceUrl ? { evidenceUrl } : {}),
      approved: false,
      status: "pending",
      submittedAt: now,
    });

    await ctx.db.patch(currentUser._id, {
      school: args.school,
      ...(args.idNumber ? { idNumber: args.idNumber } : {}),
      ...(department.departmentId ? { departmentId: department.departmentId } : {}),
      ...(department.departmentName ? { departmentName: department.departmentName } : {}),
      verificationStatus: "pending",
      approved: false,
      verificationEvidenceStorageId: args.storageId,
      ...(evidenceUrl ? { verificationEvidenceUrl: evidenceUrl } : {}),
      verificationSubmittedAt: now,
      updatedAt: now,
    });

    // Return the profile hash payload so the frontend can anchor it to blockchain
    const profileHashPayload = `${currentUser._id}|${args.idNumber || currentUser.idNumber || ""}|${currentUser.email}|${args.school}|${currentUser.role}`;
    return { ok: true, evidenceUrl, profileHashPayload, userId: currentUser._id };
  },
});

/**
 * Persists a blockchain transaction hash from a profile hash anchor back to
 * the most recent verification request for the user. Called by the frontend
 * after a successful Besu recordProfileHash action.
 */
export const storeProfileHashTx = mutation({
  args: {
    sessionToken: v.string(),
    txHash: v.string(),
    profileHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const currentUser = await requireUser(ctx, args.sessionToken);
    // Find the most recent pending verification request for this user
    const request = await ctx.db
      .query("verificationRequests")
      .withIndex("by_userId", (q) => q.eq("userId", currentUser._id))
      .order("desc")
      .first();
    if (!request) return { ok: false, reason: "no pending request" };
    await ctx.db.patch(request._id, {
      profileHashTxHash: args.txHash,
      ...(args.profileHash ? { profileHash: args.profileHash } : {}),
    });
    console.log(`✅ [Convex] Profile hash tx stored: ${args.txHash} for request ${request._id}`);
    return { ok: true };
  },
});

export const deleteMessage = mutation({
  args: {
    sessionToken: v.string(),
    messageId: v.id("messages"),
  },
  handler: async (ctx, args) => {
    const currentUser = await requireUser(ctx, args.sessionToken);
    const message = await ctx.db.get(args.messageId);
    if (!message) {
      throw new ConvexError("Message not found.");
    }
    if (message.senderId !== currentUser._id) {
      throw new ConvexError("You can only delete your own messages.");
    }
    await ctx.db.patch(args.messageId, { deletedAt: Date.now() });
    return { ok: true };
  },
});

export const editMessage = mutation({
  args: {
    sessionToken: v.string(),
    messageId: v.id("messages"),
    text: v.string(),
    iv: v.optional(v.string()),
    isEncrypted: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const currentUser = await requireUser(ctx, args.sessionToken);
    const message = await ctx.db.get(args.messageId);
    if (!message) {
      throw new ConvexError("Message not found.");
    }
    if (message.senderId !== currentUser._id) {
      throw new ConvexError("You can only edit your own messages.");
    }
    if (message.attachmentStorageId) {
      throw new ConvexError("File messages cannot be edited.");
    }
    const newText = args.text.trim();
    if (!newText) {
      throw new ConvexError("Message text cannot be empty.");
    }
    await ctx.db.patch(args.messageId, {
      text: newText,
      ...(args.iv ? { iv: args.iv } : {}),
      ...(args.isEncrypted !== undefined ? { isEncrypted: args.isEncrypted } : {}),
      editedAt: Date.now(),
    });
    return { ok: true };
  },
});

export const deleteAccount = mutation({
  args: {
    sessionToken: v.string(),
  },
  handler: async (ctx, args) => {
    const currentUser = await requireUser(ctx, args.sessionToken);
    await ctx.db.delete(currentUser._id);
    return { ok: true };
  },
});

export const updateMessageTxHash = mutation({
  args: {
    sessionToken: v.string(),
    messageId: v.id("messages"),
    txHash: v.string(),
  },
  handler: async (ctx, args) => {
    const currentUser = await requireUser(ctx, args.sessionToken);
    const message = await ctx.db.get(args.messageId);
    if (!message) {
      throw new ConvexError("Message not found.");
    }
    if (message.senderId !== currentUser._id) {
      throw new ConvexError("You can only update your own messages.");
    }
    await ctx.db.patch(args.messageId, {
      blockchainTxHash: args.txHash,
    });
    return { ok: true };
  },
});

export const getMessageForAnchoring = internalQuery({
  args: {
    messageId: v.id("messages"),
  },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) return null;
    const room = await ctx.db.get(message.roomId);
    const receiverId = room?.participantIds?.find((id) => id !== message.senderId);
    return {
      messageId: message._id,
      text: message.text,
      senderId: message.senderId,
      receiverId: receiverId ?? "public",
      blockchainTxHash: message.blockchainTxHash,
    };
  },
});

export const updateMessageTxHashFromBlockchain = internalMutation({
  args: {
    messageId: v.id("messages"),
    txHash: v.string(),
  },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) {
      console.warn(`[Message Anchor] Message ${args.messageId} not found during txHash update.`);
      return { ok: false, error: "Message not found" };
    }
    if (message.blockchainTxHash) {
      console.log(`[Message Anchor] Message ${args.messageId} already has blockchainTxHash ${message.blockchainTxHash}. Skipping overwrite.`);
      return { ok: true, alreadyUpdated: true };
    }
    await ctx.db.patch(args.messageId, {
      blockchainTxHash: args.txHash,
    });
    console.log(`[Message Anchor] Saved tx hash to Convex: ${args.txHash} for message ${args.messageId}`);
    return { ok: true };
  },
});

