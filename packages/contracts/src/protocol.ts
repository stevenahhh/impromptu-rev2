import { z } from "zod";
import {
  EpochSchema,
  OpaqueIdSchema,
  PublicSlideOccurrenceSchema,
  RevisionSchema,
  Sha256Schema,
  TimestampMsSchema,
  VersionIdSchema,
} from "./common.ts";
import { PrivateDeckContextSchema, PublishedDeckArtifactSchema } from "./deck.ts";
import {
  EvidenceCandidateSchema,
  PublicationTombstoneSchema,
  PublishedAudienceCardSchema,
} from "./publication.ts";

export const ProtocolRangeSchema = z
  .object({
    min: z.number().int().nonnegative(),
    max: z.number().int().nonnegative(),
  })
  .strict()
  .refine(({ min, max }) => min <= max, { message: "protocol min must not exceed max" });

export const BuildHandshakeSchema = z
  .object({
    releaseId: VersionIdSchema,
    protocolRange: ProtocolRangeSchema,
    buildId: VersionIdSchema,
  })
  .strict();

export type BuildHandshake = z.infer<typeof BuildHandshakeSchema>;
export type HandshakeCompatibility =
  | { compatible: true; protocolVersion: number }
  | { compatible: false; reason: "RELEASE_MISMATCH" | "PROTOCOL_RANGE_MISMATCH" };

export function checkHandshakeCompatibility(
  client: BuildHandshake,
  server: BuildHandshake,
): HandshakeCompatibility {
  if (client.releaseId !== server.releaseId) {
    return { compatible: false, reason: "RELEASE_MISMATCH" };
  }
  const lowestMaximum = Math.min(client.protocolRange.max, server.protocolRange.max);
  const highestMinimum = Math.max(client.protocolRange.min, server.protocolRange.min);
  if (lowestMaximum < highestMinimum) {
    return { compatible: false, reason: "PROTOCOL_RANGE_MISMATCH" };
  }
  return { compatible: true, protocolVersion: lowestMaximum };
}

export const PlaybackControlLeaseSchema = z
  .object({
    leaseId: OpaqueIdSchema,
    actorId: OpaqueIdSchema,
    controllerEpoch: EpochSchema,
    expiresAtMs: TimestampMsSchema,
  })
  .strict();

export const PublicationAuthoritySchema = z
  .object({
    authorityId: OpaqueIdSchema,
    actorId: OpaqueIdSchema,
    policyVersion: VersionIdSchema,
    expiresAtMs: TimestampMsSchema,
  })
  .strict();

export const AudienceDisplaySessionSchema = z
  .object({
    audienceDisplaySessionId: OpaqueIdSchema,
    displayId: OpaqueIdSchema,
    displayBindingEpoch: EpochSchema,
    expiresAtMs: TimestampMsSchema,
  })
  .strict();

const SessionIdentityShape = {
  presentationSessionId: OpaqueIdSchema,
  presentationSessionEpoch: EpochSchema,
} as const;

export const ControllerSessionSchema = z
  .object({
    role: z.literal("CONTROLLER"),
    ...SessionIdentityShape,
    actorId: OpaqueIdSchema,
    lease: PlaybackControlLeaseSchema,
  })
  .strict();

export const PublicStageSessionSchema = z
  .object({
    role: z.literal("PUBLIC_STAGE"),
    ...SessionIdentityShape,
    display: AudienceDisplaySessionSchema,
  })
  .strict();

export const PublisherSessionSchema = z
  .object({
    role: z.literal("PUBLISHER"),
    ...SessionIdentityShape,
    actorId: OpaqueIdSchema,
    authority: PublicationAuthoritySchema,
  })
  .strict();

export const RoleSessionSchema = z.discriminatedUnion("role", [
  ControllerSessionSchema,
  PublicStageSessionSchema,
  PublisherSessionSchema,
]);

export const RoleSchema = z.enum(["CONTROLLER", "PUBLIC_STAGE", "PUBLISHER"]);
export const TopicSchema = z.enum([
  "PRESENTER_CONTROL",
  "PRIVATE_CANDIDATES",
  "PUBLIC_PLAYBACK",
  "PUBLIC_CARDS",
  "DISPLAY_RECEIPTS",
]);
export const TopicActionSchema = z.enum(["READ", "WRITE"]);

const allowedRoleActions = new Set<string>([
  "CONTROLLER:PRESENTER_CONTROL:READ",
  "CONTROLLER:PRESENTER_CONTROL:WRITE",
  "CONTROLLER:PRIVATE_CANDIDATES:READ",
  "CONTROLLER:DISPLAY_RECEIPTS:READ",
  "PUBLISHER:PRIVATE_CANDIDATES:READ",
  "PUBLISHER:PRIVATE_CANDIDATES:WRITE",
  "PUBLISHER:PUBLIC_CARDS:READ",
  "PUBLISHER:PUBLIC_CARDS:WRITE",
  "PUBLIC_STAGE:PUBLIC_PLAYBACK:READ",
  "PUBLIC_STAGE:PUBLIC_CARDS:READ",
  "PUBLIC_STAGE:DISPLAY_RECEIPTS:WRITE",
]);

export function authorizeRoleAction(role: unknown, topic: unknown, action: unknown): boolean {
  const parsedRole = RoleSchema.safeParse(role);
  const parsedTopic = TopicSchema.safeParse(topic);
  const parsedAction = TopicActionSchema.safeParse(action);
  if (!(parsedRole.success && parsedTopic.success && parsedAction.success)) return false;
  return allowedRoleActions.has(`${parsedRole.data}:${parsedTopic.data}:${parsedAction.data}`);
}

