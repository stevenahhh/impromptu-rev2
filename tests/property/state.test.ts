import { describe, expect, test } from "bun:test";
import type { AudienceSnapshot, PlaybackCommand } from "@impromptu/contracts";
import {
  applyAudiencePlaybackSnapshot,
  applyPublicPlaybackEvent,
  applyPublicPlaybackSnapshot,
  createPlaybackAuthorityState,
  createPublicationState,
  initialPublicPlaybackState,
  markStageApplied,
  PUBLICATION_TRANSITIONS,
  type PublicPlaybackEvent,
  reducePlaybackCommand,
  reducePublication,
  restorePlaybackAuthority,
  snapshotPlaybackAuthority,
} from "@impromptu/state";

const hash = (digit: string): string => digit.repeat(64);

function command(
  overrides: Partial<PlaybackCommand> & Pick<PlaybackCommand, "type">,
): PlaybackCommand {
  const base = {
    presentationSessionId: "session-1",
    presentationSessionEpoch: 3,
    actorId: "controller-1",
    controllerEpoch: 7,
    commandId: "command-1",
    baseRevision: 0,
    requestHash: hash("a"),
    delivery: "LIVE" as const,
  };
  switch (overrides.type) {
    case "SLIDE_SET":
      return { ...base, publicSlideKey: "slide-2", ...overrides } as PlaybackCommand;
    case "BLACKOUT_SET":
      return { ...base, enabled: true, ...overrides } as PlaybackCommand;
    case "SLIDE_NEXT":
    case "SLIDE_PREVIOUS":
      return { ...base, ...overrides } as PlaybackCommand;
  }
}

function authority(stageStatus: "READY" | "DISCONNECTED" | "UNBOUND" = "READY") {
  return createPlaybackAuthorityState({
    presentationSessionId: "session-1",
    presentationSessionEpoch: 3,
    actorId: "controller-1",
    controllerEpoch: 7,
    displayBindingEpoch: 2,
    stageStatus,
    slideOrder: ["slide-1", "slide-2", "slide-3"],
    initialSlideKey: "slide-1",
  });
}

describe("playback authority reducer", () => {
  test("deduplicates equal requests and rejects command-id payload conflicts", () => {
    const first = reducePlaybackCommand(authority(), command({ type: "SLIDE_NEXT" }));
    expect(first.receipt).toMatchObject({ status: "ACCEPTED", acceptedControlRevision: 1 });
    expect(first.state.occurrence).toEqual({ publicSlideKey: "slide-2", occurrenceSeq: 2 });

    const duplicate = reducePlaybackCommand(first.state, command({ type: "SLIDE_NEXT" }));
    expect(duplicate.receipt).toEqual(first.receipt);
    expect(duplicate.state).toEqual(first.state);

    const conflict = reducePlaybackCommand(
      first.state,
      command({ type: "SLIDE_NEXT", requestHash: hash("b") }),
    );
    expect(conflict.receipt).toMatchObject({
      status: "REJECTED",
      reason: "IDEMPOTENCY_CONFLICT",
    });
    expect(conflict.state).toEqual(first.state);
  });

  test("validates the current lease before consulting old dedupe records", () => {
    const first = reducePlaybackCommand(authority(), command({ type: "SLIDE_NEXT" }));
    const afterTakeover = { ...first.state, actorId: "controller-2", controllerEpoch: 8 };
    const staleDuplicate = reducePlaybackCommand(afterTakeover, command({ type: "SLIDE_NEXT" }));

    expect(staleDuplicate.receipt).toMatchObject({
      status: "REJECTED",
      reason: "STALE_CONTROLLER_EPOCH",
    });
  });

  test("never accepts relative commands from an offline queue or without a ready binding", () => {
    const offline = reducePlaybackCommand(
      authority(),
      command({ type: "SLIDE_NEXT", delivery: "OFFLINE_REPLAY" }),
    );
    expect(offline.receipt).toMatchObject({
      status: "REJECTED",
      reason: "OFFLINE_RELATIVE_COMMAND",
    });

    const disconnected = reducePlaybackCommand(
      authority("DISCONNECTED"),
      command({ type: "SLIDE_NEXT" }),
    );
    expect(disconnected.receipt).toMatchObject({ status: "REJECTED", reason: "STAGE_NOT_READY" });

    const absolute = reducePlaybackCommand(
      authority("DISCONNECTED"),
      command({ type: "SLIDE_SET" }),
    );
    expect(absolute.receipt.status).toBe("ACCEPTED");
  });

  test("separates authority acceptance from ordered Stage application", () => {
    const acceptedOne = reducePlaybackCommand(authority(), command({ type: "SLIDE_NEXT" }));
    const acceptedTwo = reducePlaybackCommand(
      acceptedOne.state,
      command({
        type: "BLACKOUT_SET",
        commandId: "command-2",
        baseRevision: 1,
        requestHash: hash("b"),
      }),
    );

    expect(acceptedTwo.receipt.status).toBe("ACCEPTED");
    const outOfOrder = markStageApplied(acceptedTwo.state, "command-2", 2);
    expect(outOfOrder.outcome).toBe("OUT_OF_ORDER");
    expect(outOfOrder.state.publicPlaybackRevision).toBe(0);

    const appliedOne = markStageApplied(acceptedTwo.state, "command-1", 2);
    expect(appliedOne.outcome).toBe("APPLIED");
    expect(appliedOne.receipt).toMatchObject({
      status: "STAGE_APPLIED",
      publicPlaybackRevision: 1,
    });
    const appliedTwo = markStageApplied(appliedOne.state, "command-2", 2);
    expect(appliedTwo.outcome).toBe("APPLIED");
    expect(appliedTwo.state.publicPlaybackRevision).toBe(2);

    const duplicate = markStageApplied(appliedTwo.state, "command-1", 2);
    expect(duplicate.outcome).toBe("DUPLICATE");
    expect(duplicate.receipt).toEqual(appliedOne.receipt);
  });

  test("restores all authoritative and idempotency state after restart", () => {
    const accepted = reducePlaybackCommand(authority(), command({ type: "SLIDE_NEXT" }));
    const restored = restorePlaybackAuthority(snapshotPlaybackAuthority(accepted.state));
    expect(restored).toEqual(accepted.state);

    const duplicate = reducePlaybackCommand(restored, command({ type: "SLIDE_NEXT" }));
    expect(duplicate.state.controlRevision).toBe(1);
    expect(duplicate.receipt).toEqual(accepted.receipt);
  });
});

