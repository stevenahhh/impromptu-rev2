import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { PublishedSlideRuntime } from "@impromptu/contracts";
import { createRef } from "react";

import { RenderedSlidePlayer, type RenderedSlidePlayerHandle } from "./rendered-slide-player";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());

const { act, cleanup, fireEvent, render } = await import("@testing-library/react");

const SLIDE_KEY = `slide_${"b".repeat(64)}` as PublishedSlideRuntime["timeline"]["slide_key"];
const IMAGE_URL = "https://public.test/deck/act-one.svg";
const FONT_URL = "https://public.test/deck/fonts/serif-regular.woff2";

const SVG_DOCUMENT = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="1920" height="1080">',
  '  <g id="title" />',
  '  <g id="body" />',
  "</svg>",
].join("\n");

async function sha256(source: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const SVG_HASH = await sha256(SVG_DOCUMENT);

const animatedRuntime: PublishedSlideRuntime = {
  timeline: {
    slide_key: SLIDE_KEY,
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
  },
  fonts: [{ family: "Serif Regular", url: FONT_URL, format: "woff2" }],
};

const slide = {
  publicSlideKey: SLIDE_KEY,
  imageUrl: IMAGE_URL,
  imageContentHash: SVG_HASH,
  accessibilityLabel: "Animated act one",
};

// The slide-runtime player drives the Web Animations API, which happy-dom does not
// implement. A deterministic immediate-resolve surface keeps the behavior tests
// timing-free: every advance completes on the microtask queue, never on a clock.
const recordedAnimations: Array<{ readonly targetId: string | null }> = [];
const cancelledAnimationTargets: string[] = [];
type AnimationFactory = (target: Element) => Animation;
const resolvedAnimation: AnimationFactory = (target) =>
  ({
    finished: Promise.resolve(),
    cancel: () => {
      cancelledAnimationTargets.push(target.getAttribute("id") ?? "anonymous");
    },
  }) as unknown as Animation;
let animationFactory = resolvedAnimation;
Object.defineProperty(Element.prototype, "animate", {
  configurable: true,
  value(
    this: Element,
    _keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
    _options?: KeyframeAnimationOptions,
  ): Animation {
    recordedAnimations.push({ targetId: this.getAttribute("id") });
    return animationFactory(this);
  },
});

interface FetchCall {
  readonly url: string;
  readonly signal: AbortSignal | null;
}

function fetchResponse(svgText: string, ok = true): Response {
  const bytes = new TextEncoder().encode(svgText);
  return {
    ok,
    status: ok ? 200 : 500,
    text: async () => svgText,
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  } as unknown as Response;
}

function stubFetch(svgText: string, ok = true): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, signal: init?.signal ?? null });
    return fetchResponse(svgText, ok);
  }) as unknown as typeof fetch;
  return calls;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const originalFetch = globalThis.fetch;

class FakeFontFace {
  static readonly instances: FakeFontFace[] = [];
  static loadCalls = 0;
  static loadBarrier: Promise<void> | null = null;
  readonly family: string;
  readonly source: string;
  constructor(family: string, source: string) {
    this.family = family;
    this.source = source;
    FakeFontFace.instances.push(this);
  }
  async load(): Promise<FakeFontFace> {
    FakeFontFace.loadCalls += 1;
    await FakeFontFace.loadBarrier;
    return this;
  }
}

const fontSet: { readonly added: unknown[]; readonly deleted: unknown[] } = {
  added: [],
  deleted: [],
};

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  FakeFontFace.instances.length = 0;
  FakeFontFace.loadCalls = 0;
  FakeFontFace.loadBarrier = null;
  fontSet.added.length = 0;
  fontSet.deleted.length = 0;
  recordedAnimations.length = 0;
  cancelledAnimationTargets.length = 0;
  animationFactory = resolvedAnimation;
  delete (document as unknown as { fonts?: unknown }).fonts;
  delete (globalThis as unknown as { FontFace?: unknown }).FontFace;
});

function host() {
  return document.body.querySelector("[data-slide-runtime]");
}

