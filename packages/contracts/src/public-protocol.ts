import { z } from "zod";
import {
  EpochSchema,
  OpaqueIdSchema,
  PublicSlideOccurrenceSchema,
  RevisionSchema,
  TimestampMsSchema,
} from "./common.ts";
import { PublishedDeckArtifactSchema } from "./public-deck.ts";
import { PublicationTombstoneSchema, PublishedAudienceCardSchema } from "./public-publication.ts";

const SessionIdentityShape = {
  presentationSessionId: OpaqueIdSchema,
  presentationSessionEpoch: EpochSchema,
} as const;

export const AudienceDisplaySessionSchema = z
  .object({
    audienceDisplaySessionId: OpaqueIdSchema,
    displayId: OpaqueIdSchema,
    displayBindingEpoch: EpochSchema,
    expiresAtMs: TimestampMsSchema,
  })
  .strict();

export const PublicStageSessionSchema = z
  .object({
    role: z.literal("PUBLIC_STAGE"),
    ...SessionIdentityShape,
    display: AudienceDisplaySessionSchema,
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
    tombstones: z.array(PublicationTombstoneSchema),
    tombstoneWatermark: RevisionSchema,
  })
  .strict();

export type AudienceDisplaySession = z.infer<typeof AudienceDisplaySessionSchema>;
export type PublicStageSession = z.infer<typeof PublicStageSessionSchema>;
export type AudienceSnapshot = z.infer<typeof AudienceSnapshotSchema>;
