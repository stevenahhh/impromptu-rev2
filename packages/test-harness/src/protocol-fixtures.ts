import type { PlaybackCommand } from "@impromptu/contracts/control";
import { createPlaybackAuthorityState, type PlaybackAuthorityState } from "@impromptu/state";

export type PlaybackIntent =
  | Readonly<{ type: "SLIDE_SET"; publicSlideKey: string }>
  | Readonly<{ type: "SLIDE_NEXT" | "SLIDE_PREVIOUS" }>
  | Readonly<{ type: "BLACKOUT_SET"; enabled: boolean }>;

export function deterministicHash(sequence: number): string {
  return sequence.toString(16).padStart(64, "0");
}

export function playbackCommandFixture(sequence: number, intent: PlaybackIntent): PlaybackCommand {
  const header = {
    presentationSessionId: "session-fixture",
    presentationSessionEpoch: 1,
    actorId: "controller-fixture",
    controllerEpoch: 1,
    commandId: `command-${sequence}`,
    baseRevision: sequence - 1,
    requestHash: deterministicHash(sequence),
    delivery: "LIVE" as const,
  };
  switch (intent.type) {
    case "SLIDE_SET":
      return { ...header, ...intent };
    case "SLIDE_NEXT":
    case "SLIDE_PREVIOUS":
      return { ...header, ...intent };
    case "BLACKOUT_SET":
      return { ...header, ...intent };
  }
}

export function playbackAuthorityFixture(): PlaybackAuthorityState {
  return createPlaybackAuthorityState({
    presentationSessionId: "session-fixture",
    presentationSessionEpoch: 1,
    actorId: "controller-fixture",
    controllerEpoch: 1,
    displayBindingEpoch: 1,
    stageStatus: "READY",
    slideOrder: ["slide-1", "slide-2", "slide-3"],
    initialSlideKey: "slide-1",
  });
}

export const PROTOCOL_TRANSITION_MATRIX = [
  { scenario: "LEGAL_PLAYBACK_TRANSITION", expected: "ACCEPTED" },
  { scenario: "ILLEGAL_PUBLICATION_TRANSITION", expected: "ILLEGAL_TRANSITION" },
  { scenario: "CONCURRENT_APPROVE_RETRACT", expected: "CAS_SINGLE_WINNER" },
  { scenario: "PARTITIONED_RELATIVE_COMMAND", expected: "OFFLINE_RELATIVE_COMMAND" },
  { scenario: "STALE_ROLE_SNAPSHOT", expected: "STALE_SNAPSHOT" },
  { scenario: "INCOMPATIBLE_BUILD", expected: "PROTOCOL_RANGE_MISMATCH" },
] as const;
