import { z } from "zod";
import { Sha256Schema } from "./common.ts";
import { DeckVersionIdSchema, PublicSlideKeySchema } from "./public-identifiers.ts";

export const PublishedSlideImageSchema = z
  .object({
    url: z.url(),
    contentHash: Sha256Schema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();

export const PublishedSlideSchema = z
  .object({
    publicSlideKey: PublicSlideKeySchema,
    ordinal: z.number().int().positive(),
    image: PublishedSlideImageSchema,
    accessibilityLabel: z.string().min(1).max(1_000),
  })
  .strict();

export const PublishedDeckArtifactSchema = z
  .object({
    deckVersion: DeckVersionIdSchema,
    manifestHash: Sha256Schema,
    title: z.string().min(1).max(500),
    slides: z.array(PublishedSlideSchema).min(1),
  })
  .strict();

export type PublishedDeckArtifact = z.infer<typeof PublishedDeckArtifactSchema>;
