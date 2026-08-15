export const slideRuntimeErrorCodes = {
  deckNotAnimatable: "deck_not_animatable",
  invalidGroupTrigger: "invalid_group_trigger",
  invalidMotionPath: "invalid_motion_path",
  invalidViewBox: "invalid_view_box",
  playerBusy: "player_busy",
  targetNotFound: "target_not_found",
} as const;

export type SlideRuntimeErrorCode =
  (typeof slideRuntimeErrorCodes)[keyof typeof slideRuntimeErrorCodes];

export class SlideRuntimeError extends Error {
  override readonly name = "SlideRuntimeError";
  constructor(
    readonly code: SlideRuntimeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class MissingTargetError extends SlideRuntimeError {
  constructor(readonly elementId: string) {
    super("target_not_found", `Animation target '${elementId}' was not found in the slide SVG`);
  }
}

export class MotionPathError extends SlideRuntimeError {
  constructor(message: string) {
    super("invalid_motion_path", message);
  }
}

export class DeckNotAnimatableError extends SlideRuntimeError {
  constructor() {
    super("deck_not_animatable", "The slide timeline contains unsupported effects");
  }
}
