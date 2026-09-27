import { z } from "zod";
import { TimestampMsSchema } from "./common.ts";
import { ActorIdSchema } from "./control-identifiers.ts";
import { prefixedId } from "./identity-base.ts";
import { AccountIdSchema } from "./private-identifiers.ts";
import {
  DeckVersionIdSchema,
  DisplayBindingEpochSchema,
  DisplayIdSchema,
} from "./public-identifiers.ts";
import {
  PresentationSessionEpochSchema,
  PresentationSessionIdSchema,
} from "./session-identifiers.ts";

export const AccountSessionIdSchema = prefixedId<"AccountSessionId">("account_session_");
export const DisplayJoinIdSchema = z
  .string()
  .regex(/^join_[0-9a-f]{32,}$/)
  .brand<"DisplayJoinId">();

export const AccountSessionSchema = z
  .object({
    accountSessionId: AccountSessionIdSchema,
    accountId: AccountIdSchema,
    actorId: ActorIdSchema,
    expiresAtMs: TimestampMsSchema,
    revokedAtMs: TimestampMsSchema.nullable(),
  })
  .strict();

export const PresentationSessionLifecycleSchema = z
  .object({
    presentationSessionId: PresentationSessionIdSchema,
    presentationSessionEpoch: PresentationSessionEpochSchema,
    ownerAccountId: AccountIdSchema,
    deckVersion: DeckVersionIdSchema,
    status: z.enum(["ACTIVE", "ENDED"]),
    createdAtMs: TimestampMsSchema,
    endedAtMs: TimestampMsSchema.nullable(),
    // Additive S1 field: snapshots persisted before Q&A support lack this key, so
    // `null` is defaulted here rather than in restore side-effects. This keeps
    // restorePreparedEvidenceStore (services/private-backend/src/prepared-evidence.ts,
    // which safeParse()s presentation lifecycles against this exact schema) able to
    // accept its own pre-S1 output while full-fidelity snapshots round-trip the real
    // timestamp. Parsed output type remains required: number | null.
    qaStartedAtMs: TimestampMsSchema.nullable().default(null),
    // Additive GAP-10 fields, same backfill rule as qaStartedAtMs: snapshots persisted
    // before the presentation library lack both keys. A null presentationTitle means
    // "the deck title is the display title"; a null updatedAtMs means "never mutated
    // after creation", so both resolve from the lifecycle/deck at read time.
    presentationTitle: z.string().min(1).max(500).nullable().default(null),
    updatedAtMs: TimestampMsSchema.nullable().default(null),
  })
  .strict();

export const DisplayJoinSchema = z
  .object({
    displayJoinId: DisplayJoinIdSchema,
    displayId: DisplayIdSchema,
    deckVersion: DeckVersionIdSchema,
    displayFingerprint: z.string().min(16).max(256),
    expiresAtMs: TimestampMsSchema,
  })
  .strict();

export const PlaybackLeaseTakeoverSchema = z
  .object({
    presentationSessionId: PresentationSessionIdSchema,
    expectedDisplayBindingEpoch: DisplayBindingEpochSchema,
  })
  .strict();

export const DisplayApprovalSchema = z
  .object({
    presentationSessionId: PresentationSessionIdSchema,
    displayJoinId: DisplayJoinIdSchema,
    expectedDisplayBindingEpoch: DisplayBindingEpochSchema,
    expectedDeckVersion: DeckVersionIdSchema,
    approvedDisplayId: DisplayIdSchema,
    approvedDisplayFingerprint: z.string().min(16).max(256),
  })
  .strict();

export type AccountSessionId = z.infer<typeof AccountSessionIdSchema>;
export type DisplayJoinId = z.infer<typeof DisplayJoinIdSchema>;
export type AccountSession = z.infer<typeof AccountSessionSchema>;
export type PresentationSessionLifecycle = z.infer<typeof PresentationSessionLifecycleSchema>;
export type DisplayJoin = z.infer<typeof DisplayJoinSchema>;
export type DisplayApproval = z.infer<typeof DisplayApprovalSchema>;
export type PlaybackLeaseTakeover = z.infer<typeof PlaybackLeaseTakeoverSchema>;
