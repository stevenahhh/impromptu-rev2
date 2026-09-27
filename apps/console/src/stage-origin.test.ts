import { describe, expect, test } from "bun:test";

import { resolveStageOrigin, STAGE_ORIGIN, stageUrl } from "./stage-origin";

const FALLBACK = "http://localhost:4174";

describe("resolveStageOrigin", () => {
  test("falls back when the injected runtime origin is an empty string", () => {
    // Regression: the layout used to emit window.__STAGE_ORIGIN="" when no env was set, and the
    // empty string then won over every fallback, so stageUrl() produced "/?deck=..." on the
    // console's own origin. A blank runtime value must lose to the dev-server default.
    expect(resolveStageOrigin("", undefined)).toBe(FALLBACK);
    expect(resolveStageOrigin("   ", undefined)).toBe(FALLBACK);
  });

  test("falls back when nothing is configured at all", () => {
    expect(resolveStageOrigin(undefined, undefined)).toBe(FALLBACK);
    expect(resolveStageOrigin("", "")).toBe(FALLBACK);
    expect(resolveStageOrigin(null, undefined)).toBe(FALLBACK);
  });

  test("prefers the runtime origin over the build-time constant", () => {
    expect(resolveStageOrigin("https://stage.example.com", "https://stage.build.example.com")).toBe(
      "https://stage.example.com",
    );
    expect(resolveStageOrigin(undefined, "https://stage.build.example.com")).toBe(
      "https://stage.build.example.com",
    );
  });

  test("rejects non-URL and non-http(s) origins instead of propagating them", () => {
    expect(resolveStageOrigin("not a url", undefined)).toBe(FALLBACK);
    expect(resolveStageOrigin("javascript:alert(1)", undefined)).toBe(FALLBACK);
    expect(resolveStageOrigin("file:///etc/passwd", undefined)).toBe(FALLBACK);
    expect(resolveStageOrigin("javascript:alert(1)", "https://stage.example.com")).toBe(
      "https://stage.example.com",
    );
  });

  test("canonicalizes to the URL origin so paths and trailing slashes cannot leak", () => {
    expect(resolveStageOrigin("https://stage.example.com/", undefined)).toBe(
      "https://stage.example.com",
    );
    expect(resolveStageOrigin("https://stage.example.com:8443/app", undefined)).toBe(
      "https://stage.example.com:8443",
    );
  });
});

test("the exported STAGE_ORIGIN is always a usable absolute http(s) origin", () => {
  expect(STAGE_ORIGIN.length > 0).toBe(true);
  expect(URL.canParse(STAGE_ORIGIN)).toBe(true);
  const url = new URL(STAGE_ORIGIN);
  expect(url.protocol === "http:" || url.protocol === "https:").toBe(true);
  expect(STAGE_ORIGIN).toBe(url.origin);
});

test("stageUrl encodes the deck version onto the resolved origin", () => {
  expect(stageUrl("deck v1")).toBe(`${STAGE_ORIGIN}/?deck=deck%20v1`);
});
