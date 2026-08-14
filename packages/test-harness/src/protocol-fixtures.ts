import {
  ActorIdSchema,
  controllerEpoch,
  type PlaybackCommand,
  PlaybackCommandSchema,
  PlaybackControlLeaseIdSchema,
  PlaybackControlLeaseSchema,
} from "@impromptu/contracts/control";
import {
  displayBindingEpoch,
  PresentationSessionIdSchema,
  PublicSlideKeySchema,
  presentationSessionEpoch,
} from "@impromptu/contracts/public";
import { createPlaybackAuthorityState, type PlaybackAuthorityState } from "@impromptu/state";

export type PlaybackIntent =
  | Readonly<{ type: "SLIDE_SET"; publicSlideKey: string }>
  | Readonly<{ type: "SLIDE_NEXT" | "SLIDE_PREVIOUS" }>
  | Readonly<{ type: "BLACKOUT_SET"; enabled: boolean }>;

export function deterministicHash(sequence: number): string {
  return sequence.toString(16).padStart(64, "0");
}

export function playbackCommandFixture(sequence: number, intent: PlaybackIntent): PlaybackCommand {
  return PlaybackCommandSchema.parse({
    ...intent,
    presentationSessionId: "ps_fixture",
    presentationSessionEpoch: "pse_1",
    actorId: "actor_fixture",
    leaseId: "lease_fixture",
    controllerEpoch: "ce_1",
    commandId: `cmd_${sequence}`,
    baseRevision: `cr_${sequence - 1}`,
    delivery: "LIVE",
    displayBindingEpoch: "dbe_1",
  });
}

export function playbackAuthorityFixture(): PlaybackAuthorityState {
  const presentationSessionId = PresentationSessionIdSchema.parse("ps_fixture");
  const sessionEpoch = presentationSessionEpoch(1);
  return createPlaybackAuthorityState({
    presentationSessionId,
    presentationSessionEpoch: sessionEpoch,
    activeLease: PlaybackControlLeaseSchema.parse({
      leaseId: PlaybackControlLeaseIdSchema.parse("lease_fixture"),
      presentationSessionId,
      presentationSessionEpoch: sessionEpoch,
      actorId: ActorIdSchema.parse("actor_fixture"),
      controllerEpoch: controllerEpoch(1),
      expiresAtMs: 1_800_000_000_000,
    }),
    displayBindingEpoch: displayBindingEpoch(1),
    stageStatus: "READY",
    slideOrder: ["slide_1", "slide_2", "slide_3"].map((key) => PublicSlideKeySchema.parse(key)),
    initialSlideKey: PublicSlideKeySchema.parse("slide_1"),
  });
}
