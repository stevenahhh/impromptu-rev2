import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());

const { act, cleanup, fireEvent, render, within } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");

const { StageRoutes } = await import("./App");

import type { StageSessionClient, StageSnapshotView } from "./stage-client";

const originalFetch = globalThis.fetch;
const renderedSvg = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">',
  '  <g id="title" />',
  '  <g id="body" />',
  "</svg>",
].join("\n");
const renderedSvgBytes = new TextEncoder().encode(renderedSvg);
const renderedSvgDigest = await crypto.subtle.digest("SHA-256", renderedSvgBytes);
const renderedSvgHash = Array.from(new Uint8Array(renderedSvgDigest), (byte) =>
  byte.toString(16).padStart(2, "0"),
).join("");

Object.defineProperty(Element.prototype, "animate", {
  configurable: true,
  value(): Animation {
    return { finished: Promise.resolve(), cancel() {} } as unknown as Animation;
  },
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

/**
 * Failing-first spec for animated-render consumption on the public Stage.
 *
 * The deck snapshot is enriched with slide-runtime documents: a rendered SVG slide carries
 * `runtime.timeline` (click groups, transition metadata, unsupported effects) and
 * `runtime.fonts` (embedded FontFace URLs). Rendered SVG slides must mount the slide-runtime
 * player; PDF exports and PPTX sources carry no runtime and must stay static images.
 * This file is expected to be RED until the Stage consumes the runtime.
 */

const ANIMATED_SLIDE_KEY = `slide_${"b".repeat(64)}`;

interface RuntimeEffectJson {
  readonly trigger: "on_click" | "with_previous" | "after_previous";
  readonly effect_class: "entrance" | "emphasis" | "exit" | "motion";
  readonly preset_id: number;
  readonly preset_subtype: number | null;
  readonly duration_ms: number;
  readonly delay_ms: number;
  readonly target: {
    readonly shape_id: number;
    readonly shape_name: string;
    readonly svg_element_id: string;
  };
  readonly behavior: { readonly kind: "fade"; readonly direction: "in" };
}

interface RenderedSlideRuntime {
  readonly timeline: {
    readonly slide_key: string;
    readonly click_groups: readonly (readonly RuntimeEffectJson[])[];
    readonly transition: { readonly kind: "fade"; readonly advance_on_click: boolean } | null;
    readonly unsupported: readonly unknown[];
  };
  readonly fonts: readonly {
    readonly family: string;
    readonly url: string;
    readonly format: "woff2";
  }[];
}

type RenderedSlide = StageSnapshotView["deckSlides"][number] & {
  readonly runtime?: RenderedSlideRuntime;
};

const animatedTimeline: RenderedSlideRuntime["timeline"] = {
  slide_key: ANIMATED_SLIDE_KEY,
  click_groups: [
    [
      {
        trigger: "on_click",
        effect_class: "entrance",
        preset_id: 1,
        preset_subtype: null,
        duration_ms: 300,
        delay_ms: 0,
        target: { shape_id: 1, shape_name: "Title", svg_element_id: "title" },
        behavior: { kind: "fade", direction: "in" },
      },
    ],
    [
      {
        trigger: "on_click",
        effect_class: "entrance",
        preset_id: 2,
        preset_subtype: null,
        duration_ms: 300,
        delay_ms: 0,
        target: { shape_id: 2, shape_name: "Body", svg_element_id: "body" },
        behavior: { kind: "fade", direction: "in" },
      },
    ],
  ],
  transition: { kind: "fade", advance_on_click: true },
  unsupported: [],
};

const animatedFonts = [
  {
    family: "Serif Regular",
    url: "https://public.test/deck/fonts/serif-regular.woff2",
    format: "woff2" as const,
  },
  {
    family: "Serif Bold",
    url: "https://public.test/deck/fonts/serif-bold.woff2",
    format: "woff2" as const,
  },
];

const renderedSlides: readonly RenderedSlide[] = [
  {
    publicSlideKey: ANIMATED_SLIDE_KEY,
    ordinal: 1,
    imageUrl: "https://public.test/deck/act-one.svg",
    imageContentHash: renderedSvgHash,
    accessibilityLabel: "Animated act one",
    runtime: { timeline: animatedTimeline, fonts: animatedFonts },
  },
  {
    publicSlideKey: "slide_pdf",
    ordinal: 2,
    imageUrl: "https://public.test/deck/fallback.pdf",
    imageContentHash: "d".repeat(64),
    accessibilityLabel: "Fallback handout",
  },
  {
    publicSlideKey: "slide_pptx",
    ordinal: 3,
    imageUrl: "https://public.test/deck/original.pptx",
    imageContentHash: "e".repeat(64),
    accessibilityLabel: "Original source",
  },
];

function nextStageEvent(type: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onEvent = (event: Event) => {
      clearTimeout(timeout);
      window.removeEventListener(type, onEvent);
      resolve(event instanceof CustomEvent ? event.detail : null);
    };
    window.addEventListener(type, onEvent);
    const timeout = setTimeout(() => {
      window.removeEventListener(type, onEvent);
      reject(new Error(`Stage event timeout: ${type}`));
    }, 2_000);
  });
}

