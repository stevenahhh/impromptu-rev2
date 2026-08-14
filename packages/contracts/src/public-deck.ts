import { z } from "zod";
import { OpaqueIdSchema, Sha256Schema, VersionIdSchema } from "./common.ts";

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
    publicSlideKey: OpaqueIdSchema,
    ordinal: z.number().int().positive(),
    image: PublishedSlideImageSchema,
    accessibilityLabel: z.string().min(1).max(1_000),
  })
  .strict();

export const PublishedDeckArtifactSchema = z
  .object({
    deckVersion: VersionIdSchema,
    manifestHash: Sha256Schema,
    title: z.string().min(1).max(500),
    slides: z.array(PublishedSlideSchema).min(1),
  })
  .strict();

export type PublishedDeckArtifact = z.infer<typeof PublishedDeckArtifactSchema>;
