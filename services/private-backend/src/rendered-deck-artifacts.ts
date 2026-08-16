import { createHash } from "node:crypto";

import type { AccountId } from "@impromptu/contracts/private";
import { PrivateDeckContextSchema } from "@impromptu/contracts/private";
import { PublishedDeckArtifactSchema } from "@impromptu/contracts/public";
import { z } from "zod";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const SlideKeySchema = z.string().regex(/^slide_[0-9a-f]{64}$/);
const SvgElementIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/);
const HexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const ARTIFACT_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/;
const RenderManifestFontSchema = z
  .object({
    family: z.string().min(1).max(128),
    relative_path: z.string().min(1).max(191).nullable(),
    embedded: z.boolean(),
  })
  .superRefine((font, ctx) => {
    if (font.embedded && font.relative_path === null) {
      ctx.addIssue({
        code: "custom",
        message: "an embedded font must reference its extracted file",
      });
    }
  });

const RenderManifestBehaviorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("fade"),
      direction: z.enum(["in", "out"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("wipe"),
      direction: z.enum(["in", "out"]),
      edge: z.enum(["left", "right", "up", "down"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("motion"),
      path: z
        .string()
        .min(1)
        .max(4096)
        .regex(/^[MmLlCcQqAaHhVvZzEe0-9 ,.-]+$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("color"),
      from_color: HexColorSchema,
      to_color: HexColorSchema,
    })
    .strict(),
]);

const RenderManifestEffectSchema = z
  .object({
    trigger: z.enum(["on_click", "with_previous", "after_previous"]),
    effect_class: z.enum(["entrance", "emphasis", "exit", "motion"]),
    preset_id: z.number().int().min(0),
    preset_subtype: z.number().int().min(0).nullable(),
    duration_ms: z.number().int().min(0).max(600_000),
    delay_ms: z.number().int().min(0).max(600_000),
    target: z
      .object({
        shape_id: z.number().int().positive(),
        shape_name: z.string().min(1).max(128),
        svg_element_id: SvgElementIdSchema,
      })
      .strict(),
    behavior: RenderManifestBehaviorSchema,
  })
  .strict();

const RenderManifestTimelineSchema = z
  .object({
    slide_key: SlideKeySchema,
    click_groups: z.array(z.array(RenderManifestEffectSchema)),
    transition: z
      .object({
        kind: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
        advance_on_click: z.boolean(),
      })
      .strict()
      .nullable(),
    unsupported: z.array(
      z
        .object({
          reason_code: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
          preset_id: z.number().int().min(0).nullable(),
          detail: z.string().min(1).max(512),
        })
        .strict(),
    ),
  })
  .strict();

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
  fonts: z.array(RenderManifestFontSchema).default([]),
  timelines: z.array(RenderManifestTimelineSchema).default([]),
  animation_eligible: z.boolean(),
  ineligible_reason: z.string().min(1).nullable(),
});
const RenderedDeckInputSchema = z.object({
  title: z.string().min(1),
  manifest: RenderManifestSchema,
  publicBaseUrl: z.url(),
});

export type RenderManifestSlide = z.infer<typeof RenderManifestSlideSchema>;
export type RenderManifestFont = z.infer<typeof RenderManifestFontSchema>;
export type RenderManifestTimeline = z.infer<typeof RenderManifestTimelineSchema>;
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
 * Index timelines by slide key and reject a timeline set that cannot map to the
 * rendered slides exactly once: an emitted timeline that names no rendered
 * slide, a duplicated timeline key, or an emitted set that leaves a rendered
 * slide without its timeline would publish partial animation data.
 */
function timelineIndex(manifest: RenderManifest): Map<string, RenderManifestTimeline> {
  const slideKeys = new Set(manifest.slides.map((slide) => slide.slide_key));
  if (slideKeys.size !== manifest.slides.length) {
    throw new RenderedDeckError(
      "render_manifest_inconsistent",
      "a render manifest repeats a slide_key across rendered slides",
    );
  }

  const bySlideKey = new Map<string, RenderManifestTimeline>();
  for (const timeline of manifest.timelines) {
    if (!slideKeys.has(timeline.slide_key)) {
      throw new RenderedDeckError(
        "render_manifest_inconsistent",
        `timeline slide_key ${timeline.slide_key} does not match any rendered slide`,
      );
    }
    if (bySlideKey.has(timeline.slide_key)) {
      throw new RenderedDeckError(
        "render_manifest_inconsistent",
        `timeline slide_key ${timeline.slide_key} is emitted more than once`,
      );
    }
    bySlideKey.set(timeline.slide_key, timeline);
  }

  if (manifest.timelines.length > 0) {
    for (const slide of manifest.slides) {
      if (!bySlideKey.has(slide.slide_key)) {
        throw new RenderedDeckError(
          "render_manifest_inconsistent",
          `rendered slide ${slide.slide_key} has no matching timeline`,
        );
      }
    }
  }
  return bySlideKey;
}

/**
 * Turn one render manifest into the private context plus the closed public artifact.
 *
 * The public artifact carries only slide keys, content hashes, image/embedded-font
 * URLs, and per-slide animation timelines: no renderer identity, no extracted text,
 * and no speaker notes ever cross this boundary.
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

  const timelines = timelineIndex(manifest);
  const sourceHash = manifest.deck_id.replace(/^deck_/, "");
  const base = input.publicBaseUrl.replace(/\/+$/, "");
  const ordered = [...manifest.slides].sort(
    (left, right) => left.source_index - right.source_index,
  );

  // Only embedded fonts get published URLs; a declared-but-not-embedded font
  // (relative_path present, embedded false) stays out of the public surface.
  const fontUrls = manifest.fonts.flatMap((font) => {
    if (!font.embedded || font.relative_path === null) return [];
    return [`${base}/${requireContainedPath(font.relative_path)}`];
  });

  const runtimeBySlideKey = new Map<
    string,
    { timeline: RenderManifestTimeline; fonts: string[] }
  >();
  if (manifest.animation_eligible) {
    for (const timeline of timelines.values()) {
      if (timeline.unsupported.length > 0) {
        throw new RenderedDeckError(
          "render_manifest_inconsistent",
          `timeline for ${timeline.slide_key} records unsupported effects on an animation-eligible deck`,
        );
      }
      runtimeBySlideKey.set(timeline.slide_key, { timeline, fonts: fontUrls });
    }
  }

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
      const runtime = runtimeBySlideKey.get(slide.slide_key);
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
        ...(runtime === undefined ? {} : { runtime }),
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
