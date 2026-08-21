import { describe, expect, test } from "bun:test";
import { PublishedDeckArtifactSchema } from "@impromptu/contracts/public";
import {
  createProjectionGatewayStore,
  PreparedEvidenceProjectionGateway,
  restoreProjectionGatewayStore,
  snapshotProjectionGatewayStore,
} from "../src/prepared-evidence.ts";

const deck = PublishedDeckArtifactSchema.parse({
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
});

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

  test("exposes no callable card projection surface and always snapshots zero cards", () => {
    const gateway = new PreparedEvidenceProjectionGateway();
    const bound = approval(gateway).bind();
    if (bound.outcome !== "BOUND") throw new Error("fixture failed to bind");
    expect("projectCard" in gateway).toBe(false);
    expect("projectCardResult" in gateway).toBe(false);
    expect(gateway.snapshot(bound.session.audienceDisplaySessionId, 1_001)).toMatchObject({
      publicCardRevision: "pcr_0",
      cards: [],
      tombstones: [],
      tombstoneWatermark: "pcr_0",
    });
  });

  test("persists ordered playback while serializing only empty legacy card fields", () => {
    const store = createProjectionGatewayStore();
    let gateway = new PreparedEvidenceProjectionGateway(store, { tombstoneRetentionMs: 60_000 });
    const bound = approval(gateway).bind();
    if (bound.outcome !== "BOUND") throw new Error("fixture failed to bind");
    expect(
      gateway.projectPlayback("ps_alpha", {
        commandId: "cmd_one",
        displayBindingEpoch: "dbe_1",
        acceptedControlRevision: "cr_1",
        occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 2 },
        blackout: false,
      }),
    ).toBe(true);
    expect(gateway.recordPlaybackApplied("ps_alpha", "dbe_1", "pbr_1")).toBe(true);

    gateway = new PreparedEvidenceProjectionGateway(store, { tombstoneRetentionMs: 60_000 });
    expect(gateway.snapshot(bound.session.audienceDisplaySessionId, 3_000)).toMatchObject({
      publicPlaybackRevision: "pbr_1",
      occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 2 },
      cards: [],
      tombstones: [],
      tombstoneRetentionMs: 60_000,
    });
    const persisted = snapshotProjectionGatewayStore(store) as {
      projections: Array<{ publicCardRevision: string; cards: unknown[]; tombstones: unknown[] }>;
    };
    expect(persisted.projections[0]).toMatchObject({
      publicCardRevision: "pcr_0",
      cards: [],
      tombstones: [],
    });
  });

  test("restores durable slides, discards legacy card payloads, and rejects forged revisions", () => {
    const store = createProjectionGatewayStore();
    const gateway = new PreparedEvidenceProjectionGateway(store);
    const bound = approval(gateway).bind();
    if (bound.outcome !== "BOUND") throw new Error("binding fixture failed");
    const snapshot = snapshotProjectionGatewayStore(store);
    const legacy = structuredClone(snapshot) as {
      projections: Array<{
        publicCardRevision: string;
        cards: unknown[];
        tombstones: unknown[];
      }>;
    };
    const projection = legacy.projections[0];
    if (projection === undefined) throw new Error("snapshot fixture missing projection");
    projection.publicCardRevision = "pcr_2";
    projection.cards = [{ projectionId: "projection_legacy", claim: "LEGACY SENTINEL" }];
    projection.tombstones = [{ projectionId: "projection_terminal", status: "RETRACTED" }];

    const restored = restoreProjectionGatewayStore(legacy);
    expect(restored.outcome).toBe("RESTORED");
    if (restored.outcome !== "RESTORED") throw new Error("snapshot restore failed");
    expect(
      new PreparedEvidenceProjectionGateway(restored.store).snapshot(
        bound.session.audienceDisplaySessionId,
        1_002,
      ),
    ).toMatchObject({ publicCardRevision: "pcr_0", cards: [], tombstones: [] });

    projection.publicCardRevision = "pcr_9007199254740992";
    expect(restoreProjectionGatewayStore(legacy)).toEqual({ outcome: "INVALID_SNAPSHOT" });
  });
});
