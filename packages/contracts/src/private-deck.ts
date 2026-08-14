import { z } from "zod";
import { OpaqueIdSchema, Sha256Schema, VersionIdSchema } from "./common.ts";

export const PrivateSlideContextSchema = z
  .object({
    privateSlideId: OpaqueIdSchema,
    publicSlideKey: OpaqueIdSchema.nullable(),
    ordinal: z.number().int().positive(),
    speakerNotes: z.string(),
    extractedText: z.string(),
    sourceAssetIds: z.array(OpaqueIdSchema),
  })
  .strict();

export const PrivateDeckContextSchema = z
  .object({
    deckId: OpaqueIdSchema,
    deckVersion: VersionIdSchema,
    manifestHash: Sha256Schema,
    title: z.string().min(1).max(500),
    ownerAccountId: OpaqueIdSchema,
    aclPolicyVersion: VersionIdSchema,
    privateObjectPrefix: z.string().min(1),
    slides: z.array(PrivateSlideContextSchema).min(1),
  })
  .strict();

export type PrivateDeckContext = z.infer<typeof PrivateDeckContextSchema>;
