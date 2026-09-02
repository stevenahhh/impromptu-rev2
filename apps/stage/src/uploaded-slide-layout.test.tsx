import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());

const { act, cleanup, render, within } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");
const { StageRoutes } = await import("./App");

import type { StageSessionClient, StageSnapshotView } from "./stage-client";

afterEach(cleanup);

function nextStageEvent(type: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(2_000);
    window.addEventListener(type, () => resolve(), { once: true, signal });
    signal.addEventListener("abort", () => reject(new Error(`Stage event timeout: ${type}`)), {
      once: true,
    });
  });
}

function clientWithSlide(imageUrl: string, runtime = false): StageSessionClient {
  const publicSlideKey = runtime ? `slide_${"d".repeat(64)}` : "slide_uploaded";
  const snapshot: StageSnapshotView = {
    role: "PUBLIC_STAGE",
    stateHash: "a".repeat(64),
    presentationSessionId: "ps_layout",
    presentationSessionEpoch: "pse_1",
    displayBindingEpoch: "dbe_1",
    deckVersion: "deck_uploaded",
    manifestHash: "b".repeat(64),
    deckSlides: [
      {
        publicSlideKey,
        ordinal: 1,
        imageUrl,
        imageContentHash: "c".repeat(64),
        accessibilityLabel: "Uploaded page",
        ...(runtime
          ? {
              runtime: {
                timeline: {
                  slide_key: publicSlideKey,
                  click_groups: [],
                  transition: null,
                  unsupported: [],
                },
                fonts: [],
              },
            }
          : {}),
      },
    ],
    publicPlaybackRevision: "pbr_0",
    blackout: false,
    occurrence: { publicSlideKey, occurrenceSeq: 1 },
  };
  return {
    async createJoin() {
      throw new Error("not used");
    },
    async claim() {},
    async snapshot() {
      return snapshot;
    },
    async subscribe() {
      return { close() {} };
    },
    async recordApplied() {
      return null;
    },
  };
}

describe("uploaded Stage slide layout", () => {
  test("keeps runtime SVG in the same isolated presentation surface", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), {
      preconnect: originalFetch.preconnect,
    });
    try {
      const ready = nextStageEvent("impromptu:snapshot-applied");
      render(
        <MemoryRouter initialEntries={["/display/layout"]}>
          <StageRoutes client={clientWithSlide("https://public.test/runtime.svg", true)} />
        </MemoryRouter>,
      );
      await act(async () => ready);

      const runtime = document.body.querySelector("[data-slide-runtime]");
      expect(runtime).not.toBeNull();
      expect(runtime?.closest('[data-stage-slide-surface="uploaded"]')).not.toBeNull();
      expect(runtime?.closest(".stage-claim")).toBeNull();
    } finally {
      cleanup();
      globalThis.fetch = originalFetch;
    }
  });

  test("gives a static uploaded page an isolated contain-fit presentation surface", async () => {
    const ready = nextStageEvent("impromptu:snapshot-applied");
    render(
      <MemoryRouter initialEntries={["/display/layout"]}>
        <StageRoutes client={clientWithSlide("https://public.test/portrait-page.png")} />
      </MemoryRouter>,
    );
    await act(async () => ready);

    const image = within(document.body).getByRole("img", { name: "Uploaded page" });
    const surface = image.closest('[data-stage-slide-surface="uploaded"]');
    expect(surface).not.toBeNull();
    expect(image.closest(".stage-claim")).toBeNull();
    expect(surface?.querySelector(".stage-evidence")).toBeNull();
    expect(surface?.children).toHaveLength(1);
    expect(image.getAttribute("data-slide-fit")).toBe("contain");

    const stageCss = readFileSync(new URL("./stage.css", import.meta.url), "utf8");
    expect(stageCss).toMatch(
      /\.stage-slide\s*\{[^}]*position:\s*(?:relative|static);[^}]*object-fit:\s*contain;/s,
    );
    expect(stageCss).toMatch(/\.stage-slide-runtime\s*\{[^}]*position:\s*(?:relative|static);/s);
    expect(stageCss).toMatch(/\.stage-slide-runtime\s*>\s*svg\s*\{[^}]*object-fit:\s*contain;/s);
  });

  test("fills the viewport with the slide at full size and carries no chrome", async () => {
    const ready = nextStageEvent("impromptu:snapshot-applied");
    render(
      <MemoryRouter initialEntries={["/display/layout"]}>
        <StageRoutes client={clientWithSlide("https://public.test/wide-slide.png")} />
      </MemoryRouter>,
    );
    await act(async () => ready);

    // Nothing but the slide surface lives on the audience display.
    expect(document.querySelector(".stage-display__bar")).toBeNull();
    expect(document.querySelector(".stage-placement-message")).toBeNull();
    expect(document.querySelectorAll("button, a[href], input, [role='button']").length).toBe(0);

    const stageCss = readFileSync(new URL("./stage.css", import.meta.url), "utf8");
    // The display owns the whole viewport with no inset padding, so contain-fit can use every
    // pixel; the browser then scales the slide to the largest ratio-true fit via object-fit.
    expect(stageCss).toMatch(
      /\.stage-display\s*\{[^}]*height:\s*var\(--size-viewport\);[^}]*padding:\s*var\(--space-0\);/s,
    );
    expect(stageCss).toMatch(
      /\.stage-slide-surface\s*\{[^}]*width:\s*var\(--size-full\);[^}]*height:\s*var\(--size-full\);/s,
    );
  });
});
