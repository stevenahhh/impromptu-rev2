import { z } from "zod";
import { PublicSlideOccurrenceSchema, Sha256Schema, TimestampMsSchema } from "./common.ts";
import {
  ActorIdSchema,
  CommandIdSchema,
  ControllerEpochSchema,
  ControlRevisionSchema,
  PlaybackControlLeaseIdSchema,
} from "./control-identifiers.ts";
import { PrivateDeckContextSchema } from "./private-deck.ts";
import {
  DisplayBindingEpochSchema,
  PublicPlaybackRevisionSchema,
  PublicSlideKeySchema,
} from "./public-identifiers.ts";
import {
  PresentationSessionEpochSchema,
  PresentationSessionIdSchema,
} from "./session-identifiers.ts";

export * from "./control-identifiers.ts";

export const PlaybackControlLeaseSchema = z
  .object({
    leaseId: PlaybackControlLeaseIdSchema,
    presentationSessionId: PresentationSessionIdSchema,
    presentationSessionEpoch: PresentationSessionEpochSchema,
    actorId: ActorIdSchema,
    controllerEpoch: ControllerEpochSchema,
    expiresAtMs: TimestampMsSchema,
  })
  .strict();

const SessionIdentityShape = {
  presentationSessionId: PresentationSessionIdSchema,
  presentationSessionEpoch: PresentationSessionEpochSchema,
} as const;

export const ControllerSessionSchema = z
  .object({
    role: z.literal("CONTROLLER"),
    ...SessionIdentityShape,
    actorId: ActorIdSchema,
    lease: PlaybackControlLeaseSchema,
  })
  .strict();

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
  actorId: ActorIdSchema,
  leaseId: PlaybackControlLeaseIdSchema,
  controllerEpoch: ControllerEpochSchema,
  commandId: CommandIdSchema,
  baseRevision: ControlRevisionSchema,
  delivery: z.enum(["LIVE", "OFFLINE_REPLAY"]),
  displayBindingEpoch: DisplayBindingEpochSchema,
} as const;

export const SlideSetCommandSchema = z
  .object({
    type: z.literal("SLIDE_SET"),
    ...PlaybackCommandHeaderShape,
    publicSlideKey: PublicSlideKeySchema,
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
  actorId: ActorIdSchema,
  leaseId: PlaybackControlLeaseIdSchema,
  controllerEpoch: ControllerEpochSchema,
  commandId: CommandIdSchema,
  requestHash: Sha256Schema,
  displayBindingEpoch: DisplayBindingEpochSchema,
} as const;

export const AcceptedCommandReceiptSchema = z
  .object({
    status: z.literal("ACCEPTED"),
    ...ReceiptIdentityShape,
    acceptedControlRevision: ControlRevisionSchema,
  })
  .strict();
export const StageAppliedReceiptSchema = z
  .object({
    status: z.literal("STAGE_APPLIED"),
    ...ReceiptIdentityShape,
    acceptedControlRevision: ControlRevisionSchema,
    publicPlaybackRevision: PublicPlaybackRevisionSchema,
  })
  .strict();

export const SupersededCommandReceiptSchema = z
  .object({
    status: z.literal("SUPERSEDED"),
    ...ReceiptIdentityShape,
    acceptedControlRevision: ControlRevisionSchema,
    supersededByLeaseId: PlaybackControlLeaseIdSchema,
    supersededByControllerEpoch: ControllerEpochSchema,
  })
  .strict();

export const CommandRejectionReasonSchema = z.enum([
  "UNAUTHORIZED",
  "STALE_SESSION_EPOCH",
  "STALE_LEASE",
  "LEASE_EXPIRED",
  "STALE_CONTROLLER_EPOCH",
  "STALE_DISPLAY_BINDING",
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
  SupersededCommandReceiptSchema,
  RejectedCommandReceiptSchema,
]);

export const ControllerSnapshotSchema = z
  .object({
    role: z.literal("CONTROLLER"),
    ...SessionIdentityShape,
    lease: PlaybackControlLeaseSchema,
    controlRevision: ControlRevisionSchema,
    displayBindingEpoch: DisplayBindingEpochSchema,
    stageStatus: z.enum(["READY", "DISCONNECTED", "UNBOUND"]),
    deck: PrivateDeckContextSchema,
    occurrence: PublicSlideOccurrenceSchema,
    blackout: z.boolean(),
  })
  .strict();

export type PlaybackControlLease = z.infer<typeof PlaybackControlLeaseSchema>;
export type ControllerSession = z.infer<typeof ControllerSessionSchema>;
export type PlaybackCommand = z.infer<typeof PlaybackCommandSchema>;
export type AcceptedCommandReceipt = z.infer<typeof AcceptedCommandReceiptSchema>;
export type StageAppliedReceipt = z.infer<typeof StageAppliedReceiptSchema>;
export type SupersededCommandReceipt = z.infer<typeof SupersededCommandReceiptSchema>;
export type RejectedCommandReceipt = z.infer<typeof RejectedCommandReceiptSchema>;
export type CommandReceipt = z.infer<typeof CommandReceiptSchema>;
export type CommandRejectionReason = z.infer<typeof CommandRejectionReasonSchema>;
export type ControllerSnapshot = z.infer<typeof ControllerSnapshotSchema>;
