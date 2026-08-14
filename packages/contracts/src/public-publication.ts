import { z } from "zod";
import {
  OpaqueIdSchema,
  PublicSlideOccurrenceSchema,
  RevisionSchema,
  Sha256Schema,
  TimestampMsSchema,
  VersionIdSchema,
} from "./common.ts";

export const PublishedAudienceCardSchema = z
  .object({
    projectionId: OpaqueIdSchema,
    status: z.literal("PUBLISHED"),
    claim: z.string().min(1).max(2_000),
    supportSummary: z.string().min(1).max(4_000),
    sourceLabel: z.string().min(1).max(500),
    publishedAtMs: TimestampMsSchema,
    expiresAtMs: TimestampMsSchema.nullable(),
    publicCardRevision: RevisionSchema,
    deckVersion: VersionIdSchema,
    manifestHash: Sha256Schema,
    occurrence: PublicSlideOccurrenceSchema,
  })
  .strict();

export const PublicationTombstoneSchema = z
  .object({
    projectionId: OpaqueIdSchema,
    status: z.enum(["RETRACTED", "EXPIRED"]),
    publicCardRevision: RevisionSchema,
    occurredAtMs: TimestampMsSchema,
  })
  .strict();

export type PublishedAudienceCard = z.infer<typeof PublishedAudienceCardSchema>;
export type PublicationTombstone = z.infer<typeof PublicationTombstoneSchema>;
