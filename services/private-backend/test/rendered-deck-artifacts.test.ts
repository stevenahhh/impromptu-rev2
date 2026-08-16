import { describe, expect, test } from "bun:test";

import { AccountIdSchema } from "@impromptu/contracts/private";
import {
  PublishedDeckArtifactSchema,
  RuntimeSlideTimelineSchema,
} from "@impromptu/contracts/public";

import {
  type RenderManifest,
  type RenderManifestTimeline,
  renderedDeckArtifacts,
} from "../src/rendered-deck-artifacts.ts";

const ACCOUNT = AccountIdSchema.parse("account_render_seam");

function manifest(overrides: Partial<RenderManifest> = {}): RenderManifest {
  return {
    deck_id: `deck_${"a".repeat(64)}`,
    slides: [
      {
        slide_key: `slide_${"b".repeat(64)}`,
        source_index: 1,
        relative_path: "slides/slide-1.svg",
        content_sha256: "c".repeat(64),
        width_points: 960,
        height_points: 540,
      },
      {
        slide_key: `slide_${"d".repeat(64)}`,
        source_index: 2,
        relative_path: "slides/slide-2.svg",
        content_sha256: "e".repeat(64),
        width_points: 960,
        height_points: 540,
      },
    ],
    animation_eligible: true,
    ineligible_reason: null,
    fonts: [],
    timelines: [],
    ...overrides,
  };
}

const VALID_EFFECT: RenderManifestTimeline["click_groups"][number][number] = {
  trigger: "on_click",
  effect_class: "entrance",
  preset_id: 1,
  preset_subtype: null,
  duration_ms: 300,
  delay_ms: 0,
  target: { shape_id: 1, shape_name: "Title", svg_element_id: "title" },
  behavior: { kind: "fade", direction: "in" },
};

const TIMELINE_FOR_SLIDE_B = RuntimeSlideTimelineSchema.parse({
  slide_key: `slide_${"b".repeat(64)}`,
  click_groups: [[VALID_EFFECT]],
  transition: { kind: "fade", advance_on_click: true },
  unsupported: [],
});

const TIMELINE_FOR_SLIDE_D = RuntimeSlideTimelineSchema.parse({
  slide_key: `slide_${"d".repeat(64)}`,
  click_groups: [],
  transition: null,
  unsupported: [],
});

