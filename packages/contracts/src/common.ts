import { z } from "zod";
import { PublicSlideKeySchema } from "./public-identifiers.ts";

export const VersionIdSchema = z.string().min(1).max(200);
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const TimestampMsSchema = z.number().int().nonnegative();

export const PublicSlideOccurrenceSchema = z
  .object({
    publicSlideKey: PublicSlideKeySchema,
    occurrenceSeq: z.number().int().positive(),
  })
  .strict();

export type PublicSlideOccurrence = z.infer<typeof PublicSlideOccurrenceSchema>;
