import { z } from "zod";
import { PublicSlideOccurrenceSchema, Sha256Schema, TimestampMsSchema } from "./common.ts";
import { PublishedDeckArtifactSchema } from "./public-deck.ts";
import {
  AudienceDisplaySessionIdSchema,
  DeckVersionIdSchema,
  DisplayBindingEpochSchema,
  DisplayBindingIdSchema,
  DisplayIdSchema,
  PublicCardRevisionSchema,
  PublicPlaybackRevisionSchema,
} from "./public-identifiers.ts";
import { PublicationTombstoneSchema, PublishedAudienceCardSchema } from "./public-publication.ts";
import {
  PresentationSessionEpochSchema,
  PresentationSessionIdSchema,
} from "./session-identifiers.ts";

const SessionIdentityShape = {
  presentationSessionId: PresentationSessionIdSchema,
  presentationSessionEpoch: PresentationSessionEpochSchema,
} as const;

export const DisplayBindingSchema = z
  .object({
    displayBindingId: DisplayBindingIdSchema,
    ...SessionIdentityShape,
    displayId: DisplayIdSchema,
    displayBindingEpoch: DisplayBindingEpochSchema,
    deckVersion: DeckVersionIdSchema,
    manifestHash: Sha256Schema,
  })
  .strict();

export const AudienceDisplaySessionSchema = z
  .object({
    audienceDisplaySessionId: AudienceDisplaySessionIdSchema,
    binding: DisplayBindingSchema,
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
    displayBindingEpoch: DisplayBindingEpochSchema,
    publicPlaybackRevision: PublicPlaybackRevisionSchema,
    publicCardRevision: PublicCardRevisionSchema,
    deck: PublishedDeckArtifactSchema,
    occurrence: PublicSlideOccurrenceSchema,
    blackout: z.boolean(),
    cards: z.array(PublishedAudienceCardSchema),
    tombstones: z.array(PublicationTombstoneSchema),
    tombstoneWatermark: PublicCardRevisionSchema,
  })
  .strict();

export type DisplayBinding = z.infer<typeof DisplayBindingSchema>;
export type AudienceDisplaySession = z.infer<typeof AudienceDisplaySessionSchema>;
export type PublicStageSession = z.infer<typeof PublicStageSessionSchema>;
export type AudienceSnapshot = z.infer<typeof AudienceSnapshotSchema>;