function snapshotFixture(occurrenceKey: string): StageSnapshotView {
  return {
    role: "PUBLIC_STAGE",
    stateHash: "a".repeat(64),
    presentationSessionId: "ps_alpha",
    presentationSessionEpoch: "pse_1",
    displayBindingEpoch: "dbe_1",
    deckVersion: "deck_alpha",
    manifestHash: "b".repeat(64),
    deckSlides: renderedSlides as unknown as StageSnapshotView["deckSlides"],
    publicPlaybackRevision: "pbr_0",
    publicationPolicyVersion: null,
    blackout: false,
    occurrence: { publicSlideKey: occurrenceKey, occurrenceSeq: 1 },
    cards: [],
    publicCardRevision: "pcr_0",
    tombstoneWatermark: "pcr_0",
    tombstoneRetentionMs: 60_000,
  };
}

function deferred<Value>() {
  let resolve: ((value: Value) => void) | null = null;
  const promise = new Promise<Value>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return {
    promise,
    resolve(value: Value) {
      if (resolve === null) throw new Error("deferred already resolved");
      const current = resolve;
      resolve = null;
      current(value);
    },
  };
}

function nextRuntimeActive(): Promise<void> {
  const player = document.body.querySelector("[data-slide-runtime]");
  if (player === null) throw new Error("rendered slide player was not mounted");
  return new Promise((resolve, reject) => {
    const originalSetAttribute = player.setAttribute;
    Object.defineProperty(player, "setAttribute", {
      configurable: true,
      value(name: string, value: string) {
        originalSetAttribute.call(player, name, value);
        if (name !== "data-slide-runtime" || value !== "active") return;
        clearTimeout(timeout);
        Reflect.deleteProperty(player, "setAttribute");
        resolve();
      },
    });
    const timeout = setTimeout(() => {
      Reflect.deleteProperty(player, "setAttribute");
      reject(
        new Error(
          `rendered slide player did not become active; current=${player.getAttribute(
            "data-slide-runtime",
          )}`,
        ),
      );
    }, 2_000);
  });
}

function renderRenderedSlide(occurrenceKey: string) {
  const svgBytes = deferred<ArrayBuffer>();
  globalThis.fetch = Object.assign(
    async () =>
      ({
        ok: true,
        status: 200,
        text: async () => renderedSvg,
        arrayBuffer: async () => svgBytes.promise,
      }) as Response,
    { preconnect: originalFetch.preconnect },
  );
  const client: StageSessionClient = {
    async createJoin() {
      throw new Error("not used");
    },
    async claim() {},
    async snapshot() {
      return snapshotFixture(occurrenceKey);
    },
    async subscribe() {
      return { close() {} };
    },
    async recordApplied() {
      return null;
    },
  };
  const rendered = render(
    <MemoryRouter initialEntries={["/display/display_alpha"]}>
      <StageRoutes client={client} />
    </MemoryRouter>,
  );
  return {
    ...rendered,
    releaseSvg() {
      svgBytes.resolve(Uint8Array.from(renderedSvgBytes).buffer);
    },
  };
}

