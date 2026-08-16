import { describe, expect, test } from "bun:test";

import { AccountIdSchema } from "@impromptu/contracts/private";
import { PublishedDeckArtifactSchema } from "@impromptu/contracts/public";

import { type RenderManifest, renderedDeckArtifacts } from "../src/rendered-deck-artifacts.ts";

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
    ...overrides,
  };
}

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
