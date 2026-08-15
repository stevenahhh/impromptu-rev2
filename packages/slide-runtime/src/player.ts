import {
  buildEffectKeyframes,
  computeGroupSchedule,
  entranceTargetIds,
  type RuntimeKeyframe,
} from "./animation.ts";
import { DeckNotAnimatableError, MissingTargetError, SlideRuntimeError } from "./errors.ts";
import type { SlideTimeline, UnsupportedEffect } from "./timeline.ts";

export * from "./animation.ts";
export * from "./errors.ts";

export interface RuntimeAnimationOptions {
  readonly delay: number;
  readonly duration: number;
  readonly easing: string;
  readonly fill: "forwards";
}

export interface RuntimeAnimation {
  readonly finished: Promise<unknown>;
  cancel(): void;
}

export interface RuntimeAnimationElement {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  /**
   * The descendants that actually carry paint. LibreOffice puts `fill` on the drawn
   * `path`/`rect` nodes, never on the group we target by id, so a colour animation applied
   * to the group would be silently ignored.
   */
  paintTargets(): readonly RuntimeAnimationElement[];
  animate(
    keyframes: readonly RuntimeKeyframe[],
    options: RuntimeAnimationOptions,
  ): RuntimeAnimation;
}

export interface RuntimeSvgRoot {
  readonly width: number;
  readonly height: number;
  getElementById(id: string): RuntimeAnimationElement | null;
}

export interface SlidePlayer {
  readonly groupCount: number;
  readonly currentGroup: number;
  readonly skipped: readonly UnsupportedEffect[];
  readonly state: "ready" | "playing" | "finished";
  advance(): Promise<void>;
  reset(): void;
}

interface PlayerOptions {
  readonly timeline: SlideTimeline;
  readonly allowUnsupported?: boolean;
}

interface RuntimePlayerOptions extends PlayerOptions {
  readonly root: RuntimeSvgRoot;
}

export interface CreateSlidePlayerOptions extends PlayerOptions {
  readonly svgRoot: SVGSVGElement;
}

interface TargetState {
  readonly element: RuntimeAnimationElement;
  readonly visibility: string | null;
}

class SlidePlayerController implements SlidePlayer {
  readonly groupCount: number;
  readonly skipped: readonly UnsupportedEffect[];
  private readonly targets = new Map<string, TargetState>();
  private readonly animations = new Set<RuntimeAnimation>();
  private groupIndex = 0;
  private playbackState: SlidePlayer["state"];

  constructor(
    private readonly root: RuntimeSvgRoot,
    private readonly timeline: SlideTimeline,
    allowUnsupported: boolean,
  ) {
    if (timeline.unsupported.length > 0 && !allowUnsupported) {
      throw new DeckNotAnimatableError();
    }
    if (root.width <= 0 || root.height <= 0) {
      throw new SlideRuntimeError("invalid_view_box", "The slide SVG viewBox must be positive");
    }
    this.groupCount = timeline.click_groups.length;
    this.skipped = allowUnsupported ? timeline.unsupported : [];
    this.playbackState = this.groupCount === 0 ? "finished" : "ready";
    for (const group of timeline.click_groups) {
      for (const effect of group) this.resolveTarget(effect.target.svg_element_id);
    }
    this.prepare();
  }

  get currentGroup(): number {
    return this.groupIndex;
  }

  get state(): SlidePlayer["state"] {
    return this.playbackState;
  }

  async advance(): Promise<void> {
    if (this.playbackState === "playing") {
      throw new SlideRuntimeError("player_busy", "The current click group is still playing");
    }
    const group = this.timeline.click_groups[this.groupIndex];
    if (group === undefined) {
      this.playbackState = "finished";
      return;
    }
    this.playbackState = "playing";
    const completions: Promise<unknown>[] = [];
    try {
      let previousAnimation: RuntimeAnimation | undefined;
      for (const scheduled of computeGroupSchedule(group)) {
        if (scheduled.effect.trigger === "after_previous" && previousAnimation !== undefined) {
          await previousAnimation.finished;
        }
        const id = scheduled.effect.target.svg_element_id;
        const target = this.targets.get(id);
        if (target === undefined) throw new MissingTargetError(id);
        if (scheduled.effect.effect_class === "entrance") {
          target.element.setAttribute("visibility", "visible");
        }
        const keyframes = buildEffectKeyframes(scheduled.effect, this.root);
        const options = {
          duration: scheduled.effect.duration_ms,
          delay: scheduled.effect.delay_ms,
          fill: "forwards",
          easing: "linear",
        } as const;
        const painted =
          scheduled.effect.behavior.kind === "color"
            ? target.element.paintTargets()
            : [target.element];
        let animation: RuntimeAnimation | undefined;
        for (const node of painted) {
          animation = node.animate(keyframes, options);
          this.animations.add(animation);
          completions.push(animation.finished);
        }
        previousAnimation = animation ?? previousAnimation;
      }
      await Promise.all(completions);
    } catch (error) {
      this.playbackState = "ready";
      throw error;
    }
    this.groupIndex += 1;
    this.playbackState = this.groupIndex === this.groupCount ? "finished" : "ready";
  }

  reset(): void {
    for (const animation of this.animations) animation.cancel();
    this.animations.clear();
    for (const target of this.targets.values()) {
      if (target.visibility === null) target.element.removeAttribute("visibility");
      else target.element.setAttribute("visibility", target.visibility);
    }
    this.groupIndex = 0;
    this.playbackState = this.groupCount === 0 ? "finished" : "ready";
    this.prepare();
  }

  private prepare(): void {
    for (const id of entranceTargetIds(this.timeline)) {
      this.resolveTarget(id).element.setAttribute("visibility", "hidden");
    }
  }

  private resolveTarget(id: string): TargetState {
    const existing = this.targets.get(id);
    if (existing !== undefined) return existing;
    const element = this.root.getElementById(id);
    if (element === null) throw new MissingTargetError(id);
    const target = { element, visibility: element.getAttribute("visibility") };
    this.targets.set(id, target);
    return target;
  }
}

export function createSlidePlayerFromRoot(options: RuntimePlayerOptions): SlidePlayer {
  return new SlidePlayerController(
    options.root,
    options.timeline,
    options.allowUnsupported === true,
  );
}

function wrapElement(element: Element): RuntimeAnimationElement {
  return {
    getAttribute: (name) => element.getAttribute(name),
    setAttribute: (name, value) => element.setAttribute(name, value),
    removeAttribute: (name) => element.removeAttribute(name),
    animate: (keyframes, animationOptions) => element.animate([...keyframes], animationOptions),
    paintTargets: () => {
      const painted = [...element.querySelectorAll("[fill]")].filter((candidate) => {
        const fill = candidate.getAttribute("fill");
        return fill !== null && fill !== "none";
      });
      return painted.length > 0 ? painted.map(wrapElement) : [wrapElement(element)];
    },
  };
}

export function createSlidePlayer(options: CreateSlidePlayerOptions): SlidePlayer {
  const svgRoot = options.svgRoot;
  const root: RuntimeSvgRoot = {
    width: svgRoot.viewBox.baseVal.width,
    height: svgRoot.viewBox.baseVal.height,
    getElementById(id) {
      const element = svgRoot.getElementById(id);
      if (element === null) return null;
      return wrapElement(element);
    },
  };
  if (options.allowUnsupported === undefined) {
    return createSlidePlayerFromRoot({ root, timeline: options.timeline });
  }
  return createSlidePlayerFromRoot({
    root,
    timeline: options.timeline,
    allowUnsupported: options.allowUnsupported,
  });
}
