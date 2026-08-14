import { describe, expect, test } from "bun:test";
import {
  applyRealtimeTransition,
  createRealtimeStageState,
  type RealtimeSnapshot,
} from "./realtime-reconcile.ts";

const identity = {
  presentationSessionId: "ps_alpha",
  presentationSessionEpoch: "pse_1",
  displayBindingEpoch: "dbe_1",
  deckVersion: "deck_alpha",
  manifestHash: "a".repeat(64),
};

const snapshot = (overrides: Partial<RealtimeSnapshot> = {}): RealtimeSnapshot => ({
  ...identity,
  role: "PUBLIC_STAGE",
  stateHash: "b".repeat(64),
  publicPlaybackRevision: "pbr_1",
  publicCardRevision: "pcr_0",
  occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
  blackout: false,
  cards: [],
  ...overrides,
});

describe("deterministic realtime reconcile state", () => {
  test("requires a hash-pinned absolute snapshot and never blindly overwrites newer state", () => {
    let state = createRealtimeStageState(identity, {
      publicSlideKey: "slide_one",
      occurrenceSeq: 1,
    });
    state = applyRealtimeTransition(state, {
      type: "ABSOLUTE_PLAYBACK",
      commandId: "cmd_before_partition",
      presentationSessionEpoch: "pse_1",
      displayBindingEpoch: "dbe_1",
      publicPlaybackRevision: "pbr_1",
      occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 2 },
      blackout: false,
    }).state;
    state = applyRealtimeTransition(state, { type: "PARTITION", reason: "NETWORK_ERROR" }).state;
    expect(state.connection).toBe("PARTITIONED");
    state = applyRealtimeTransition(state, { type: "RECONNECT" }).state;
    expect(state.connection).toBe("RECONCILING");

    const stale = applyRealtimeTransition(state, {
      type: "SNAPSHOT",
      snapshot: snapshot({ publicPlaybackRevision: "pbr_0" }),
      verifiedStateHash: "b".repeat(64),
    });
    expect(stale.state.connection).toBe("RECONCILE_REQUIRED");
    expect(stale.effects).toEqual([{ type: "HIDE_DYNAMIC_CARDS", reason: "STALE_SNAPSHOT" }]);

    const mismatch = applyRealtimeTransition(state, {
      type: "SNAPSHOT",
      snapshot: snapshot({ manifestHash: "c".repeat(64) }),
      verifiedStateHash: "b".repeat(64),
    });
    expect(mismatch.state.connection).toBe("RECONCILE_REQUIRED");

    const applied = applyRealtimeTransition(state, {
      type: "SNAPSHOT",
      snapshot: snapshot({ publicPlaybackRevision: "pbr_2" }),
      verifiedStateHash: "b".repeat(64),
    });
    expect(applied.state.connection).toBe("CONNECTED");
    expect(applied.state.occurrence.publicSlideKey).toBe("slide_one");
  });

  test("hides live cards within their server lease and ignores playback-only controller epochs", () => {
    let state = createRealtimeStageState(identity, {
      publicSlideKey: "slide_one",
      occurrenceSeq: 1,
    });
    state = applyRealtimeTransition(state, {
      type: "CARD_UPSERT",
      nowMs: 1_000,
      card: {
        projectionId: "projection_live",
        mode: "LIVE",
        leaseExpiresAtMs: 4_000,
        publicCardRevision: "pcr_1",
      },
    }).state;
    expect(state.visibleCardIds).toEqual(["projection_live"]);

    state = applyRealtimeTransition(state, {
      type: "CONTROLLER_EPOCH_CHANGED",
      controllerEpoch: "ce_2",
    }).state;
    expect(state.visibleCardIds).toEqual(["projection_live"]);

    const expired = applyRealtimeTransition(state, { type: "CLOCK", nowMs: 4_000 });
    expect(expired.state.visibleCardIds).toEqual([]);
    expect(expired.effects).toEqual([{ type: "HIDE_CARD", projectionId: "projection_live", reason: "LEASE_EXPIRED" }]);
  });

  test("allows curated offline persistence only for a verified signed package with local expiry", () => {
    let state = createRealtimeStageState(identity, {
      publicSlideKey: "slide_one",
      occurrenceSeq: 1,
    });
    for (const [projectionId, signatureVerified] of [
      ["projection_allowed", true],
      ["projection_unsigned", false],
    ] as const) {
      state = applyRealtimeTransition(state, {
        type: "CARD_UPSERT",
        nowMs: 1_000,
        card: {
          projectionId,
          mode: "CURATED",
          leaseExpiresAtMs: null,
          publicCardRevision: projectionId === "projection_allowed" ? "pcr_1" : "pcr_2",
          offlinePackage: {
            offlineDisplayAllowed: true,
            localExpiresAtMs: 10_000,
            signatureVerified,
          },
        },
      }).state;
    }
    const partitioned = applyRealtimeTransition(state, {
      type: "PARTITION",
      reason: "NETWORK_ERROR",
      nowMs: 2_000,
    });
    expect(partitioned.state.visibleCardIds).toEqual(["projection_allowed"]);
    expect(partitioned.effects).toContainEqual({
      type: "HIDE_CARD",
      projectionId: "projection_unsigned",
      reason: "PARTITION",
    });
  });

  test("rejects duplicate effects, stale epochs, and all relative replay", () => {
    let state = createRealtimeStageState(identity, {
      publicSlideKey: "slide_one",
      occurrenceSeq: 1,
    });
    const command = {
      type: "ABSOLUTE_PLAYBACK" as const,
      commandId: "cmd_one",
      presentationSessionEpoch: "pse_1",
      displayBindingEpoch: "dbe_1",
      publicPlaybackRevision: "pbr_1",
      occurrence: { publicSlideKey: "slide_two", occurrenceSeq: 2 },
      blackout: false,
    };
    const first = applyRealtimeTransition(state, command);
    state = first.state;
    expect(first.outcome).toBe("APPLIED");
    expect(applyRealtimeTransition(state, command).outcome).toBe("DUPLICATE");
    expect(
      applyRealtimeTransition(state, { ...command, commandId: "cmd_stale", displayBindingEpoch: "dbe_0", publicPlaybackRevision: "pbr_2" }).outcome,
    ).toBe("STALE_EPOCH");
    expect(
      applyRealtimeTransition(state, { type: "RELATIVE_REPLAY", commandId: "cmd_relative", offset: 1 }).outcome,
    ).toBe("REJECTED_RELATIVE_REPLAY");
  });
});
