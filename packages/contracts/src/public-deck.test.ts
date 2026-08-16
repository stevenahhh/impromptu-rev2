import { describe, expect, test } from "bun:test";
import { PublishedDeckArtifactSchema } from "./public-deck.ts";

/**
 * Failing-first contract for public deck artifact render metadata.
 *
 * A rendered SVG slide may carry optional strict runtime metadata:
 *   - runtime.timeline — the slide-runtime SVG timeline document
 *   - runtime.timeline.transition — slide transition metadata
 *   - runtime.fonts — embedded FontFace URLs
 * Slides without runtime (PDF exports, PPTX sources) keep the static image
 * fallback. PublishedDeckArtifactSchema does not yet carry `runtime`, so the
 * acceptance test below is expected to be RED (schema rejection) until the
 * production schema is updated.
 */

const ANIMATED_SLIDE_KEY = `slide_${"b".repeat(64)}`;
const IMAGE_URL = "https://public.test/deck/act-one.svg";
const CONTENT_HASH = "c".repeat(64);
const MANIFEST_HASH = "d".repeat(64);
const FONT_URL = "https://public.test/deck/fonts/serif-regular.woff2";

const runtimeEffect = {
  trigger: "on_click",
  effect_class: "entrance",
  preset_id: 1,
  preset_subtype: null,
  duration_ms: 300,
  delay_ms: 0,
  target: { shape_id: 1, shape_name: "Title", svg_element_id: "title" },
  behavior: { kind: "fade", direction: "in" },
} as const;

const runtimeTimeline = {
  slide_key: ANIMATED_SLIDE_KEY,
  click_groups: [[runtimeEffect]],
  transition: { kind: "fade", advance_on_click: true },
  unsupported: [],
} as const;

const runtimeMetadata = {
  timeline: runtimeTimeline,
  fonts: [FONT_URL],
} as const;

const baseSlide = {
  publicSlideKey: ANIMATED_SLIDE_KEY,
  ordinal: 1,
  image: { url: IMAGE_URL, contentHash: CONTENT_HASH, width: 1920, height: 1080 },
  accessibilityLabel: "Animated act one",
};

const baseArtifact = {
  deckVersion: "deck_alpha",
  manifestHash: MANIFEST_HASH,
  title: "Alpha deck",
  slides: [baseSlide],
};

describe("public deck artifact render metadata contract", () => {
  test("accepts a rendered SVG slide carrying strict runtime metadata", () => {
    const artifact = {
      ...baseArtifact,
      slides: [{ ...baseSlide, runtime: runtimeMetadata }],
    };

    const parsed = PublishedDeckArtifactSchema.parse(artifact);
    expect(parsed.slides[0]).toMatchObject({
      image: { url: IMAGE_URL, contentHash: CONTENT_HASH },
      runtime: runtimeMetadata,
    });
  });

  test("strictly rejects malformed runtime metadata", () => {
    // Unknown key inside the transition metadata.
    expect(() =>
      PublishedDeckArtifactSchema.parse({
        ...baseArtifact,
        slides: [
          {
            ...baseSlide,
            runtime: {
              ...runtimeMetadata,
              timeline: {
                ...runtimeTimeline,
                transition: { kind: "fade", advance_on_click: true, bogus: true },
              },
            },
          },
        ],
      }),
    ).toThrow();

    // Embedded font entries must be URLs.
    expect(() =>
      PublishedDeckArtifactSchema.parse({
        ...baseArtifact,
        slides: [
          {
            ...baseSlide,
            runtime: { timeline: runtimeTimeline, fonts: ["not-a-url"] },
          },
        ],
      }),
    ).toThrow();
  });

  test("preserves the static image fallback when runtime metadata is absent", () => {
    const parsed = PublishedDeckArtifactSchema.parse(baseArtifact);
    expect(parsed.slides[0]).toMatchObject({
      publicSlideKey: ANIMATED_SLIDE_KEY,
      ordinal: 1,
      image: { url: IMAGE_URL, contentHash: CONTENT_HASH, width: 1920, height: 1080 },
      accessibilityLabel: "Animated act one",
    });
    expect((parsed.slides[0] as { runtime?: unknown }).runtime).toBeUndefined();
  });
});
