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
