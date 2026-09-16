import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  admins: defineTable({
    email: v.string(),
    displayName: v.string(),
    passwordHash: v.string(),
    sessionToken: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_email", ["email"])
    .index("by_sessionToken", ["sessionToken"]),

  users: defineTable({
    firstName: v.string(),
    lastName: v.string(),
    fullName: v.string(),
    email: v.string(),
    role: v.union(v.literal("student"), v.literal("lecturer")),
    school: v.string(),
    idNumber: v.optional(v.string()),
    indexNumber: v.optional(v.string()),
    staffId: v.optional(v.string()),
    walletAddress: v.optional(v.string()),
    rank: v.optional(v.string()),
    bio: v.optional(v.string()),
    avatarStorageId: v.optional(v.id("_storage")),
    avatarUrl: v.optional(v.string()),
    passwordHash: v.string(),
    // Department affiliation and specializations for lecturers
    departmentId: v.optional(v.id("departments")),
    departmentName: v.optional(v.string()),
    specializations: v.optional(v.array(v.string())),
    sessionToken: v.string(),
    verificationStatus: v.union(
      v.literal("unverified"),
      v.literal("pending"),
      v.literal("approved"),
    ),
    approved: v.optional(v.boolean()),
    verificationEvidenceStorageId: v.optional(v.id("_storage")),
    verificationEvidenceUrl: v.optional(v.string()),
    verificationSubmittedAt: v.optional(v.number()),
    publicKey: v.optional(v.string()),
    hasKeypair: v.optional(v.boolean()),
    updatedAt: v.number(),
  })
    .index("by_email", ["email"])
    .index("by_passwordHash", ["passwordHash"])
    .index("by_sessionToken", ["sessionToken"])
    .index("by_school", ["school"])
    .index("by_department", ["departmentId"])
    .index("by_verificationStatus", ["verificationStatus"])
    .index("by_idNumber", ["idNumber"])
    .index("by_indexNumber", ["indexNumber"])
    .index("by_staffId", ["staffId"])
    .index("by_walletAddress", ["walletAddress"]),

  // ---------------------------------------------------------------------
  // Departments table – used to group lecturers and questions by academic unit
  // ---------------------------------------------------------------------
  departments: defineTable({
    name: v.string(),
    // Kept optional so existing department records remain deployable; new and
    // edited records use this canonical value for case-insensitive lookups.
    normalizedName: v.optional(v.string()),
    code: v.string(),
    description: v.optional(v.string()),
    isActive: v.optional(v.boolean()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_code", ["code"])
    .index("by_name", ["name"])
    .index("by_normalizedName", ["normalizedName"]),

  chatRooms: defineTable({
    participantIds: v.array(v.id("users")),
    participantKey: v.string(),
    title: v.optional(v.string()),
    lastMessageText: v.optional(v.string()),
    lastMessageAt: v.optional(v.number()),
    bb84Key: v.optional(v.string()),
    bb84Fingerprint: v.optional(v.string()),
    bb84ConfirmedUsers: v.optional(v.array(v.id("users"))),
    bb84Status: v.optional(
      v.union(v.literal("pending"), v.literal("active"), v.literal("confirmed"))
    ),
    status: v.optional(
      v.union(v.literal("pending"), v.literal("active"), v.literal("confirmed"))
    ),
    bb84DebugInfo: v.optional(
      v.object({
        totalBitsSent: v.number(),
        siftedLength: v.number(),
        efficiencyPercentage: v.number(),
        qber: v.number(),
      })
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_participantKey", ["participantKey"]),

  chatRoomMembers: defineTable({
    roomId: v.id("chatRooms"),
    userId: v.id("users"),
    otherUserId: v.id("users"),
    unreadCount: v.number(),
    lastReadAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_userId_and_updatedAt", ["userId", "updatedAt"])
    .index("by_roomId_and_userId", ["roomId", "userId"]),

  messages: defineTable({
    roomId: v.id("chatRooms"),
    senderId: v.id("users"),
    text: v.string(),
    iv: v.optional(v.string()),
    isEncrypted: v.optional(v.boolean()),
    attachmentStorageId: v.optional(v.id("_storage")),
    attachmentUrl: v.optional(v.string()),
    attachmentName: v.optional(v.string()),
    attachmentType: v.optional(v.string()),
    attachmentSize: v.optional(v.number()),
    readBy: v.array(v.id("users")),
    createdAt: v.number(),
    editedAt: v.optional(v.number()),
    deletedAt: v.optional(v.number()),
    blockchainTxHash: v.optional(v.string()),
  })
    .index("by_roomId_and_createdAt", ["roomId", "createdAt"])
    .index("by_senderId", ["senderId"])
    .index("by_senderId_and_createdAt", ["senderId", "createdAt"]),

  questions: defineTable({
    authorId: v.id("users"),
    title: v.string(),
    body: v.string(),
    hashtags: v.array(v.string()),
    attachmentStorageId: v.optional(v.id("_storage")),
    attachmentUrl: v.optional(v.string()),
    attachmentName: v.optional(v.string()),
    attachmentType: v.optional(v.string()),
    attachmentSize: v.optional(v.number()),
    answerCount: v.number(),
    // Optional department and topic classification for questions
    departmentId: v.optional(v.id("departments")),
    departmentName: v.optional(v.string()),
    topic: v.optional(v.string()),
    answered: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_createdAt", ["createdAt"])
    .index("by_department", ["departmentId"])
    .index("by_departmentId_and_createdAt", ["departmentId", "createdAt"])
    .index("by_topic", ["topic"])
    .index("by_authorId_and_createdAt", ["authorId", "createdAt"]),

  answers: defineTable({
    questionId: v.id("questions"),
    authorId: v.id("users"),
    body: v.string(),
    attachmentStorageId: v.optional(v.id("_storage")),
    attachmentUrl: v.optional(v.string()),
    attachmentName: v.optional(v.string()),
    attachmentType: v.optional(v.string()),
    attachmentSize: v.optional(v.number()),
    // Optional department info for answers (mirrors question classification)
    departmentId: v.optional(v.id("departments")),
    departmentName: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_questionId_and_createdAt", ["questionId", "createdAt"])
    .index("by_authorId_and_createdAt", ["authorId", "createdAt"]),

  notifications: defineTable({
    userId: v.id("users"),
    actorId: v.id("users"),
    questionId: v.optional(v.id("questions")),
    answerId: v.optional(v.id("answers")),
    roomId: v.optional(v.id("chatRooms")),
    type: v.union(
      v.literal("question_reply"),
      v.literal("bb84_key_exchange"),
      v.literal("department_question"),
    ),
    title: v.string(),
    body: v.string(),
    read: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_userId_and_createdAt", ["userId", "createdAt"])
    .index("by_userId_and_read_and_createdAt", ["userId", "read", "createdAt"])
    .index("by_userId_and_roomId_and_type", ["userId", "roomId", "type"]),

  verificationRequests: defineTable({
    userId: v.id("users"),
    school: v.string(),
    idNumber: v.optional(v.string()),
    // Preserve the registrant's choice with the request so the review queue
    // can display the department that was submitted for verification.
    departmentId: v.optional(v.id("departments")),
    departmentName: v.optional(v.string()),
    evidenceStorageId: v.optional(v.id("_storage")),
    evidenceUrl: v.optional(v.string()),
    approved: v.boolean(),
    status: v.union(v.literal("pending"), v.literal("approved"), v.literal("rejected")),
    submittedAt: v.number(),
    reviewedAt: v.optional(v.number()),
    // Blockchain anchoring: hash of profile data anchored at submission time
    profileHash: v.optional(v.string()),
    profileHashTxHash: v.optional(v.string()),
    // Blockchain anchoring: tx hash recorded when admin approves
    approvalTxHash: v.optional(v.string()),
  }).index("by_userId", ["userId"]),
});