describe("rendered deck artifacts", () => {
  test("publishes one public slide per rendered slide, in render order", () => {
    const artifacts = renderedDeckArtifacts(ACCOUNT, {
      title: "렌더된 발표",
      manifest: manifest(),
      publicBaseUrl: "https://public.example.test/decks",
    });

    const parsed = PublishedDeckArtifactSchema.parse(artifacts.publicDeck);
    expect(parsed.slides.map((slide) => slide.ordinal)).toEqual([1, 2]);
    expect(parsed.slides[0]?.image.contentHash).toBe("c".repeat(64));
    expect(parsed.slides[0]?.image.url).toBe(
      "https://public.example.test/decks/slides/slide-1.svg",
    );
    expect(parsed.slides[0]?.image.width).toBe(1280);
    expect(parsed.slides[0]?.image.height).toBe(720);
    expect(parsed.title).toBe("렌더된 발표");
  });

  test("carries no private text: the public artifact exposes only keys, urls and hashes", () => {
    const artifacts = renderedDeckArtifacts(ACCOUNT, {
      title: "발표",
      manifest: {
        ...manifest(),
        renderer: { name: "PRIVATE_RENDERER", version: "PRIVATE_VERSION" },
        speaker_notes: "PRIVATE_SPEAKER_NOTES",
      },
      publicBaseUrl: "https://public.example.test/decks",
    });

    const serialized = JSON.stringify(artifacts.publicDeck);
    expect(serialized).not.toContain("PRIVATE_RENDERER");
    expect(serialized).not.toContain("PRIVATE_SPEAKER_NOTES");
    expect(artifacts.privateDeck.slides).toHaveLength(2);
    expect(artifacts.privateDeck.slides[0]?.speakerNotes).toBe("");
  });

  test("refuses a deck the renderer marked animation-ineligible without a reason", () => {
    expect(() =>
      renderedDeckArtifacts(ACCOUNT, {
        title: "발표",
        manifest: manifest({ animation_eligible: false, ineligible_reason: null }),
        publicBaseUrl: "https://public.example.test/decks",
      }),
    ).toThrow(/render_manifest_inconsistent/);
  });

  test("refuses a manifest with no rendered slide", () => {
    expect(() =>
      renderedDeckArtifacts(ACCOUNT, {
        title: "발표",
        manifest: manifest({ slides: [] }),
        publicBaseUrl: "https://public.example.test/decks",
      }),
    ).toThrow(/render_manifest_empty/);
  });

  test("attaches exact per-slide timeline and font URL runtime for animation-eligible slides", () => {
    const artifacts = renderedDeckArtifacts(ACCOUNT, {
      title: "발표",
      manifest: manifest({
        fonts: [
          { family: "Pretendard", relative_path: "fonts/serif-regular.woff2", embedded: true },
          { family: "Noto Sans KR", relative_path: null, embedded: false },
        ],
        timelines: [TIMELINE_FOR_SLIDE_B, TIMELINE_FOR_SLIDE_D],
      }),
      publicBaseUrl: "https://public.example.test/decks",
    });

    expect(artifacts.publicDeck.slides).toHaveLength(2);
    const [first, second] = artifacts.publicDeck.slides;
    expect(first?.runtime).toBeDefined();
    expect(first?.runtime?.timeline).toEqual(TIMELINE_FOR_SLIDE_B);
    expect(first?.runtime?.fonts).toEqual([
      "https://public.example.test/decks/fonts/serif-regular.woff2",
    ]);
    expect(second?.runtime?.timeline).toEqual(TIMELINE_FOR_SLIDE_D);
  });

  test("omits runtime for animation-ineligible (PDF/static) slides and keeps the image fallback", () => {
    const artifacts = renderedDeckArtifacts(ACCOUNT, {
      title: "발표",
      manifest: manifest({
        animation_eligible: false,
        ineligible_reason: "pdf export carries no animation",
        fonts: [
          { family: "Pretendard", relative_path: "fonts/serif-regular.woff2", embedded: true },
        ],
        timelines: [TIMELINE_FOR_SLIDE_B, TIMELINE_FOR_SLIDE_D],
      }),
      publicBaseUrl: "https://public.example.test/decks",
    });

    for (const slide of artifacts.publicDeck.slides) {
      expect(slide.runtime).toBeUndefined();
      expect(slide.image.url).toMatch(
        /^https:\/\/public\.example\.test\/decks\/slides\/slide-[0-9]+\.svg$/,
      );
      expect(slide.image.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("rejects a timeline keyed to a slide that is not in this render", () => {
    expect(() =>
      renderedDeckArtifacts(ACCOUNT, {
        title: "발표",
        manifest: manifest({
          timelines: [
            {
              slide_key: `slide_${"f".repeat(64)}`,
              click_groups: [],
              transition: null,
              unsupported: [],
            },
            TIMELINE_FOR_SLIDE_D,
          ],
        }),
        publicBaseUrl: "https://public.example.test/decks",
      }),
    ).toThrow(/render_manifest_inconsistent/);
  });

  test("rejects duplicate timelines for the same slide key", () => {
    expect(() =>
      renderedDeckArtifacts(ACCOUNT, {
        title: "발표",
        manifest: manifest({ timelines: [TIMELINE_FOR_SLIDE_B, TIMELINE_FOR_SLIDE_B] }),
        publicBaseUrl: "https://public.example.test/decks",
      }),
    ).toThrow(/render_manifest_inconsistent/);
  });

  test("rejects an animation-eligible render whose slide is missing its timeline", () => {
    expect(() =>
      renderedDeckArtifacts(ACCOUNT, {
        title: "발표",
        manifest: manifest({ timelines: [TIMELINE_FOR_SLIDE_D] }),
        publicBaseUrl: "https://public.example.test/decks",
      }),
    ).toThrow(/render_manifest_inconsistent/);
  });

  test("rejects an embedded font file path that escapes the deck directory", () => {
    expect(() =>
      renderedDeckArtifacts(ACCOUNT, {
        title: "발표",
        manifest: manifest({
          fonts: [{ family: "Pretendard", relative_path: "../../etc/passwd", embedded: true }],
          timelines: [TIMELINE_FOR_SLIDE_B, TIMELINE_FOR_SLIDE_D],
        }),
        publicBaseUrl: "https://public.example.test/decks",
      }),
    ).toThrow(/render_manifest_path_rejected/);
  });

  test("refuses an artifact path that tries to escape the published deck directory", () => {
    expect(() =>
      renderedDeckArtifacts(ACCOUNT, {
        title: "발표",
        manifest: manifest({
          slides: [
            {
              slide_key: `slide_${"b".repeat(64)}`,
              source_index: 1,
              relative_path: "../../etc/passwd",
              content_sha256: "c".repeat(64),
              width_points: 960,
              height_points: 540,
            },
          ],
        }),
        publicBaseUrl: "https://public.example.test/decks",
      }),
    ).toThrow(/render_manifest_path_rejected/);
  });
});
