import { z } from "zod";
import { Sha256Schema, VersionIdSchema } from "./common.ts";
import {
  AccountIdSchema,
  PrivateAssetIdSchema,
  PrivateDeckIdSchema,
  PrivateSlideIdSchema,
} from "./private-identifiers.ts";
import { DeckVersionIdSchema, PublicSlideKeySchema } from "./public-identifiers.ts";

export const PrivateSlideContextSchema = z
  .object({
    privateSlideId: PrivateSlideIdSchema,
    publicSlideKey: PublicSlideKeySchema.nullable(),
    ordinal: z.number().int().positive(),
    speakerNotes: z.string(),
    extractedText: z.string(),
    sourceAssetIds: z.array(PrivateAssetIdSchema),
  })
  .strict();

export const PrivateDeckContextSchema = z
  .object({
    deckId: PrivateDeckIdSchema,
    deckVersion: DeckVersionIdSchema,
    manifestHash: Sha256Schema,
    title: z.string().min(1).max(500),
    ownerAccountId: AccountIdSchema,
    aclPolicyVersion: VersionIdSchema,
    privateObjectPrefix: z.string().min(1),
    slides: z.array(PrivateSlideContextSchema).min(1),
  })
  .strict();

export type PrivateDeckContext = z.infer<typeof PrivateDeckContextSchema>;
