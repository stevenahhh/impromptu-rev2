import { createHash } from "node:crypto";

import type { AccountId } from "@impromptu/contracts/private";
import { PrivateDeckContextSchema } from "@impromptu/contracts/private";
import { PublishedDeckArtifactSchema } from "@impromptu/contracts/public";
import { z } from "zod";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const ARTIFACT_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/;
const RenderManifestSlideSchema = z.object({
  slide_key: z.string().regex(/^slide_[0-9a-f]{64}$/),
  source_index: z.number().int().positive(),
  relative_path: z.string().min(1).max(191),
  content_sha256: Sha256Schema,
  width_points: z.number().positive(),
  height_points: z.number().positive(),
});
const RenderManifestSchema = z.object({
  deck_id: z.string().regex(/^deck_[0-9a-f]{64}$/),
  slides: z.array(RenderManifestSlideSchema),
  animation_eligible: z.boolean(),
  ineligible_reason: z.string().min(1).nullable(),
});
const RenderedDeckInputSchema = z.object({
  title: z.string().min(1),
  manifest: RenderManifestSchema,
  publicBaseUrl: z.url(),
});

export type RenderManifestSlide = z.infer<typeof RenderManifestSlideSchema>;
export type RenderManifest = z.infer<typeof RenderManifestSchema>;

export class RenderedDeckError extends Error {
  constructor(
    readonly code:
      | "render_manifest_empty"
      | "render_manifest_inconsistent"
      | "render_manifest_path_rejected",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "RenderedDeckError";
  }
}

/** Points are 1/72 inch; the public surface publishes a 720p-tall raster box. */
const PUBLISHED_SLIDE_HEIGHT = 720;

function publishedSize(slide: RenderManifestSlide): { width: number; height: number } {
  const ratio = slide.width_points / slide.height_points;
  return {
    width: Math.round(PUBLISHED_SLIDE_HEIGHT * ratio),
    height: PUBLISHED_SLIDE_HEIGHT,
  };
}

function requireContainedPath(value: string): string {
  const segments = value.split("/");
  if (
    !ARTIFACT_PATH_PATTERN.test(value) ||
    value.startsWith("/") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new RenderedDeckError(
      "render_manifest_path_rejected",
      `artifact path escapes the published deck directory: ${value}`,
    );
  }
  return value;
}

/**
 * Turn one render manifest into the private context plus the closed public artifact.
 *
 * The public artifact carries only slide keys, content hashes, and URLs: no renderer identity,
 * no extracted text, and no speaker notes ever cross this boundary.
 */
export function renderedDeckArtifacts(ownerAccountId: AccountId, value: unknown) {
  const input = RenderedDeckInputSchema.parse(value);
  const { manifest } = input;
  if (manifest.slides.length === 0) {
    throw new RenderedDeckError("render_manifest_empty", "the render produced no slides");
  }
  if (!manifest.animation_eligible && manifest.ineligible_reason === null) {
    throw new RenderedDeckError(
      "render_manifest_inconsistent",
      "an animation-ineligible render must name its reason",
    );
  }

  const sourceHash = manifest.deck_id.replace(/^deck_/, "");
  const base = input.publicBaseUrl.replace(/\/+$/, "");
  const ordered = [...manifest.slides].sort(
    (left, right) => left.source_index - right.source_index,
  );

  const publicDeck = PublishedDeckArtifactSchema.parse({
    deckVersion: `deck_${sourceHash}`,
    manifestHash: createHash("sha256")
      .update(
        `render-manifest:${manifest.deck_id}:${ordered.map((slide) => slide.content_sha256).join(":")}`,
        "utf8",
      )
      .digest("hex"),
    title: input.title,
    slides: ordered.map((slide, index) => {
      const size = publishedSize(slide);
      return {
        publicSlideKey: slide.slide_key,
        ordinal: index + 1,
        image: {
          url: `${base}/${requireContainedPath(slide.relative_path)}`,
          contentHash: slide.content_sha256,
          width: size.width,
          height: size.height,
        },
        accessibilityLabel: `${input.title} — slide ${index + 1}`,
      };
    }),
  });

  const privateDeck = PrivateDeckContextSchema.parse({
    deckId: `private_deck_${sourceHash}`,
    deckVersion: publicDeck.deckVersion,
    manifestHash: publicDeck.manifestHash,
    title: input.title,
    ownerAccountId,
    aclPolicyVersion: "acl-1",
    privateObjectPrefix: `private-decks/${ownerAccountId}/${sourceHash}`,
    slides: ordered.map((slide, index) => ({
      privateSlideId: `private_slide_${slide.content_sha256}`,
      publicSlideKey: slide.slide_key,
      ordinal: index + 1,
      speakerNotes: "",
      extractedText: "",
      sourceAssetIds: [`asset_${slide.content_sha256}`],
    })),
  });

  return { privateDeck, publicDeck, sourceHash };
}