const PlaybackCommandHeaderShape = {
  ...SessionIdentityShape,
  actorId: OpaqueIdSchema,
  controllerEpoch: EpochSchema,
  commandId: OpaqueIdSchema,
  baseRevision: RevisionSchema,
  requestHash: Sha256Schema,
  delivery: z.enum(["LIVE", "OFFLINE_REPLAY"]),
} as const;

export const SlideSetCommandSchema = z
  .object({
    type: z.literal("SLIDE_SET"),
    ...PlaybackCommandHeaderShape,
    publicSlideKey: OpaqueIdSchema,
  })
  .strict();

export const SlideNextCommandSchema = z
  .object({ type: z.literal("SLIDE_NEXT"), ...PlaybackCommandHeaderShape })
  .strict();
export const SlidePreviousCommandSchema = z
  .object({ type: z.literal("SLIDE_PREVIOUS"), ...PlaybackCommandHeaderShape })
  .strict();
export const BlackoutSetCommandSchema = z
  .object({
    type: z.literal("BLACKOUT_SET"),
    ...PlaybackCommandHeaderShape,
    enabled: z.boolean(),
  })
  .strict();

export const PlaybackCommandSchema = z.discriminatedUnion("type", [
  SlideSetCommandSchema,
  SlideNextCommandSchema,
  SlidePreviousCommandSchema,
  BlackoutSetCommandSchema,
]);

const ReceiptIdentityShape = {
  ...SessionIdentityShape,
  actorId: OpaqueIdSchema,
  controllerEpoch: EpochSchema,
  commandId: OpaqueIdSchema,
  requestHash: Sha256Schema,
} as const;

export const AcceptedCommandReceiptSchema = z
  .object({
    status: z.literal("ACCEPTED"),
    ...ReceiptIdentityShape,
    acceptedControlRevision: RevisionSchema,
  })
  .strict();

export const StageAppliedReceiptSchema = z
  .object({
    status: z.literal("STAGE_APPLIED"),
    ...ReceiptIdentityShape,
    acceptedControlRevision: RevisionSchema,
    publicPlaybackRevision: RevisionSchema,
    displayBindingEpoch: EpochSchema,
  })
  .strict();

export const CommandRejectionReasonSchema = z.enum([
  "UNAUTHORIZED",
  "STALE_SESSION_EPOCH",
  "STALE_CONTROLLER_EPOCH",
  "IDEMPOTENCY_CONFLICT",
  "REVISION_MISMATCH",
  "STAGE_NOT_READY",
  "OFFLINE_RELATIVE_COMMAND",
  "SLIDE_BOUNDARY",
  "UNKNOWN_SLIDE",
]);

export const RejectedCommandReceiptSchema = z
  .object({
    status: z.literal("REJECTED"),
    ...ReceiptIdentityShape,
    reason: CommandRejectionReasonSchema,
  })
  .strict();

export const CommandReceiptSchema = z.discriminatedUnion("status", [
  AcceptedCommandReceiptSchema,
  StageAppliedReceiptSchema,
  RejectedCommandReceiptSchema,
]);

export const ControllerSnapshotSchema = z
  .object({
    role: z.literal("CONTROLLER"),
    ...SessionIdentityShape,
    controllerEpoch: EpochSchema,
    controlRevision: RevisionSchema,
    displayBindingEpoch: EpochSchema,
    stageStatus: z.enum(["READY", "DISCONNECTED", "UNBOUND"]),
    deck: PrivateDeckContextSchema,
    occurrence: PublicSlideOccurrenceSchema,
    blackout: z.boolean(),
  })
  .strict();

export const PublisherSnapshotSchema = z
  .object({
    role: z.literal("PUBLISHER"),
    ...SessionIdentityShape,
    publicCardRevision: RevisionSchema,
    candidates: z.array(EvidenceCandidateSchema),
  })
  .strict();

export const AudienceSnapshotSchema = z
  .object({
    role: z.literal("PUBLIC_STAGE"),
    ...SessionIdentityShape,
    displayBindingEpoch: EpochSchema,
    publicPlaybackRevision: RevisionSchema,
    publicCardRevision: RevisionSchema,
    deck: PublishedDeckArtifactSchema,
    occurrence: PublicSlideOccurrenceSchema,
    blackout: z.boolean(),
    cards: z.array(PublishedAudienceCardSchema),
    tombstones: z.array(PublicationTombstoneSchema).optional().default([]),
    tombstoneWatermark: RevisionSchema,
  })
  .strict();

export const RoleSnapshotSchema = z.discriminatedUnion("role", [
  ControllerSnapshotSchema,
  PublisherSnapshotSchema,
  AudienceSnapshotSchema,
]);

export type Role = z.infer<typeof RoleSchema>;
export type RoleSession = z.infer<typeof RoleSessionSchema>;
export type PlaybackCommand = z.infer<typeof PlaybackCommandSchema>;
export type AcceptedCommandReceipt = z.infer<typeof AcceptedCommandReceiptSchema>;
export type StageAppliedReceipt = z.infer<typeof StageAppliedReceiptSchema>;
export type RejectedCommandReceipt = z.infer<typeof RejectedCommandReceiptSchema>;
export type CommandReceipt = z.infer<typeof CommandReceiptSchema>;
export type CommandRejectionReason = z.infer<typeof CommandRejectionReasonSchema>;
export type ControllerSnapshot = z.infer<typeof ControllerSnapshotSchema>;
export type AudienceSnapshot = z.infer<typeof AudienceSnapshotSchema>;
export type RoleSnapshot = z.infer<typeof RoleSnapshotSchema>;
