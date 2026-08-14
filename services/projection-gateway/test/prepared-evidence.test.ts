import { describe, expect, test } from "bun:test";
import {
  createProjectionGatewayStore,
  PreparedEvidenceProjectionGateway,
  type PublicDeckArtifact,
} from "../src/prepared-evidence.ts";

const deck: PublicDeckArtifact = {
  deckVersion: "deck_alpha",
  manifestHash: "a".repeat(64),
  title: "Prepared deck",
  slides: [
    {
      publicSlideKey: "slide_one",
      ordinal: 1,
      image: {
        url: "https://public.example.test/one.png",
        contentHash: "b".repeat(64),
        width: 1920,
        height: 1080,
      },
      accessibilityLabel: "Slide one",
    },
  ],
};

function approval(gateway: PreparedEvidenceProjectionGateway, nowMs = 1_000) {
  const join = gateway.createDisplayJoin(
    {
      displayId: "display_alpha",
      deckVersion: deck.deckVersion,
      displayFingerprint: "fingerprint-stage-alpha",
    },
    nowMs,
  );
  return {
    join,
    bind: (overrides: Record<string, string> = {}) =>
      gateway.bindDisplay(
        {
          displayJoinId: join.displayJoinId,
          presentationSessionId: "ps_alpha",
          presentationSessionEpoch: "pse_1",
          expectedDisplayBindingEpoch: "dbe_0",
          expectedDeckVersion: deck.deckVersion,
          approvedDisplayId: join.displayId,
          approvedDisplayFingerprint: join.displayFingerprint,
          deck,
          ...overrides,
        },
        nowMs,
      ),
  };
}

