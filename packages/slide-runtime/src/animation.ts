import { MotionPathError, SlideRuntimeError } from "./errors.ts";
import type { Behavior, SlideEffect, SlideTimeline } from "./timeline.ts";

export interface RuntimeKeyframe extends Keyframe {
  readonly clipPath?: string;
  readonly fill?: string;
  readonly offset?: number;
  readonly opacity?: number;
  readonly transform?: string;
}

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface ScheduledEffect {
  readonly effect: SlideEffect;
  readonly start_ms: number;
  readonly animation_delay_ms: number;
}

function assertNever(value: never): never {
  throw new SlideRuntimeError(
    "invalid_motion_path",
    `Unhandled animation variant: ${String(value)}`,
  );
}

export function entranceTargetIds(timeline: SlideTimeline): readonly string[] {
  const ids = new Set<string>();
  for (const group of timeline.click_groups) {
    for (const effect of group) {
      if (effect.effect_class === "entrance") ids.add(effect.target.svg_element_id);
    }
  }
  return [...ids];
}

export function computeGroupSchedule(effects: readonly SlideEffect[]): readonly ScheduledEffect[] {
  const schedule: ScheduledEffect[] = [];
  let previous: ScheduledEffect | undefined;
  for (const effect of effects) {
    let startMs = 0;
    if (previous === undefined) {
      if (effect.trigger !== "on_click") {
        throw new SlideRuntimeError("invalid_group_trigger", "A click group must start on click");
      }
    } else {
      switch (effect.trigger) {
        case "with_previous":
          startMs = previous.start_ms;
          break;
        case "after_previous":
          startMs = previous.animation_delay_ms + previous.effect.duration_ms;
          break;
        case "on_click":
          throw new SlideRuntimeError(
            "invalid_group_trigger",
            "Only the first group effect may start on click",
          );
        default:
          return assertNever(effect.trigger);
      }
    }
    const scheduled = {
      effect,
      start_ms: startMs,
      animation_delay_ms: startMs + effect.delay_ms,
    };
    schedule.push(scheduled);
    previous = scheduled;
  }
  return schedule;
}

function wipeInset(edge: Extract<Behavior, { readonly kind: "wipe" }>["edge"]): string {
  switch (edge) {
    case "left":
      return "inset(0 100% 0 0)";
    case "right":
      return "inset(0 0 0 100%)";
    case "up":
      return "inset(0 0 100% 0)";
    case "down":
      return "inset(100% 0 0 0)";
    default:
      return assertNever(edge);
  }
}

export function buildEffectKeyframes(
  effect: SlideEffect,
  viewport: ViewportSize,
): readonly RuntimeKeyframe[] {
  const behavior = effect.behavior;
  switch (behavior.kind) {
    case "fade":
      return behavior.direction === "in"
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [{ opacity: 1 }, { opacity: 0 }];
    case "wipe": {
      const clipped = { clipPath: wipeInset(behavior.edge) };
      const open = { clipPath: "inset(0 0 0 0)" };
      return behavior.direction === "in" ? [clipped, open] : [open, clipped];
    }
    case "motion":
      return motionPathToKeyframes(behavior.path, viewport);
    case "color":
      return [{ fill: behavior.from_color }, { fill: behavior.to_color }];
    default:
      return assertNever(behavior);
  }
}

interface Point {
  readonly x: number;
  readonly y: number;
}

function tokenizeMotionPath(path: string): readonly string[] {
  const tokenPattern = /[MLCZE]|-?(?:\d+(?:\.\d*)?|\.\d+)/g;
  const tokens: string[] = [];
  let cursor = 0;
  let match = tokenPattern.exec(path);
  while (match !== null) {
    if (!/^[\s,]*$/.test(path.slice(cursor, match.index))) {
      throw new MotionPathError("Motion path contains an unsupported command or token");
    }
    tokens.push(match[0]);
    cursor = match.index + match[0].length;
    match = tokenPattern.exec(path);
  }
  if (!/^[\s,]*$/.test(path.slice(cursor))) {
    throw new MotionPathError("Motion path has invalid syntax");
  }
  return tokens;
}

function parseMotionPoints(path: string, viewport: ViewportSize): readonly Point[] {
  const tokens = tokenizeMotionPath(path);
  const points: Point[] = [];
  let first: Point | undefined;
  let index = 0;
  const number = (): number => {
    const token = tokens[index];
    if (token === undefined || /^[MLCZE]$/.test(token)) {
      throw new MotionPathError("Motion path command has missing coordinates");
    }
    index += 1;
    return Number(token);
  };
  while (index < tokens.length) {
    const command = tokens[index];
    index += 1;
    if (command === "E") {
      if (index !== tokens.length || points.length === 0) {
        throw new MotionPathError("Invalid end marker");
      }
      break;
    }
    if (command === "C") {
      throw new MotionPathError("Cubic paths cannot be represented exactly by transform keyframes");
    }
    if (command === "M" || command === "L") {
      const point = { x: number() * viewport.width, y: number() * viewport.height };
      if (command === "M") first = point;
      else if (first === undefined) throw new MotionPathError("Motion path must begin with M");
      points.push(point);
    } else if (command === "Z") {
      if (first === undefined) throw new MotionPathError("Z cannot appear before M");
      points.push(first);
    } else {
      throw new MotionPathError("Motion path contains an unsupported command");
    }
  }
  if (tokens[tokens.length - 1] !== "E") {
    throw new MotionPathError("Motion path must end with E");
  }
  return points;
}

export function motionPathToKeyframes(
  path: string,
  viewport: ViewportSize,
): readonly RuntimeKeyframe[] {
  if (viewport.width <= 0 || viewport.height <= 0) {
    throw new SlideRuntimeError("invalid_view_box", "The slide SVG viewBox must be positive");
  }
  const points = parseMotionPoints(path, viewport);
  let total = 0;
  const distances = points.map((point, index) => {
    const previous = points[index - 1];
    total += previous === undefined ? 0 : Math.hypot(point.x - previous.x, point.y - previous.y);
    return total;
  });
  return points.map((point, index) => {
    const fallbackOffset = points.length === 1 ? 0 : index / (points.length - 1);
    const distance = distances[index] ?? 0;
    return {
      transform: `translate(${Object.is(point.x, -0) ? 0 : point.x}px, ${Object.is(point.y, -0) ? 0 : point.y}px)`,
      offset: total === 0 ? fallbackOffset : distance / total,
    };
  });
}
