import { describe, expect, test } from "bun:test";
import {
  buildEffectKeyframes,
  computeGroupSchedule,
  createSlidePlayerFromRoot,
  entranceTargetIds,
  isColourPaintTarget,
  motionPathToKeyframes,
  type RuntimeAnimation,
  type RuntimeAnimationElement,
  type RuntimeAnimationOptions,
  type RuntimeKeyframe,
  SlideRuntimeError,
} from "./player.ts";
import type { SlideEffect } from "./timeline.ts";
import { parseSlideTimeline } from "./timeline.ts";

const slideKey = `slide_${"b".repeat(64)}`;
function effect(
  id: string,
  trigger: SlideEffect["trigger"],
  behavior: SlideEffect["behavior"],
  durationMs = 100,
  delayMs = 0,
): SlideEffect {
  const timeline = parseSlideTimeline({
    slide_key: slideKey,
    click_groups: [
      [
        {
          trigger,
          effect_class:
            behavior.kind === "motion"
              ? "motion"
              : behavior.kind === "color"
                ? "emphasis"
                : behavior.direction === "out"
                  ? "exit"
                  : "entrance",
          preset_id: 1,
          duration_ms: durationMs,
          delay_ms: delayMs,
          target: { shape_id: 1, shape_name: id, svg_element_id: id },
          behavior,
        },
      ],
    ],
  });
  const parsed = timeline.click_groups[0]?.[0];
  if (parsed === undefined) throw new TypeError("effect fixture was not parsed");
  return parsed;
}
function timeline(
  groups: readonly (readonly SlideEffect[])[],
  unsupported: readonly object[] = [],
) {
  return parseSlideTimeline({ slide_key: slideKey, click_groups: groups, unsupported });
}
class FakeAnimation implements RuntimeAnimation {
  readonly finished: Promise<void>;
  private finishPlayback = (): void => {};
  constructor(pending: boolean) {
    this.finished = pending
      ? new Promise((resolve) => {
          this.finishPlayback = resolve;
        })
      : Promise.resolve();
  }
  cancel(): void {}
  finish(): void {
    this.finishPlayback();
  }
}
interface AnimationCall {
  readonly id: string;
  readonly keyframes: readonly RuntimeKeyframe[];
  readonly options: RuntimeAnimationOptions;
}
class FakeElement implements RuntimeAnimationElement {
  readonly attributes = new Map<string, string>();
  paints: readonly RuntimeAnimationElement[] = [];
  private readonly animation: FakeAnimation;
  constructor(
    readonly id: string,
    private readonly calls: AnimationCall[],
    pending: boolean,
  ) {
    this.animation = new FakeAnimation(pending);
  }
  paintTargets(): readonly RuntimeAnimationElement[] {
    return this.paints.length > 0 ? this.paints : [this];
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  animate(
    keyframes: readonly RuntimeKeyframe[],
    options: RuntimeAnimationOptions,
  ): RuntimeAnimation {
    this.calls.push({ id: this.id, keyframes, options });
    return this.animation;
  }
  finish(): void {
    this.animation.finish();
  }
}
function fakeRoot(ids: readonly string[], calls: AnimationCall[], pending: readonly string[] = []) {
  const elements = new Map(ids.map((id) => [id, new FakeElement(id, calls, pending.includes(id))]));
  return {
    width: 800,
    height: 600,
    getElementById(id: string) {
      return elements.get(id) ?? null;
    },
    element(id: string) {
      return elements.get(id);
    },
  };
}

describe("player pure logic", () => {
  test("computes entrance preparation targets once", () => {
    const enter = effect("shape-a", "on_click", { kind: "fade", direction: "in" });
    const exit = effect("shape-b", "on_click", { kind: "fade", direction: "out" });
    expect(entranceTargetIds(timeline([[enter], [enter, exit]]))).toEqual(["shape-a"]);
  });

  test("schedules with-previous from the prior start and after-previous from its finish", () => {
    const effects = [
      effect("a", "on_click", { kind: "fade", direction: "in" }, 100, 10),
      effect("b", "with_previous", { kind: "fade", direction: "in" }, 50, 5),
      effect("c", "after_previous", { kind: "fade", direction: "out" }, 20, 7),
    ];
    expect(
      computeGroupSchedule(effects).map(({ start_ms, animation_delay_ms }) => ({
        start_ms,
        animation_delay_ms,
      })),
    ).toEqual([
      { start_ms: 0, animation_delay_ms: 10 },
      { start_ms: 0, animation_delay_ms: 5 },
      { start_ms: 55, animation_delay_ms: 62 },
    ]);
  });

  test("constructs exact fade, wipe, color, and relative motion keyframes", () => {
    expect(
      buildEffectKeyframes(effect("a", "on_click", { kind: "fade", direction: "out" }), {
        width: 800,
        height: 600,
      }),
    ).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    expect(
      buildEffectKeyframes(
        effect("a", "on_click", { kind: "wipe", direction: "in", edge: "left" }),
        { width: 800, height: 600 },
      ),
    ).toEqual([{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }]);
    expect(
      buildEffectKeyframes(
        effect("a", "on_click", {
          kind: "color",
          from_color: "#112233",
          to_color: "#AABBCC",
        }),
        { width: 800, height: 600 },
      ),
    ).toEqual([{ fill: "#112233" }, { fill: "#AABBCC" }]);
    expect(motionPathToKeyframes("M 0 1 L 0 0 E", { width: 800, height: 600 })).toEqual([
      { transform: "translate(0px, 600px)", offset: 0 },
      { transform: "translate(0px, 0px)", offset: 1 },
    ]);
  });

  test("rejects motion commands that transform keyframes cannot represent exactly", () => {
    expect(() =>
      motionPathToKeyframes("M 0 0 C 0.2 0.3 0.8 0.7 1 1 E", { width: 800, height: 600 }),
    ).toThrow(SlideRuntimeError);
  });
});

describe("slide player", () => {
  test("prepares entrances and drives one click group through the animation surface", async () => {
    const calls: AnimationCall[] = [];
    const root = fakeRoot(["a", "b", "c"], calls, ["b"]);
    const player = createSlidePlayerFromRoot({
      root,
      timeline: timeline([
        [
          effect("a", "on_click", { kind: "fade", direction: "in" }, 100, 10),
          effect(
            "b",
            "with_previous",
            {
              kind: "color",
              from_color: "#112233",
              to_color: "#445566",
            },
            50,
            5,
          ),
          effect("c", "after_previous", { kind: "fade", direction: "out" }, 20, 7),
        ],
      ]),
    });
    expect(root.element("a")?.getAttribute("visibility")).toBe("hidden");
    const advancement = player.advance();
    expect(calls.map(({ id }) => id)).toEqual(["a", "b"]);
    root.element("b")?.finish();
    await advancement;

    expect(calls).toEqual([
      {
        id: "a",
        keyframes: [{ opacity: 0 }, { opacity: 1 }],
        options: { duration: 100, delay: 10, fill: "forwards", easing: "linear" },
      },
      {
        id: "b",
        keyframes: [{ fill: "#112233" }, { fill: "#445566" }],
        options: { duration: 50, delay: 5, fill: "forwards", easing: "linear" },
      },
      {
        id: "c",
        keyframes: [{ opacity: 1 }, { opacity: 0 }],
        options: { duration: 20, delay: 7, fill: "forwards", easing: "linear" },
      },
    ]);
    expect(player.currentGroup).toBe(1);
    expect(player.state).toBe("finished");
  });

  test("colour effects animate the painted descendants, not the wrapping group", async () => {
    const calls: AnimationCall[] = [];
    const root = fakeRoot(["group", "path-1", "path-2"], calls);
    const group = root.element("group");
    const first = root.element("path-1");
    const second = root.element("path-2");
    if (group === undefined || first === undefined || second === undefined) {
      throw new TypeError("fake elements missing");
    }
    group.paints = [first, second];
    const player = createSlidePlayerFromRoot({
      root,
      timeline: timeline([
        [
          effect(
            "group",
            "on_click",
            { kind: "color", from_color: "#0070C0", to_color: "#FF0000" },
            400,
          ),
        ],
      ]),
    });

    await player.advance();

    expect(calls.map(({ id }) => id)).toEqual(["path-1", "path-2"]);
    expect(calls[0]?.keyframes).toEqual([{ fill: "#0070C0" }, { fill: "#FF0000" }]);
  });

  test("fails closed for unsupported effects and reports missing SVG targets", () => {
    const root = fakeRoot([], []);
    expect(() =>
      createSlidePlayerFromRoot({
        root,
        timeline: timeline([], [{ reason_code: "unsupported_preset", detail: "unknown" }]),
      }),
    ).toThrow(SlideRuntimeError);
    expect(() =>
      createSlidePlayerFromRoot({
        root,
        timeline: timeline([[effect("missing", "on_click", { kind: "fade", direction: "in" })]]),
      }),
    ).toThrow(SlideRuntimeError);
  });

  test("colour targets cover shape geometry but never the shape's own text", () => {
    // LibreOffice paints a shape as <path fill="..."> and its label as <tspan fill="...">.
    // PowerPoint's "change fill colour" emphasis recolours the shape only; recolouring the
    // label too would hide the text behind its own background.
    const geometry = ["path", "rect", "ellipse", "polygon", "circle"];
    const textual = ["text", "tspan"];

    for (const tag of geometry) {
      expect(isColourPaintTarget(tag, "rgb(0,112,192)")).toBe(true);
    }
    for (const tag of textual) {
      expect(isColourPaintTarget(tag, "rgb(255,255,255)")).toBe(false);
    }
    expect(isColourPaintTarget("path", "none")).toBe(false);
    expect(isColourPaintTarget("path", null)).toBe(false);
  });
});
