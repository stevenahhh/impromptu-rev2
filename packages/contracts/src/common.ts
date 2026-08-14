import { z } from "zod";

export const OpaqueIdSchema = z.string().min(1).max(200);
export const VersionIdSchema = z.string().min(1).max(200);
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const EpochSchema = z.number().int().nonnegative();
export const RevisionSchema = z.number().int().nonnegative();
export const TimestampMsSchema = z.number().int().nonnegative();

export const PublicSlideOccurrenceSchema = z
  .object({
    publicSlideKey: OpaqueIdSchema,
    occurrenceSeq: z.number().int().positive(),
  })
  .strict();

export type PublicSlideOccurrence = z.infer<typeof PublicSlideOccurrenceSchema>;
