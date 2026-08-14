import { z } from "zod";
import { PublicSlideOccurrenceSchema, Sha256Schema, TimestampMsSchema } from "./common.ts";
import {
  DeckVersionIdSchema,
  ProjectionIdSchema,
  PublicCardRevisionSchema,
} from "./public-identifiers.ts";

export const PublishedAudienceCardSchema = z
  .object({
    projectionId: ProjectionIdSchema,
    status: z.literal("PUBLISHED"),
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
  .strict();

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
