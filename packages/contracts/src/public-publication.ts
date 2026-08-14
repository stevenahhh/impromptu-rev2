import { z } from "zod";
import {
  PublicSlideOccurrenceSchema,
  Sha256Schema,
  TimestampMsSchema,
  VersionIdSchema,
} from "./common.ts";
import {
  DeckVersionIdSchema,
  ProjectionIdSchema,
  PublicCardRevisionSchema,
} from "./public-identifiers.ts";
import { PresentationSessionEpochSchema } from "./session-identifiers.ts";

export const PublishedAudienceCardSchema = z
  .object({
    projectionId: ProjectionIdSchema,
    status: z.literal("PUBLISHED"),
    mode: z.enum(["CURATED", "LIVE"]).optional(),
    leaseExpiresAtMs: TimestampMsSchema.nullable().optional(),
    publicationPolicyVersion: VersionIdSchema.optional(),
    cardVersion: VersionIdSchema.optional(),
    liveBinding: z
      .object({
        presentationSessionEpoch: PresentationSessionEpochSchema,
        publicSlideOccurrence: PublicSlideOccurrenceSchema,
        publicationPolicyVersion: VersionIdSchema,
        cardVersion: VersionIdSchema,
      })
      .strict()
      .optional(),
    claim: z.string().min(1).max(2_000),
    supportSummary: z.string().min(1).max(4_000),
    sourceLabel: z.string().min(1).max(500),
    publishedAtMs: TimestampMsSchema,
    expiresAtMs: TimestampMsSchema.nullable(),
    publicCardRevision: PublicCardRevisionSchema,
    deckVersion: DeckVersionIdSchema,
    manifestHash: Sha256Schema,
    occurrence: PublicSlideOccurrenceSchema,
  })
  .strict()
  .superRefine((card, context) => {
    if (card.mode !== "LIVE") {
      if (
        card.liveBinding !== undefined ||
        card.leaseExpiresAtMs !== undefined ||
        card.publicationPolicyVersion !== undefined ||
        card.cardVersion !== undefined
      ) {
        context.addIssue({ code: "custom", message: "curated cards cannot carry a live lease" });
      }
      return;
    }
    if (
      card.liveBinding === undefined ||
      card.leaseExpiresAtMs === undefined ||
      card.leaseExpiresAtMs === null ||
      card.leaseExpiresAtMs <= card.publishedAtMs ||
      card.leaseExpiresAtMs - card.publishedAtMs > 3_000 ||
      card.expiresAtMs !== card.leaseExpiresAtMs ||
      card.publicationPolicyVersion !== card.liveBinding.publicationPolicyVersion ||
      card.cardVersion !== card.liveBinding.cardVersion ||
      card.liveBinding.publicSlideOccurrence.publicSlideKey !== card.occurrence.publicSlideKey ||
      card.liveBinding.publicSlideOccurrence.occurrenceSeq !== card.occurrence.occurrenceSeq
    ) {
      context.addIssue({
        code: "custom",
        message: "live cards require a matching lease and binding",
      });
    }
  });

export const PublicationTombstoneSchema = z
  .object({
    projectionId: ProjectionIdSchema,
    status: z.enum(["RETRACTED", "EXPIRED"]),
    publicCardRevision: PublicCardRevisionSchema,
    occurredAtMs: TimestampMsSchema,
  })
  .strict();

export type PublishedAudienceCard = z.infer<typeof PublishedAudienceCardSchema>;
export type PublicationTombstone = z.infer<typeof PublicationTombstoneSchema>;
