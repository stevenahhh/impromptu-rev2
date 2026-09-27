import { z } from "zod";
import { Sha256Schema, TimestampMsSchema } from "./common.ts";
import { AccountIdSchema } from "./private-identifiers.ts";
import { PresentationSessionIdSchema } from "./session-identifiers.ts";

/**
 * Question-only teammate grants and the owner's private question inbox (plan task 8).
 *
 * An owner issues a session-scoped, revocable grant targeted at one teammate account; the
 * teammate redeems an opaque, single-use invitation exactly once and may then append bounded
 * question text into the owner's private inbox. The grant is never authority for anything
 * else: no deck reads, playback, recommendations, reports, or other tenants' questions.
 * The server persists only the SHA-256 digest of the invitation token; the token itself is
 * returned to the owner exactly once at issuance and never stored or echoed back.
 */

/** Upper bound for one teammate question; mirrors the typed-question bound in Q&A defense. */
export const TEAM_QUESTION_TEXT_MAX = 2_000 as const;

/**
 * Fixed grant lifetime, mirroring the presentation capability TTL: a grant cannot outlive
 * the window in which the session's own capabilities are valid.
 */
export const TEAM_QUESTION_GRANT_TTL_MS = 4 * 60 * 60 * 1_000;

export const TeamQuestionGrantIdSchema = z
  .string()
  .regex(/^tqg_[0-9a-f]{32}$/)
  .brand<"TeamQuestionGrantId">();

export const TeamQuestionIdSchema = z
  .string()
  .regex(/^tqq_[0-9a-f]{32}$/)
  .brand<"TeamQuestionId">();

/** 256 bits of opaque hex; shown once at issuance, carried only in the accept request body. */
export const TeamQuestionInvitationTokenSchema = z
  .string()
  .regex(/^tginv_[0-9a-f]{64}$/)
  .brand<"TeamQuestionInvitationToken">();

/** Caller-supplied retry key for issue and submit writes. */
export const TeamQuestionIdempotencyKeySchema = z.string().min(1).max(200);

export const TeamQuestionGrantStatusSchema = z.enum(["PENDING", "ACCEPTED", "REVOKED", "EXPIRED"]);

export const IssueTeamQuestionGrantRequestSchema = z
  .object({
    presentationSessionId: PresentationSessionIdSchema,
    teammateUsername: z.string().trim().min(1).max(64),
    idempotencyKey: TeamQuestionIdempotencyKeySchema,
  })
  .strict();

/**
 * Owner-facing grant summary. `revocationRevision` starts at 1 and increments on each
 * revocation; `acceptedAtMs`/`revokedAtMs` are null while their event has not occurred.
 * No invitation token or digest material is ever present.
 */
export const TeamQuestionGrantViewSchema = z
  .object({
    grantId: TeamQuestionGrantIdSchema,
    presentationSessionId: PresentationSessionIdSchema,
    teammateAccountId: AccountIdSchema,
    teammateUsername: z.string().min(1).max(64),
    status: TeamQuestionGrantStatusSchema,
    revocationRevision: z.number().int().positive(),
    expiresAtMs: TimestampMsSchema,
    acceptedAtMs: TimestampMsSchema.nullable(),
    revokedAtMs: TimestampMsSchema.nullable(),
  })
  .strict();

/** 201 issuance response: the grant view plus the one-use invitation, shown exactly once. */
export const IssuedTeamQuestionGrantSchema = TeamQuestionGrantViewSchema.extend({
  invitationToken: TeamQuestionInvitationTokenSchema,
}).strict();

/** 200 idempotent replay of an issuance: same grant, no token material. */
export const ReplayedTeamQuestionGrantSchema = TeamQuestionGrantViewSchema.extend({
  duplicate: z.literal(true),
}).strict();

export const IssueTeamQuestionGrantResponseSchema = z.union([
  IssuedTeamQuestionGrantSchema,
  ReplayedTeamQuestionGrantSchema,
]);

export const AcceptTeamQuestionGrantRequestSchema = z
  .object({
    invitationToken: TeamQuestionInvitationTokenSchema,
  })
  .strict();

