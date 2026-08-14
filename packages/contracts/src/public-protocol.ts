import { z } from "zod";
import { PublicSlideOccurrenceSchema, Sha256Schema, TimestampMsSchema } from "./common.ts";
import { safeEncodedCounterValue } from "./identity-base.ts";
import { PublishedDeckArtifactSchema } from "./public-deck.ts";
import {
  AudienceDisplaySessionIdSchema,
  DeckVersionIdSchema,
  DisplayBindingEpochSchema,
  DisplayBindingIdSchema,
  DisplayIdSchema,
  PublicCardRevisionSchema,
  PublicPlaybackRevisionSchema,
  publicCardRevisionValue,
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
  .strict()
  .superRefine((snapshot, context) => {
    const head = safeEncodedCounterValue(snapshot.publicCardRevision);
    const watermark = safeEncodedCounterValue(snapshot.tombstoneWatermark);
    if (head === null || watermark === null) return;
    if (watermark > head) {
      context.addIssue({
        code: "custom",
        path: ["tombstoneWatermark"],
        message: "watermark exceeds stream head",
      });
    }

    const active = new Set<string>();
    const terminal = new Set<string>();
    const revisions = new Set<number>();
    for (const [index, card] of snapshot.cards.entries()) {
      const revision = safeEncodedCounterValue(card.publicCardRevision);
      if (revision === null) continue;
      if (revision > head) {
        context.addIssue({
          code: "custom",
          path: ["cards", index, "publicCardRevision"],
          message: "card revision exceeds stream head",
        });
      }
      if (revision <= watermark) {
        context.addIssue({
          code: "custom",
          path: ["cards", index, "publicCardRevision"],
          message: "card is at or below the tombstone watermark",
        });
      }
      if (active.has(card.projectionId)) {
        context.addIssue({
          code: "custom",
          path: ["cards", index, "projectionId"],
          message: "duplicate active projection",
        });
      }
      if (revisions.has(revision)) {
        context.addIssue({
          code: "custom",
          path: ["cards", index, "publicCardRevision"],
          message: "duplicate stream revision",
        });
      }
      active.add(card.projectionId);
      revisions.add(revision);
    }
    for (const [index, tombstone] of snapshot.tombstones.entries()) {
      const revision = safeEncodedCounterValue(tombstone.publicCardRevision);
      if (revision === null) continue;
      if (revision > head) {
        context.addIssue({
          code: "custom",
          path: ["tombstones", index, "publicCardRevision"],
          message: "tombstone revision exceeds stream head",
        });
      }
      if (terminal.has(tombstone.projectionId)) {
        context.addIssue({
          code: "custom",
          path: ["tombstones", index, "projectionId"],
          message: "duplicate terminal projection",
        });
      }
      if (active.has(tombstone.projectionId)) {
        context.addIssue({
          code: "custom",
          path: ["tombstones", index, "projectionId"],
          message: "projection cannot be active and terminal",
        });
      }
      if (revisions.has(revision)) {
        context.addIssue({
          code: "custom",
          path: ["tombstones", index, "publicCardRevision"],
          message: "duplicate stream revision",
        });
      }
      terminal.add(tombstone.projectionId);
      revisions.add(revision);
    }
  });

export type DisplayBinding = z.infer<typeof DisplayBindingSchema>;
export type AudienceDisplaySession = z.infer<typeof AudienceDisplaySessionSchema>;
export type PublicStageSession = z.infer<typeof PublicStageSessionSchema>;
export type AudienceSnapshot = z.infer<typeof AudienceSnapshotSchema>;