function waitForRuntimeStatus(expected: "active" | "error"): Promise<void> {
  if (host()?.getAttribute("data-slide-runtime") === expected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      if (host()?.getAttribute("data-slide-runtime") !== expected) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["data-slide-runtime"],
      childList: true,
      subtree: true,
    });
    const signal = AbortSignal.timeout(2_000);
    signal.addEventListener(
      "abort",
      () => {
        observer.disconnect();
        reject(
          new Error(
            `runtime did not enter ${expected}; current=${host()?.getAttribute("data-slide-runtime")}`,
          ),
        );
      },
      { once: true },
    );
  });
}

async function settleRuntimeStatus(expected: "active" | "error"): Promise<void> {
  await act(async () => waitForRuntimeStatus(expected));
}

describe("RenderedSlidePlayer", () => {
  test("keeps completed static and rendered slides fully legible", () => {
    const stageCss = readFileSync(new URL("./stage.css", import.meta.url), "utf8");

    expect(stageCss).toMatch(
      /\.stage-slide,\s*\.stage-slide-runtime\s*\{[^}]*opacity:\s*var\(--opacity-full\);/s,
    );
    expect(stageCss).toMatch(
      /@keyframes stage-slide-fade\s*\{.*to\s*\{\s*opacity:\s*var\(--opacity-full\);/s,
    );
  });

  test("mounts the fetched SVG and exposes deterministic runtime state", async () => {
    const fetches = stubFetch(SVG_DOCUMENT);
    const ref = createRef<RenderedSlidePlayerHandle>();
    render(<RenderedSlidePlayer ref={ref} slide={slide} runtime={animatedRuntime} />);
    await settleRuntimeStatus("active");

    expect(fetches).toHaveLength(1);
    expect(fetches[0]?.url).toBe(IMAGE_URL);

    const player = host();
    expect(player?.getAttribute("data-slide-runtime")).toBe("active");
    expect(player?.getAttribute("data-slide-key")).toBe(SLIDE_KEY);
    expect(player?.getAttribute("data-click-groups")).toBe("2");
    expect(player?.getAttribute("data-click-group")).toBe("0");
    expect(player?.getAttribute("data-transition")).toBe("fade");
    expect(player?.getAttribute("data-transition-complete")).toBe("false");

    // The contained SVG is mounted as a real element tree, not an injected string.
    const svg = player?.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("viewBox")).toBe("0 0 1920 1080");
    expect(svg?.getElementById("title")).not.toBeNull();
    expect(svg?.getElementById("body")).not.toBeNull();
    expect(player?.querySelector("img.stage-slide")).toBeNull();

    // Without FontFace support the structured font is still preloaded safely.
    const preload = document.head.querySelector(
      `link[rel="preload"][as="font"][href="${FONT_URL}"]`,
    );
    expect(preload).not.toBeNull();
  });

  test("drops inert LibreOffice foreign-namespace metadata but mounts the SVG drawing", async () => {
    const libreOfficeSvg = [
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:anim="urn:oasis:names:tc:opendocument:xmlns:animation:1.0" viewBox="0 0 1920 1080">',
      '  <defs id="presentation-animations"><anim:par><anim:seq /></anim:par></defs>',
      '  <g id="title" />',
      '  <g id="body" />',
      "</svg>",
    ].join("\n");
    stubFetch(libreOfficeSvg);
    render(
      <RenderedSlidePlayer
        slide={{ ...slide, imageContentHash: await sha256(libreOfficeSvg) }}
        runtime={animatedRuntime}
      />,
    );
    await settleRuntimeStatus("active");

    expect(host()?.querySelector("svg")).not.toBeNull();
    expect(host()?.querySelector('[id="presentation-animations"]')).not.toBeNull();
    expect(host()?.querySelector("anim\\:par")).toBeNull();
    expect(host()?.querySelector('[id="title"]')).not.toBeNull();
  });

  test("advances click groups before firing the exhaustion callback", async () => {
    stubFetch(SVG_DOCUMENT);
    const ref = createRef<RenderedSlidePlayerHandle>();
    const exhaustionCalls: Array<{
      readonly clickGroup: string | null;
      readonly exhausted: boolean;
    }> = [];
    render(
      <RenderedSlidePlayer
        ref={ref}
        slide={slide}
        runtime={animatedRuntime}
        onAllClickGroupsExhausted={() => {
          exhaustionCalls.push({
            clickGroup: host()?.getAttribute("data-click-group") ?? null,
            exhausted: ref.current?.exhausted ?? false,
          });
        }}
      />,
    );
    await settleRuntimeStatus("active");

    expect(ref.current?.exhausted).toBe(false);

    // First advance consumes click group 0 and stays short of exhaustion.
    await act(async () => {
      expect(await ref.current?.advance()).toBe(true);
    });
    expect(host()?.getAttribute("data-click-group")).toBe("1");
    expect(host()?.getAttribute("data-transition-complete")).toBe("false");
    expect(exhaustionCalls).toHaveLength(0);

    // Second advance consumes the final group: the DOM reflects it and only then
    // does the exhaustion callback fire.
    await act(async () => {
      expect(await ref.current?.advance()).toBe(true);
    });
    expect(host()?.getAttribute("data-click-group")).toBe("2");
    expect(host()?.getAttribute("data-transition-complete")).toBe("false");
    expect(ref.current?.exhausted).toBe(true);
    expect(exhaustionCalls).toEqual([{ clickGroup: "2", exhausted: true }]);

    const player = host();
    if (player === null) throw new Error("runtime host missing");
    fireEvent.animationEnd(player, { animationName: "stage-slide-fade" });
    expect(player.getAttribute("data-transition-complete")).toBe("true");

    // Once exhausted, advance is a no-op and the callback never fires again.
    await act(async () => {
      expect(await ref.current?.advance()).toBe(false);
    });
    expect(exhaustionCalls).toHaveLength(1);
  });

  test("fires exhaustion once for a runtime with no click groups", async () => {
    stubFetch(SVG_DOCUMENT);
    const calls: string[] = [];
    render(
      <RenderedSlidePlayer
        slide={slide}
        runtime={{
          ...animatedRuntime,
          timeline: { ...animatedRuntime.timeline, click_groups: [], transition: null },
        }}
        onAllClickGroupsExhausted={() => calls.push("exhausted")}
      />,
    );
    await settleRuntimeStatus("active");

    const player = host();
    expect(player?.getAttribute("data-slide-runtime")).toBe("active");
    expect(player?.getAttribute("data-click-groups")).toBe("0");
    expect(player?.getAttribute("data-click-group")).toBe("0");
    expect(player?.getAttribute("data-transition")).toBe("none");
    expect(player?.getAttribute("data-transition-complete")).toBe("true");
    expect(calls).toEqual(["exhausted"]);
  });

  test("waits for embedded FontFace readiness before activating the SVG", async () => {
    stubFetch(SVG_DOCUMENT);
    (globalThis as unknown as { FontFace?: unknown }).FontFace = FakeFontFace;
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        add(face: unknown) {
          fontSet.added.push(face);
        },
        delete(face: unknown) {
          fontSet.deleted.push(face);
        },
      },
    });
    const fontReady = deferred<void>();
    FakeFontFace.loadBarrier = fontReady.promise;
    const { unmount } = render(<RenderedSlidePlayer slide={slide} runtime={animatedRuntime} />);

    expect(host()?.getAttribute("data-slide-runtime")).toBe("loading");
    expect(host()?.querySelector("svg")).toBeNull();
    expect(fontSet.added).toHaveLength(0);

    const becameActive = waitForRuntimeStatus("active");
    await act(async () => {
      fontReady.resolve();
      await becameActive;
    });

    expect(host()?.getAttribute("data-slide-runtime")).toBe("active");
    expect(FakeFontFace.instances).toHaveLength(1);
    expect(FakeFontFace.instances[0]?.family).toBe("Serif Regular");
    expect(FakeFontFace.instances[0]?.source).toBe(`url("${FONT_URL}") format("woff2")`);
    expect(fontSet.added).toHaveLength(1);
    expect(FakeFontFace.loadCalls).toBe(1);
    // FontFace supersedes the preload fallback for named embedded fonts.
    expect(
      document.head.querySelector(`link[rel="preload"][as="font"][href="${FONT_URL}"]`),
    ).toBeNull();

    unmount();
    expect(fontSet.deleted).toEqual(fontSet.added);
  });

  test("falls back to the static image when the SVG cannot be mounted", async () => {
    const invalidDocument = "<html>not an svg</html>";
    stubFetch(invalidDocument);
    const ref = createRef<RenderedSlidePlayerHandle>();
    const calls: string[] = [];
    render(
      <RenderedSlidePlayer
        ref={ref}
        slide={{ ...slide, imageContentHash: await sha256(invalidDocument) }}
        runtime={animatedRuntime}
        onAllClickGroupsExhausted={() => calls.push("exhausted")}
      />,
    );
    await settleRuntimeStatus("error");

    const player = host();
    expect(player?.getAttribute("data-slide-runtime")).toBe("error");
    const fallback = player?.querySelector("img.stage-slide");
    expect(fallback?.getAttribute("src")).toBe(IMAGE_URL);
    expect(fallback?.getAttribute("alt")).toBe("Animated act one");
    expect(player?.querySelector("svg")).toBeNull();
    expect(calls).toHaveLength(0);

    await act(async () => {
      expect(await ref.current?.advance()).toBe(false);
    });
    expect(calls).toHaveLength(0);
  });

  test("does not consume click groups or report exhaustion while the SVG is loading", async () => {
    const response = deferred<Response>();
    globalThis.fetch = (async () => response.promise) as unknown as typeof fetch;
    const ref = createRef<RenderedSlidePlayerHandle>();
    render(<RenderedSlidePlayer ref={ref} slide={slide} runtime={animatedRuntime} />);

    expect(host()?.getAttribute("data-slide-runtime")).toBe("loading");
    expect(ref.current?.exhausted).toBe(false);
    await act(async () => {
      expect(await ref.current?.advance()).toBe(false);
    });
    expect(host()?.getAttribute("data-click-group")).toBe("0");
    expect(ref.current?.exhausted).toBe(false);

    const becameActive = waitForRuntimeStatus("active");
    await act(async () => {
      response.resolve(fetchResponse(SVG_DOCUMENT));
      await becameActive;
    });
    expect(host()?.getAttribute("data-slide-runtime")).toBe("active");
    expect(ref.current?.exhausted).toBe(false);
  });

  test("resets click groups when a new occurrence of the same slide arrives", async () => {
    const fetches = stubFetch(SVG_DOCUMENT);
    const ref = createRef<RenderedSlidePlayerHandle>();
    const view = render(
      <RenderedSlidePlayer ref={ref} slide={slide} runtime={animatedRuntime} occurrenceSeq={1} />,
    );
    await settleRuntimeStatus("active");
    await act(async () => {
      expect(await ref.current?.advance()).toBe(true);
    });
    expect(host()?.getAttribute("data-click-group")).toBe("1");

    view.rerender(
      <RenderedSlidePlayer ref={ref} slide={slide} runtime={animatedRuntime} occurrenceSeq={2} />,
    );
    await settleRuntimeStatus("active");

    expect(fetches).toHaveLength(2);
    expect(host()?.getAttribute("data-click-group")).toBe("0");
    expect(ref.current?.exhausted).toBe(false);
  });

  test("fails back safely when an animation completion rejects", async () => {
    stubFetch(SVG_DOCUMENT);
    const animationFinished = deferred<void>();
    animationFactory = (target) =>
      ({
        finished: animationFinished.promise,
        cancel: () => {
          cancelledAnimationTargets.push(target.getAttribute("id") ?? "anonymous");
        },
      }) as unknown as Animation;
    const ref = createRef<RenderedSlidePlayerHandle>();
    render(<RenderedSlidePlayer ref={ref} slide={slide} runtime={animatedRuntime} />);
    await settleRuntimeStatus("active");

    const advancement = ref.current?.advance();
    animationFinished.reject(new DOMException("cancelled", "AbortError"));
    await act(async () => {
      expect(await advancement).toBe(false);
    });

    expect(host()?.getAttribute("data-slide-runtime")).toBe("error");
    expect(host()?.querySelector("svg")).toBeNull();
    expect(host()?.querySelector("img.stage-slide")).not.toBeNull();
    expect(cancelledAnimationTargets).toContain("title");
  });

  test("settles an in-flight advance when unmount cancels its animation", async () => {
    stubFetch(SVG_DOCUMENT);
    const animationFinished = deferred<void>();
    animationFactory = (target) =>
      ({
        finished: animationFinished.promise,
        cancel: () => {
          cancelledAnimationTargets.push(target.getAttribute("id") ?? "anonymous");
          animationFinished.reject(new DOMException("cancelled", "AbortError"));
        },
      }) as unknown as Animation;
    const ref = createRef<RenderedSlidePlayerHandle>();
    const { unmount } = render(
      <RenderedSlidePlayer ref={ref} slide={slide} runtime={animatedRuntime} />,
    );
    await settleRuntimeStatus("active");

    const advancement = ref.current?.advance();
    unmount();

    expect(await advancement).toBe(false);
    expect(cancelledAnimationTargets).toContain("title");
  });

  test("rejects mismatched SVG bytes before mounting a live element tree", async () => {
    stubFetch(SVG_DOCUMENT.replace('<g id="body" />', '<g id="body" data-tampered="true" />'));
    render(<RenderedSlidePlayer slide={slide} runtime={animatedRuntime} />);
    const becameError = waitForRuntimeStatus("error");
    await act(async () => becameError);

    expect(host()?.getAttribute("data-slide-runtime")).toBe("error");
    expect(host()?.querySelector("svg")).toBeNull();
    expect(host()?.querySelector("img.stage-slide")).not.toBeNull();
  });

  test("rejects active SVG content even when its bytes match the published hash", async () => {
    const activeSvg = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" onload="alert(1)">',
      '  <script>alert("active")</script>',
      '  <g id="title" />',
      '  <g id="body" />',
      "</svg>",
    ].join("\n");
    stubFetch(activeSvg);
    render(
      <RenderedSlidePlayer
        slide={{ ...slide, imageContentHash: await sha256(activeSvg) }}
        runtime={animatedRuntime}
      />,
    );
    const becameError = waitForRuntimeStatus("error");
    await act(async () => becameError);

    expect(host()?.getAttribute("data-slide-runtime")).toBe("error");
    expect(host()?.querySelector("svg")).toBeNull();
    expect(document.body.querySelector("script")).toBeNull();
  });

  test("reports only the supported fade transition and completes it on animation end", async () => {
    stubFetch(SVG_DOCUMENT);
    render(
      <RenderedSlidePlayer
        slide={slide}
        runtime={{
          ...animatedRuntime,
          timeline: {
            ...animatedRuntime.timeline,
            transition: { kind: "push", advance_on_click: true },
          },
        }}
      />,
    );
    await settleRuntimeStatus("active");

    expect(host()?.getAttribute("data-transition")).toBe("none");
    expect(host()?.getAttribute("data-transition-complete")).toBe("true");
  });

  test("cleans up animations, font preloads, and aborts in-flight fetches on unmount", async () => {
    const fetches = stubFetch(SVG_DOCUMENT);
    const ref = createRef<RenderedSlidePlayerHandle>();
    const { unmount } = render(
      <RenderedSlidePlayer ref={ref} slide={slide} runtime={animatedRuntime} />,
    );
    await settleRuntimeStatus("active");
    await act(async () => {
      await ref.current?.advance();
    });

    expect(recordedAnimations).toHaveLength(1);
    expect(recordedAnimations[0]?.targetId).toBe("title");
    expect(cancelledAnimationTargets).toHaveLength(0);
    const preload = document.head.querySelector(
      `link[rel="preload"][as="font"][href="${FONT_URL}"]`,
    );
    expect(preload).not.toBeNull();
    const mounted = host();
    expect(mounted?.querySelector("svg")).not.toBeNull();

    unmount();

    expect(mounted?.querySelector("svg")).toBeNull();
    expect(
      document.head.querySelector(`link[rel="preload"][as="font"][href="${FONT_URL}"]`),
    ).toBeNull();
    expect(fetches[0]?.signal?.aborted).toBe(true);
    expect(cancelledAnimationTargets).toContain("title");
    expect(ref.current).toBeNull();
  });
});