/** Teammate-facing accept receipt: the capability handle, nothing else. */
export const AcceptedTeamQuestionGrantSchema = z
  .object({
    grantId: TeamQuestionGrantIdSchema,
    presentationSessionId: PresentationSessionIdSchema,
    expiresAtMs: TimestampMsSchema,
  })
  .strict();

export const SubmitTeamQuestionRequestSchema = z
  .object({
    grantId: TeamQuestionGrantIdSchema,
    questionText: z.string().trim().min(1).max(TEAM_QUESTION_TEXT_MAX),
    idempotencyKey: TeamQuestionIdempotencyKeySchema,
  })
  .strict();

/**
 * The only thing the teammate ever gets back from a submission: a receipt.
 * `duplicate` marks an identical retry of an already-recorded idempotency key.
 */
export const TeamQuestionReceiptSchema = z
  .object({
    questionId: TeamQuestionIdSchema,
    grantId: TeamQuestionGrantIdSchema,
    submittedAtMs: TimestampMsSchema,
    duplicate: z.boolean(),
  })
  .strict();

export const TeamQuestionInboxEntrySchema = z
  .object({
    questionId: TeamQuestionIdSchema,
    grantId: TeamQuestionGrantIdSchema,
    teammateAccountId: AccountIdSchema,
    teammateUsername: z.string().min(1).max(64),
    questionText: z.string().min(1).max(TEAM_QUESTION_TEXT_MAX),
    submittedAtMs: TimestampMsSchema,
    questionSeq: z.number().int().positive(),
  })
  .strict();

/** Owner-only inbox read: GET /v1/team-questions?presentationSessionId=... */
export const TeamQuestionInboxViewSchema = z
  .object({
    presentationSessionId: PresentationSessionIdSchema,
    questions: z.array(TeamQuestionInboxEntrySchema).max(500),
  })
  .strict();

/** Owner-only grant list read: GET /v1/team-question-grants?presentationSessionId=... */
export const TeamQuestionGrantListSchema = z
  .object({
    presentationSessionId: PresentationSessionIdSchema,
    grants: z.array(TeamQuestionGrantViewSchema).max(200),
  })
  .strict();

export type TeamQuestionGrantId = z.infer<typeof TeamQuestionGrantIdSchema>;
export type TeamQuestionId = z.infer<typeof TeamQuestionIdSchema>;
export type TeamQuestionInvitationToken = z.infer<typeof TeamQuestionInvitationTokenSchema>;
export type TeamQuestionIdempotencyKey = z.infer<typeof TeamQuestionIdempotencyKeySchema>;
export type TeamQuestionGrantStatus = z.infer<typeof TeamQuestionGrantStatusSchema>;
export type IssueTeamQuestionGrantRequest = z.infer<typeof IssueTeamQuestionGrantRequestSchema>;
export type TeamQuestionGrantView = z.infer<typeof TeamQuestionGrantViewSchema>;
export type IssuedTeamQuestionGrant = z.infer<typeof IssuedTeamQuestionGrantSchema>;
export type ReplayedTeamQuestionGrant = z.infer<typeof ReplayedTeamQuestionGrantSchema>;
export type IssueTeamQuestionGrantResponse = z.infer<typeof IssueTeamQuestionGrantResponseSchema>;
export type AcceptTeamQuestionGrantRequest = z.infer<typeof AcceptTeamQuestionGrantRequestSchema>;
export type AcceptedTeamQuestionGrant = z.infer<typeof AcceptedTeamQuestionGrantSchema>;
export type SubmitTeamQuestionRequest = z.infer<typeof SubmitTeamQuestionRequestSchema>;
export type TeamQuestionReceipt = z.infer<typeof TeamQuestionReceiptSchema>;
export type TeamQuestionInboxEntry = z.infer<typeof TeamQuestionInboxEntrySchema>;
export type TeamQuestionInboxView = z.infer<typeof TeamQuestionInboxViewSchema>;
export type TeamQuestionGrantList = z.infer<typeof TeamQuestionGrantListSchema>;

export { Sha256Schema as TeamQuestionInvitationDigestSchema };
