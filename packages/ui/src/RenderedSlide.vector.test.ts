import { describe, expect, test } from "bun:test";

import { isVectorSlide } from "./RenderedSlide";

describe("vector slide detection", () => {
  // This branch decides whether a slide is inlined or handed to an <img>. An SVG displayed
  // through <img> renders in a restricted mode that refuses external references, so a slide
  // misclassified as raster loses the background the render pipeline externalized — measured on a
  // real deck as zero of two background assets fetched, against both of two when inlined.
  test("classifies rendered vector slides by their path alone", () => {
    expect(isVectorSlide("/v1/deck-assets/manifest/slides/slide-1.svg")).toBe(true);
    expect(isVectorSlide("https://stage.example/v1/deck-assets/m/slides/slide-1.svg")).toBe(true);
    expect(isVectorSlide("/v1/deck-assets/m/slides/slide-1.SVG")).toBe(true);
    expect(isVectorSlide("/v1/deck-assets/m/slides/slide-1.svg?v=2")).toBe(true);
    expect(isVectorSlide("/v1/deck-assets/m/slides/slide-1.svg#page")).toBe(true);
  });

  test("leaves raster slides on the img path", () => {
    expect(isVectorSlide("/v1/deck-assets/manifest/slides/slide-1.png")).toBe(false);
    expect(isVectorSlide("/v1/deck-assets/manifest/slides/slide-1.jpg")).toBe(false);
    expect(isVectorSlide("/svg/slides/slide-1.png")).toBe(false);
  });

  // Resolving against a document location made the answer depend on a DOM existing, and a failed
  // resolution silently degraded a vector slide to the raster path — the exact defect above.
  test("does not depend on a document being present", () => {
    expect(isVectorSlide("slides/slide-1.svg")).toBe(true);
    expect(isVectorSlide("")).toBe(false);
  });
});