describe("prepared evidence projection gateway", () => {
  test("issues a 128-bit non-authorizing locator and binds it once with CAS", () => {
    const gateway = new PreparedEvidenceProjectionGateway();
    const first = approval(gateway);
    expect(first.join.displayJoinId).toMatch(/^join_[0-9a-f]{32}$/);
    expect(first.bind().outcome).toBe("BOUND");
    expect(first.bind()).toEqual({ outcome: "REJECTED", reason: "JOIN_REPLAYED" });

    const concurrent = approval(gateway);
    expect(concurrent.bind()).toEqual({
      outcome: "REJECTED",
      reason: "BINDING_CAS_CONFLICT",
    });
  });

  test("rejects expiry, wrong deck, and unapproved display identity", () => {
    const gateway = new PreparedEvidenceProjectionGateway();
    const expired = approval(gateway, 1_000);
    expect(
      gateway.bindDisplay(
        {
          displayJoinId: expired.join.displayJoinId,
          presentationSessionId: "ps_expired",
          presentationSessionEpoch: "pse_1",
          expectedDisplayBindingEpoch: "dbe_0",
          expectedDeckVersion: deck.deckVersion,
          approvedDisplayId: expired.join.displayId,
          approvedDisplayFingerprint: expired.join.displayFingerprint,
          deck,
        },
        91_000,
      ),
    ).toEqual({ outcome: "REJECTED", reason: "JOIN_EXPIRED" });

    const wrongDeck = approval(gateway);
    expect(wrongDeck.bind({ expectedDeckVersion: "deck_other" })).toEqual({
      outcome: "REJECTED",
      reason: "WRONG_DECK",
    });
    const wrongDisplay = approval(gateway);
    expect(wrongDisplay.bind({ approvedDisplayId: "display_attacker" })).toEqual({
      outcome: "REJECTED",
      reason: "DISPLAY_IDENTITY_MISMATCH",
    });
  });

  test("closes the old binding immediately and rejects its epoch", () => {
    const gateway = new PreparedEvidenceProjectionGateway();
    const first = approval(gateway).bind();
    if (first.outcome !== "BOUND") throw new Error("fixture failed to bind");
    const closeReasons: string[] = [];
    const socket = gateway.connectStage(
      first.session.audienceDisplaySessionId,
      {
        onPlayback: () => undefined,
        onCard: () => undefined,
        onClose: (reason) => closeReasons.push(reason),
      },
      2_000,
    );
    expect(socket).not.toBeNull();

    const secondJoin = gateway.createDisplayJoin(
      {
        displayId: "display_beta",
        deckVersion: deck.deckVersion,
        displayFingerprint: "fingerprint-stage-beta",
      },
      2_000,
    );
    const second = gateway.bindDisplay(
      {
        displayJoinId: secondJoin.displayJoinId,
        presentationSessionId: "ps_alpha",
        presentationSessionEpoch: "pse_1",
        expectedDisplayBindingEpoch: "dbe_1",
        expectedDeckVersion: deck.deckVersion,
        approvedDisplayId: secondJoin.displayId,
        approvedDisplayFingerprint: secondJoin.displayFingerprint,
        deck,
      },
      2_000,
    );
    expect(second.outcome).toBe("BOUND");
    expect(socket?.closed).toBe(true);
    expect(closeReasons).toEqual(["REBOUND"]);
    expect(
      gateway.projectPlayback("ps_alpha", {
        commandId: "cmd_stale",
        displayBindingEpoch: "dbe_1",
        acceptedControlRevision: "cr_1",
        occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
        blackout: false,
      }),
    ).toBe(false);
  });

  test("persists ordered playback and terminal card snapshots across restart", () => {
    const store = createProjectionGatewayStore();
    let gateway = new PreparedEvidenceProjectionGateway(store, { tombstoneRetentionMs: 60_000 });
    const bound = approval(gateway).bind();
    if (bound.outcome !== "BOUND") throw new Error("fixture failed to bind");
    expect(
      gateway.projectPlayback("ps_alpha", {
        commandId: "cmd_one",
        displayBindingEpoch: "dbe_1",
        acceptedControlRevision: "cr_1",
        occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
        blackout: false,
      }),
    ).toBe(true);
    expect(gateway.recordPlaybackApplied("ps_alpha", "dbe_1", "pbr_1")).toBe(true);
    expect(
      gateway.projectCard("ps_alpha", {
        projectionId: "projection_public_random",
        status: "PUBLISHED",
        claim: "Prepared claim",
        supportSummary: "Prepared support",
        sourceLabel: "Public source",
        publishedAtMs: 2_000,
        expiresAtMs: null,
        publicCardRevision: "pcr_1",
        deckVersion: deck.deckVersion,
        manifestHash: deck.manifestHash,
        occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
      }),
    ).toBe(true);
    expect(
      gateway.projectCard("ps_alpha", {
        projectionId: "projection_public_random",
        status: "RETRACTED",
        publicCardRevision: "pcr_2",
        occurredAtMs: 2_100,
      }),
    ).toBe(true);
    expect(
      gateway.projectCard("ps_alpha", {
        projectionId: "projection_public_random",
        status: "PUBLISHED",
        claim: "Resurrection",
        supportSummary: "Forbidden",
        sourceLabel: "Forbidden",
        publishedAtMs: 2_200,
        expiresAtMs: null,
        publicCardRevision: "pcr_3",
        deckVersion: deck.deckVersion,
        manifestHash: deck.manifestHash,
        occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
      }),
    ).toBe(false);

    gateway = new PreparedEvidenceProjectionGateway(store, { tombstoneRetentionMs: 60_000 });
    const snapshot = gateway.snapshot(bound.session.audienceDisplaySessionId, 3_000);
    expect(snapshot?.publicPlaybackRevision).toBe("pbr_1");
    expect(snapshot?.cards).toEqual([]);
    expect(snapshot?.tombstones.map((event) => event.status)).toEqual(["RETRACTED"]);
    expect(snapshot?.tombstoneWatermark).toBe("pcr_1");
    expect(snapshot?.tombstoneRetentionMs).toBe(60_000);
  });
});
