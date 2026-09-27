import { z } from "zod";
import { Sha256Schema, TimestampMsSchema } from "./common.ts";
import { DisplayJoinSchema } from "./prepared-evidence.ts";
import {
  DeckVersionIdSchema,
  DisplayBindingEpochSchema,
  DisplayIdSchema,
} from "./public-identifiers.ts";
import { PresentationSessionIdSchema } from "./session-identifiers.ts";

/**
 * Non-authorizing display invitations (plan task 6/7).
 *
 * An invitation is a one-use, <=90s secret the Console hands to a Stage URL fragment.
 * Exchanging it at the public gateway creates at most one *pending* display join; only a
 * fresh presenter gesture (POST /v1/display-bindings on the private backend, CAS-bound to
 * the current display binding epoch) can turn that join into a bound audience display.
 * Neither the token nor the join locator is authority by itself.
 */

export const DisplayInvitationIdSchema = z
  .string()
  .regex(/^dinvite_[0-9a-f]{32}$/)
  .brand<"DisplayInvitationId">();

/** 256 bits of opaque hex; travels only in the URL fragment and the join request body. */
export const DisplayInvitationTokenSchema = z
  .string()
  .regex(/^dinv_[0-9a-f]{64}$/)
  .brand<"DisplayInvitationToken">();

export const DisplayInvitationStatusSchema = z.enum(["PENDING", "JOINED", "EXPIRED"]);

/** Private -> gateway mint call: POST /internal/display-invitations (service bearer only). */
export const DisplayInvitationIssueRequestSchema = z
  .object({
    presentationSessionId: PresentationSessionIdSchema,
    deckVersion: DeckVersionIdSchema,
    nowMs: TimestampMsSchema,
  })
  .strict();

/** The token is returned exactly once, at issuance; it is never stored or echoed back. */
export const IssuedDisplayInvitationSchema = z
  .object({
    invitationId: DisplayInvitationIdSchema,
    token: DisplayInvitationTokenSchema,
    deckVersion: DeckVersionIdSchema,
    expiresAtMs: TimestampMsSchema,
  })
  .strict();

/**
 * Public Stage join exchange: POST /v1/display-joins. An omitted invitationToken keeps the
 * Console-opener handshake working; a present token must resolve to a live invitation.
 */
export const PublicDisplayJoinRequestSchema = z
  .object({
    displayId: DisplayIdSchema,
    deckVersion: DeckVersionIdSchema,
    displayFingerprint: z.string().min(16).max(256),
    invitationToken: DisplayInvitationTokenSchema.optional(),
  })
  .strict();

/** Gateway -> private backend record view: GET /internal/display-invitations/:id. */
export const DisplayInvitationViewSchema = z
  .object({
    invitationId: DisplayInvitationIdSchema,
    presentationSessionId: PresentationSessionIdSchema,
    deckVersion: DeckVersionIdSchema,
    expiresAtMs: TimestampMsSchema,
    status: DisplayInvitationStatusSchema,
    join: DisplayJoinSchema.nullable(),
  })
  .strict();

/**
 * Durable gateway record. Only the SHA-256 token digest is persisted: a leaked row cannot
 * be replayed into /v1/display-joins. `consumedAtMs` and `join` are always both null
 * (unspent) or both set (atomically consumed).
 */
export const StoredDisplayInvitationSchema = z
  .object({
    invitationId: DisplayInvitationIdSchema,
    tokenDigest: Sha256Schema,
    presentationSessionId: PresentationSessionIdSchema,
    deckVersion: DeckVersionIdSchema,
    expiresAtMs: TimestampMsSchema,
    consumedAtMs: TimestampMsSchema.nullable(),
    join: DisplayJoinSchema.nullable(),
  })
  .strict()
  .refine(
    (record) => (record.consumedAtMs === null) === (record.join === null),
    "a consumed invitation must record its join, and an unspent one must not",
  );

/** Console -> private backend: POST /v1/display-invitations. */
export const CreateDisplayInvitationRequestSchema = z
  .object({
    presentationSessionId: PresentationSessionIdSchema,
  })
  .strict();

/**
 * POST /v1/display-invitations response: the minted DTO plus a redacted relative URL for
 * the Stage. The token travels only inside the fragment — never in a query parameter that
 * access logs, referrers, or browser history would capture. The Console prefixes its own
 * resolved Stage origin.
 */
export const CreateDisplayInvitationResponseSchema = IssuedDisplayInvitationSchema.extend({
  stagePath: z.string().regex(/^\/\?deck=[A-Za-z0-9][A-Za-z0-9._-]*#invite=dinv_[0-9a-f]{64}$/),
}).strict();

/**
 * Owner-only pending read: GET /v1/display-invitations/:id/pending. Carries the exact
 * display identity the presenter must eyeball plus the authoritative binding epoch the
 * approval CAS is written against. Never contains token or digest material.
 */
export const DisplayInvitationPendingViewSchema = z
  .object({
    invitationId: DisplayInvitationIdSchema,
    presentationSessionId: PresentationSessionIdSchema,
    deckVersion: DeckVersionIdSchema,
    expiresAtMs: TimestampMsSchema,
    status: DisplayInvitationStatusSchema,
    displayBindingEpoch: DisplayBindingEpochSchema,
    join: DisplayJoinSchema.nullable(),
  })
  .strict();

export type DisplayInvitationId = z.infer<typeof DisplayInvitationIdSchema>;
export type DisplayInvitationToken = z.infer<typeof DisplayInvitationTokenSchema>;
export type DisplayInvitationStatus = z.infer<typeof DisplayInvitationStatusSchema>;
export type DisplayInvitationIssueRequest = z.infer<typeof DisplayInvitationIssueRequestSchema>;
export type IssuedDisplayInvitation = z.infer<typeof IssuedDisplayInvitationSchema>;
export type PublicDisplayJoinRequest = z.infer<typeof PublicDisplayJoinRequestSchema>;
export type DisplayInvitationView = z.infer<typeof DisplayInvitationViewSchema>;
export type StoredDisplayInvitation = z.infer<typeof StoredDisplayInvitationSchema>;
export type CreateDisplayInvitationRequest = z.infer<typeof CreateDisplayInvitationRequestSchema>;
export type CreateDisplayInvitationResponse = z.infer<typeof CreateDisplayInvitationResponseSchema>;
export type DisplayInvitationPendingView = z.infer<typeof DisplayInvitationPendingViewSchema>;