describe("public playback projection", () => {
  const event = (revision: number, slide = "slide-1"): PublicPlaybackEvent => ({
    presentationSessionId: "session-1",
    presentationSessionEpoch: 3,
    displayBindingEpoch: 2,
    deckVersion: "deck-v1",
    manifestHash: hash("a"),
    publicPlaybackRevision: revision,
    occurrence: { publicSlideKey: slide, occurrenceSeq: revision + 1 },
    blackout: false,
  });

  test("detects gaps, ignores duplicates, and accepts only the next revision", () => {
    const initial = initialPublicPlaybackState({
      presentationSessionId: "session-1",
      presentationSessionEpoch: 3,
      displayBindingEpoch: 2,
      deckVersion: "deck-v1",
      manifestHash: hash("a"),
      occurrence: { publicSlideKey: "slide-1", occurrenceSeq: 1 },
      blackout: false,
    });
    const gap = applyPublicPlaybackEvent(initial, event(2, "slide-3"));
    expect(gap.outcome).toBe("GAP_REQUIRES_SNAPSHOT");
    expect(gap.state).toEqual(initial);

    const next = applyPublicPlaybackEvent(initial, event(1, "slide-2"));
    expect(next.outcome).toBe("APPLIED");
    expect(applyPublicPlaybackEvent(next.state, event(1, "slide-2")).outcome).toBe("DUPLICATE");
    expect(applyPublicPlaybackEvent(next.state, event(1, "slide-3")).outcome).toBe(
      "STALE_OR_CONFLICTING",
    );
  });

  test("rejects stale snapshots and recovers a gap from a current role snapshot", () => {
    const initial = initialPublicPlaybackState({
      presentationSessionId: "session-1",
      presentationSessionEpoch: 3,
      displayBindingEpoch: 2,
      deckVersion: "deck-v1",
      manifestHash: hash("a"),
      occurrence: { publicSlideKey: "slide-1", occurrenceSeq: 1 },
      blackout: false,
    });
    const current = applyPublicPlaybackEvent(initial, event(1, "slide-2")).state;
    const stale = applyPublicPlaybackSnapshot(current, {
      presentationSessionId: "session-1",
      presentationSessionEpoch: 3,
      displayBindingEpoch: 2,
      deckVersion: "deck-v1",
      manifestHash: hash("a"),
      publicPlaybackRevision: 0,
      occurrence: { publicSlideKey: "slide-1", occurrenceSeq: 1 },
      blackout: false,
    });
    expect(stale.outcome).toBe("STALE_SNAPSHOT");

    const recovered = applyPublicPlaybackSnapshot(current, {
      ...event(5, "slide-3"),
    });
    expect(recovered.outcome).toBe("APPLIED");
    expect(recovered.state.publicPlaybackRevision).toBe(5);
    expect(recovered.state.occurrence.publicSlideKey).toBe("slide-3");
  });

  test("restores public playback only from the PUBLIC_STAGE snapshot shape", () => {
    const initial = initialPublicPlaybackState({
      presentationSessionId: "session-1",
      presentationSessionEpoch: 3,
      displayBindingEpoch: 2,
      deckVersion: "deck-v1",
      manifestHash: hash("a"),
      occurrence: { publicSlideKey: "slide-1", occurrenceSeq: 1 },
      blackout: false,
    });
    const snapshot: AudienceSnapshot = {
      role: "PUBLIC_STAGE",
      presentationSessionId: "session-1",
      presentationSessionEpoch: 3,
      displayBindingEpoch: 2,
      publicPlaybackRevision: 7,
      publicCardRevision: 4,
      deck: {
        deckVersion: "deck-v1",
        manifestHash: hash("a"),
        title: "Published deck",
        slides: [
          {
            publicSlideKey: "slide-2",
            ordinal: 1,
            image: {
              url: "https://published.example/slide-2.png",
              contentHash: hash("b"),
              width: 1920,
              height: 1080,
            },
            accessibilityLabel: "Published slide",
          },
        ],
      },
      occurrence: { publicSlideKey: "slide-2", occurrenceSeq: 8 },
      blackout: true,
      cards: [],
      tombstones: [],
      tombstoneWatermark: 4,
    };

    const restored = applyAudiencePlaybackSnapshot(initial, snapshot);
    expect(restored.outcome).toBe("APPLIED");
    expect(restored.state).toMatchObject({
      publicPlaybackRevision: 7,
      occurrence: { publicSlideKey: "slide-2", occurrenceSeq: 8 },
      blackout: true,
    });
  });
});