describe("rendered slide consumption", () => {
  test("mounts a slide-runtime player for an eligible SVG and loads its embedded FontFace URLs", async () => {
    const snapshotApplied = nextStageEvent("impromptu:snapshot-applied");
    const rendered = renderRenderedSlide(ANIMATED_SLIDE_KEY);
    await act(async () => snapshotApplied);
    const runtimeActive = nextRuntimeActive();
    await act(async () => {
      rendered.releaseSvg();
      await runtimeActive;
    });

    // The eligible SVG mounts the slide-runtime player instead of a static image.
    const player = document.body.querySelector("[data-slide-runtime]");
    expect(player).not.toBeNull();
    expect(player?.getAttribute("data-slide-key")).toBe(ANIMATED_SLIDE_KEY);
    expect(player?.getAttribute("data-click-groups")).toBe("2");
    expect(document.body.querySelector('img.stage-slide[src$=".svg"]')).toBeNull();

    // Transition metadata from the timeline runs on the mounted player.
    expect(player?.getAttribute("data-transition")).toBe("fade");

    // Every embedded FontFace URL is wired into the document as a font resource.
    for (const font of animatedFonts) {
      const preload = document.head.querySelector(
        `link[rel="preload"][as="font"][href="${font.url}"]`,
      );
      expect(preload).not.toBeNull();
    }
  });

  test("next action advances the click group before navigating", async () => {
    const snapshotApplied = nextStageEvent("impromptu:snapshot-applied");
    const rendered = renderRenderedSlide(ANIMATED_SLIDE_KEY);
    await act(async () => snapshotApplied);
    const runtimeActive = nextRuntimeActive();
    await act(async () => {
      rendered.releaseSvg();
      await runtimeActive;
    });

    const player = () => document.body.querySelector("[data-slide-runtime]");
    expect(player()).not.toBeNull();
    expect(player()?.getAttribute("data-click-group")).toBe("0");

    // First next action: advances click group 0 -> 1, stays on the same slide.
    await act(async () => fireEvent.keyDown(window, { key: "ArrowRight" }));
    expect(player()?.getAttribute("data-click-group")).toBe("1");
    expect(player()?.getAttribute("data-slide-key")).toBe(ANIMATED_SLIDE_KEY);
    expect(document.body.querySelector("img.stage-slide")).toBeNull();

    // Second next action: advances click group 1 -> 2 (all groups consumed).
    await act(async () => fireEvent.keyDown(window, { key: "ArrowRight" }));
    expect(player()?.getAttribute("data-click-group")).toBe("2");
    expect(player()?.getAttribute("data-slide-key")).toBe(ANIMATED_SLIDE_KEY);

    // Only once every click group is consumed does the next action navigate.
    const localSlide = nextStageEvent("impromptu:local-slide");
    await act(async () => fireEvent.keyDown(window, { key: "ArrowRight" }));
    expect(await localSlide).toEqual({ publicSlideKey: "slide_pdf", occurrenceSeq: 2 });
    expect(document.body.querySelector("[data-slide-runtime]")).toBeNull();
    expect(
      within(document.body).getByRole("img", { name: "Fallback handout" }).getAttribute("src"),
    ).toBe("https://public.test/deck/fallback.pdf");
  });

  test("ignores modified ArrowRight without advancing or navigating", async () => {
    const snapshotApplied = nextStageEvent("impromptu:snapshot-applied");
    const rendered = renderRenderedSlide(ANIMATED_SLIDE_KEY);
    await act(async () => snapshotApplied);
    const runtimeActive = nextRuntimeActive();
    await act(async () => {
      rendered.releaseSvg();
      await runtimeActive;
    });

    await act(async () => fireEvent.keyDown(window, { key: "ArrowRight", ctrlKey: true }));

    const player = document.body.querySelector("[data-slide-runtime]");
    expect(player?.getAttribute("data-click-group")).toBe("0");
    expect(player?.getAttribute("data-slide-key")).toBe(ANIMATED_SLIDE_KEY);
  });

  test("uses PageDown for the next click group instead of skipping the slide", async () => {
    const snapshotApplied = nextStageEvent("impromptu:snapshot-applied");
    const rendered = renderRenderedSlide(ANIMATED_SLIDE_KEY);
    await act(async () => snapshotApplied);
    const runtimeActive = nextRuntimeActive();
    await act(async () => {
      rendered.releaseSvg();
      await runtimeActive;
    });

    await act(async () => fireEvent.keyDown(window, { key: "PageDown" }));

    const player = document.body.querySelector("[data-slide-runtime]");
    expect(player?.getAttribute("data-click-group")).toBe("1");
    expect(player?.getAttribute("data-slide-key")).toBe(ANIMATED_SLIDE_KEY);
  });

  test("keeps PDF and ineligible PPTX slides as static images", async () => {
    const snapshotApplied = nextStageEvent("impromptu:snapshot-applied");
    renderRenderedSlide("slide_pdf");
    await act(async () => snapshotApplied);

    // A PDF export carries no runtime document: it stays a static image.
    const pdf = within(document.body).getByRole("img", { name: "Fallback handout" });
    expect(pdf.getAttribute("src")).toBe("https://public.test/deck/fallback.pdf");
    expect(document.body.querySelector("[data-slide-runtime]")).toBeNull();

    // A PPTX source slide is ineligible for animation too.
    await act(async () => fireEvent.keyDown(window, { key: "ArrowRight" }));
    const pptx = within(document.body).getByRole("img", { name: "Original source" });
    expect(pptx.getAttribute("src")).toBe("https://public.test/deck/original.pptx");
    expect(document.body.querySelector("[data-slide-runtime]")).toBeNull();
  });
});
