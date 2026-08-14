import { z } from "zod";
import { Sha256Schema } from "./common.ts";

const UuidSchema = z.string().uuid();
const RevisionSchema = z.number().int().nonnegative();
const TimestampSchema = z.string().datetime({ offset: true });

export const UpsertProjectionPayloadSchema = z
  .object({
    presentationSessionEpoch: z.number().int().positive(),
    displayBindingEpoch: z.number().int().positive(),
    deckVersion: z.number().int().positive(),
    manifestHash: Sha256Schema,
    currentSlideKey: z.string().min(1).max(256).nullable(),
    occurrenceSeq: z.number().int().positive().nullable(),
    state: z.enum(["bound", "active"]),
    revision: RevisionSchema,
  })
  .strict()
  .refine(
    (payload) => (payload.currentSlideKey === null) === (payload.occurrenceSeq === null),
    "currentSlideKey and occurrenceSeq must both be null or both be present",
  );

export const PublishCardPayloadSchema = z
  .object({
    cardId: UuidSchema,
    cardVersion: z.number().int().positive(),
    publicSlideKey: z.string().min(1).max(256),
    occurrenceSeq: z.number().int().positive(),
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(2_000),
    sourceLabel: z.string().min(1).max(300),
    canonicalUrl: z.string().url().max(2_048),
    publishedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    revision: RevisionSchema,
  })
  .strict();

export const RetractCardPayloadSchema = z
  .object({
    cardId: UuidSchema,
    cardVersion: z.number().int().positive(),
    retractedAt: TimestampSchema,
    revision: RevisionSchema,
  })
  .strict();

export const EndProjectionPayloadSchema = z
  .object({
    endedAt: TimestampSchema,
    revision: RevisionSchema,
  })
  .strict();

const dispatchIdentityShape = {
  tenantId: UuidSchema,
  dispatchKey: UuidSchema,
  projectionId: UuidSchema,
};

export const PublicationDispatchSchema = z.discriminatedUnion("eventKind", [
  z
    .object({
      ...dispatchIdentityShape,
      eventKind: z.literal("upsert_projection"),
      publicPayload: UpsertProjectionPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...dispatchIdentityShape,
      eventKind: z.literal("publish_card"),
      publicPayload: PublishCardPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...dispatchIdentityShape,
      eventKind: z.literal("retract_card"),
      publicPayload: RetractCardPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...dispatchIdentityShape,
      eventKind: z.literal("end_projection"),
      publicPayload: EndProjectionPayloadSchema,
    })
    .strict(),
]);

export type PublicationDispatchDto = z.infer<typeof PublicationDispatchSchema>;