describe("publication transition reducer", () => {
  test("exports the formal legal transition table", () => {
    expect(PUBLICATION_TRANSITIONS).toEqual({
      PRIVATE: ["QUALIFY"],
      ELIGIBLE: ["APPROVE"],
      PUBLISHED: ["RETRACT", "EXPIRE"],
      RETRACTED: [],
      EXPIRED: [],
    });
  });

  test("accepts legal transitions and rejects illegal or stale CAS operations", () => {
    const initial = createPublicationState("candidate-1", "candidate-v1");
    const qualified = reducePublication(initial, {
      type: "QUALIFY",
      commandId: "qualify-1",
      requestHash: hash("a"),
      expectedRevision: 0,
    });
    expect(qualified.result).toMatchObject({ outcome: "ACCEPTED", revision: 1 });

    const illegal = reducePublication(qualified.state, {
      type: "RETRACT",
      commandId: "retract-1",
      requestHash: hash("b"),
      expectedRevision: 1,
      projectionId: "projection-1",
    });
    expect(illegal.result).toMatchObject({ outcome: "REJECTED", reason: "ILLEGAL_TRANSITION" });

    const published = reducePublication(qualified.state, {
      type: "APPROVE",
      commandId: "approve-1",
      requestHash: hash("c"),
      expectedRevision: 1,
      candidateVersion: "candidate-v1",
      projectionId: "projection-1",
    });
    expect(published.state.status).toBe("PUBLISHED");

    const stale = reducePublication(published.state, {
      type: "RETRACT",
      commandId: "retract-2",
      requestHash: hash("d"),
      expectedRevision: 1,
      projectionId: "projection-1",
    });
    expect(stale.result).toMatchObject({ outcome: "REJECTED", reason: "CAS_CONFLICT" });
  });

  test("deduplicates accepted publication mutations and detects payload conflict", () => {
    const initial = createPublicationState("candidate-1", "candidate-v1");
    const operation = {
      type: "QUALIFY" as const,
      commandId: "qualify-1",
      requestHash: hash("a"),
      expectedRevision: 0,
    };
    const first = reducePublication(initial, operation);
    const duplicate = reducePublication(first.state, operation);
    expect(duplicate.result).toEqual(first.result);
    expect(duplicate.state).toEqual(first.state);

    const conflict = reducePublication(first.state, { ...operation, requestHash: hash("b") });
    expect(conflict.result).toMatchObject({
      outcome: "REJECTED",
      reason: "IDEMPOTENCY_CONFLICT",
    });
  });
});
