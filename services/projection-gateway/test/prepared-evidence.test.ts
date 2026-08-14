import { describe, expect, test } from "bun:test";
import {
  createProjectionGatewayStore,
  PreparedEvidenceProjectionGateway,
  type PublicDeckArtifact,
  restoreProjectionGatewayStore,
  snapshotProjectionGatewayStore,
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

  test("never re-exposes a live card after occurrence change or display rebind", () => {
    const gateway = new PreparedEvidenceProjectionGateway();
    const bound = approval(gateway).bind();
    if (bound.outcome !== "BOUND") throw new Error("fixture failed to bind");
    expect(
      gateway.projectCard("ps_alpha", {
        projectionId: "projection_live_binding",
        status: "PUBLISHED",
        mode: "LIVE",
        leaseExpiresAtMs: 4_000,
        publicationPolicyVersion: "publication-policy-1",
        cardVersion: "card-version-1",
        liveBinding: {
          presentationSessionEpoch: "pse_1",
          displayBindingEpoch: "dbe_1",
          publicSlideOccurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
          publicationPolicyVersion: "publication-policy-1",
          cardVersion: "card-version-1",
        },
        claim: "Bound live claim",
        supportSummary: "Bound support",
        sourceLabel: "Public source",
        publishedAtMs: 1_000,
        expiresAtMs: 4_000,
        publicCardRevision: "pcr_1",
        deckVersion: deck.deckVersion,
        manifestHash: deck.manifestHash,
        occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
      }),
    ).toBe(true);
    expect(gateway.snapshot(bound.session.audienceDisplaySessionId, 1_001)?.cards).toHaveLength(1);
    expect(
      gateway.projectPlayback("ps_alpha", {
        commandId: "cmd_revisit",
        displayBindingEpoch: "dbe_1",
        acceptedControlRevision: "cr_1",
        occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 2 },
        blackout: false,
      }),
    ).toBe(true);
    expect(gateway.snapshot(bound.session.audienceDisplaySessionId, 1_002)?.cards).toEqual([]);

    const reboundJoin = gateway.createDisplayJoin(
      {
        displayId: "display_rebound",
        deckVersion: deck.deckVersion,
        displayFingerprint: "fingerprint-stage-rebound",
      },
      1_003,
    );
    const rebound = gateway.bindDisplay(
      {
        displayJoinId: reboundJoin.displayJoinId,
        presentationSessionId: "ps_alpha",
        presentationSessionEpoch: "pse_1",
        expectedDisplayBindingEpoch: "dbe_1",
        expectedDeckVersion: deck.deckVersion,
        approvedDisplayId: reboundJoin.displayId,
        approvedDisplayFingerprint: reboundJoin.displayFingerprint,
        deck,
      },
      1_003,
    );
    if (rebound.outcome !== "BOUND") throw new Error("fixture failed to rebind");
    expect(gateway.snapshot(rebound.session.audienceDisplaySessionId, 1_004)?.cards).toEqual([]);
  });

  test("invalidates live bindings on display, session, policy, and card-version changes", () => {
    const publishLive = (gateway: PreparedEvidenceProjectionGateway, sessionEpoch = "pse_1") =>
      gateway.projectCard("ps_alpha", {
        projectionId: "projection_live_invalidation",
        status: "PUBLISHED",
        mode: "LIVE",
        leaseExpiresAtMs: 4_000,
        publicationPolicyVersion: "publication-policy-1",
        cardVersion: "card-version-1",
        liveBinding: {
          presentationSessionEpoch: sessionEpoch,
          displayBindingEpoch: "dbe_1",
          publicSlideOccurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
          publicationPolicyVersion: "publication-policy-1",
          cardVersion: "card-version-1",
        },
        claim: "Bound live claim",
        supportSummary: "Bound support",
        sourceLabel: "Public source",
        publishedAtMs: 1_000,
        expiresAtMs: 4_000,
        publicCardRevision: "pcr_1",
        deckVersion: deck.deckVersion,
        manifestHash: deck.manifestHash,
        occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
      });

    const rebindGateway = new PreparedEvidenceProjectionGateway();
    const first = approval(rebindGateway).bind();
    if (first.outcome !== "BOUND") throw new Error("fixture failed to bind");
    expect(publishLive(rebindGateway)).toBe(true);
    const nextJoin = rebindGateway.createDisplayJoin(
      {
        displayId: "display_live_rebind",
        deckVersion: deck.deckVersion,
        displayFingerprint: "fingerprint-live-rebind",
      },
      1_100,
    );
    const rebound = rebindGateway.bindDisplay(
      {
        displayJoinId: nextJoin.displayJoinId,
        presentationSessionId: "ps_alpha",
        presentationSessionEpoch: "pse_1",
        expectedDisplayBindingEpoch: "dbe_1",
        expectedDeckVersion: deck.deckVersion,
        approvedDisplayId: nextJoin.displayId,
        approvedDisplayFingerprint: nextJoin.displayFingerprint,
        deck,
      },
      1_100,
    );
    if (rebound.outcome !== "BOUND") throw new Error("fixture failed to rebind");
    expect(rebindGateway.snapshot(rebound.session.audienceDisplaySessionId, 1_101)?.cards).toEqual(
      [],
    );
    expect(
      rebindGateway.projectCardResult("ps_alpha", {
        projectionId: "projection_delayed_rebind",
        status: "PUBLISHED",
        mode: "LIVE",
        leaseExpiresAtMs: 4_100,
        publicationPolicyVersion: "publication-policy-1",
        cardVersion: "card-version-delayed-rebind",
        liveBinding: {
          presentationSessionEpoch: "pse_1",
          displayBindingEpoch: "dbe_1",
          publicSlideOccurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
          publicationPolicyVersion: "publication-policy-1",
          cardVersion: "card-version-delayed-rebind",
        },
        claim: "Delayed pre-rebind claim",
        supportSummary: "Must remain hidden",
        sourceLabel: "Public source",
        publishedAtMs: 1_100,
        expiresAtMs: 4_100,
        publicCardRevision: "pcr_2",
        deckVersion: deck.deckVersion,
        manifestHash: deck.manifestHash,
        occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
      }),
    ).toEqual({ outcome: "REJECTED", reason: "STALE_LIVE_BINDING" });
    expect(rebindGateway.snapshot(rebound.session.audienceDisplaySessionId, 1_101)?.cards).toEqual(
      [],
    );

    const sessionGateway = new PreparedEvidenceProjectionGateway();
    const sessionFirst = approval(sessionGateway).bind();
    if (sessionFirst.outcome !== "BOUND") throw new Error("fixture failed to bind");
    expect(publishLive(sessionGateway)).toBe(true);
    const sessionJoin = sessionGateway.createDisplayJoin(
      {
        displayId: "display_new_session",
        deckVersion: deck.deckVersion,
        displayFingerprint: "fingerprint-new-session",
      },
      1_100,
    );
    const newSession = sessionGateway.bindDisplay(
      {
        displayJoinId: sessionJoin.displayJoinId,
        presentationSessionId: "ps_alpha",
        presentationSessionEpoch: "pse_2",
        expectedDisplayBindingEpoch: "dbe_1",
        expectedDeckVersion: deck.deckVersion,
        approvedDisplayId: sessionJoin.displayId,
        approvedDisplayFingerprint: sessionJoin.displayFingerprint,
        deck,
      },
      1_100,
    );
    if (newSession.outcome !== "BOUND") throw new Error("fixture failed to rebind session");
    expect(
      sessionGateway.snapshot(newSession.session.audienceDisplaySessionId, 1_101)?.cards,
    ).toEqual([]);

    const occurrenceGateway = new PreparedEvidenceProjectionGateway();
    const occurrenceBound = approval(occurrenceGateway).bind();
    if (occurrenceBound.outcome !== "BOUND") throw new Error("fixture failed to bind");
    expect(publishLive(occurrenceGateway)).toBe(true);
    expect(
      occurrenceGateway.projectPlayback("ps_alpha", {
        commandId: "cmd_occurrence_change",
        displayBindingEpoch: "dbe_1",
        acceptedControlRevision: "cr_1",
        occurrence: { publicSlideKey: "slide_two", occurrenceSeq: 2 },
        blackout: false,
      }),
    ).toBe(true);
    expect(
      occurrenceGateway.projectCardResult("ps_alpha", {
        projectionId: "projection_delayed_occurrence",
        status: "PUBLISHED",
        mode: "LIVE",
        leaseExpiresAtMs: 4_100,
        publicationPolicyVersion: "publication-policy-1",
        cardVersion: "card-version-delayed-occurrence",
        liveBinding: {
          presentationSessionEpoch: "pse_1",
          displayBindingEpoch: "dbe_1",
          publicSlideOccurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
          publicationPolicyVersion: "publication-policy-1",
          cardVersion: "card-version-delayed-occurrence",
        },
        claim: "Delayed old-occurrence claim",
        supportSummary: "Must remain hidden",
        sourceLabel: "Public source",
        publishedAtMs: 1_100,
        expiresAtMs: 4_100,
        publicCardRevision: "pcr_2",
        deckVersion: deck.deckVersion,
        manifestHash: deck.manifestHash,
        occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
      }),
    ).toEqual({ outcome: "REJECTED", reason: "STALE_LIVE_BINDING" });
    expect(
      occurrenceGateway.snapshot(occurrenceBound.session.audienceDisplaySessionId, 1_101)?.cards,
    ).toEqual([]);

    const policyGateway = new PreparedEvidenceProjectionGateway();
    const policyBound = approval(policyGateway).bind();
    if (policyBound.outcome !== "BOUND") throw new Error("fixture failed to bind");
    expect(publishLive(policyGateway)).toBe(true);
    expect(policyGateway.setPublicationPolicyVersion("ps_alpha", "publication-policy-2")).toBe(
      true,
    );
    expect(
      policyGateway.snapshot(policyBound.session.audienceDisplaySessionId, 1_101)?.cards,
    ).toEqual([]);
    expect(
      policyGateway.projectCardResult("ps_alpha", {
        projectionId: "projection_delayed_policy",
        status: "PUBLISHED",
        mode: "LIVE",
        leaseExpiresAtMs: 4_100,
        publicationPolicyVersion: "publication-policy-1",
        cardVersion: "card-version-delayed-policy",
        liveBinding: {
          presentationSessionEpoch: "pse_1",
          displayBindingEpoch: "dbe_1",
          publicSlideOccurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
          publicationPolicyVersion: "publication-policy-1",
          cardVersion: "card-version-delayed-policy",
        },
        claim: "Delayed old-policy claim",
        supportSummary: "Must remain hidden",
        sourceLabel: "Public source",
        publishedAtMs: 1_100,
        expiresAtMs: 4_100,
        publicCardRevision: "pcr_2",
        deckVersion: deck.deckVersion,
        manifestHash: deck.manifestHash,
        occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
      }),
    ).toEqual({ outcome: "REJECTED", reason: "STALE_LIVE_BINDING" });
    expect(
      policyGateway.snapshot(policyBound.session.audienceDisplaySessionId, 1_101),
    ).toMatchObject({ publicationPolicyVersion: "publication-policy-2", cards: [] });

    const cardVersionGateway = new PreparedEvidenceProjectionGateway();
    expect(approval(cardVersionGateway).bind().outcome).toBe("BOUND");
    expect(
      cardVersionGateway.projectCard("ps_alpha", {
        projectionId: "projection_wrong_card_version",
        status: "PUBLISHED",
        mode: "LIVE",
        leaseExpiresAtMs: 4_000,
        publicationPolicyVersion: "publication-policy-1",
        cardVersion: "card-version-2",
        liveBinding: {
          presentationSessionEpoch: "pse_1",
          displayBindingEpoch: "dbe_1",
          publicSlideOccurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
          publicationPolicyVersion: "publication-policy-1",
          cardVersion: "card-version-1",
        },
        claim: "Wrong card version",
        supportSummary: "Must be rejected",
        sourceLabel: "Public source",
        publishedAtMs: 1_000,
        expiresAtMs: 4_000,
        publicCardRevision: "pcr_1",
        deckVersion: deck.deckVersion,
        manifestHash: deck.manifestHash,
        occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
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

  test("restores the durable projection database and rejects forged revisions", () => {
    const store = createProjectionGatewayStore();
    const gateway = new PreparedEvidenceProjectionGateway(store);
    const join = gateway.createDisplayJoin(
      {
        displayId: "display_durable",
        deckVersion: deck.deckVersion,
        displayFingerprint: "fingerprint-stage-durable",
      },
      1_000,
    );
    const bound = gateway.bindDisplay(
      {
        displayJoinId: join.displayJoinId,
        presentationSessionId: "ps_durable",
        presentationSessionEpoch: "pse_1",
        expectedDisplayBindingEpoch: "dbe_0",
        expectedDeckVersion: deck.deckVersion,
        approvedDisplayId: join.displayId,
        approvedDisplayFingerprint: join.displayFingerprint,
        deck,
      },
      1_001,
    );
    if (bound.outcome !== "BOUND") throw new Error("binding fixture failed");
    expect(
      gateway.projectCard("ps_durable", {
        projectionId: "projection_durable_terminal",
        status: "PUBLISHED",
        claim: "Durable claim",
        supportSummary: "Durable support",
        sourceLabel: "Prepared source terminal",
        publishedAtMs: 1_002,
        expiresAtMs: null,
        publicCardRevision: "pcr_1",
        deckVersion: deck.deckVersion,
        manifestHash: deck.manifestHash,
        occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
      }),
    ).toBe(true);
    expect(
      gateway.projectCard("ps_durable", {
        projectionId: "projection_durable_terminal",
        status: "RETRACTED",
        publicCardRevision: "pcr_2",
        occurredAtMs: 1_003,
      }),
    ).toBe(true);
    const snapshot = snapshotProjectionGatewayStore(store);
    const restored = restoreProjectionGatewayStore(snapshot);
    expect(restored.outcome).toBe("RESTORED");
    if (restored.outcome !== "RESTORED") throw new Error("snapshot restore failed");
    expect(
      new PreparedEvidenceProjectionGateway(restored.store).claimDisplaySession(
        {
          displayJoinId: join.displayJoinId,
          displayId: join.displayId,
          displayFingerprint: join.displayFingerprint,
        },
        1_002,
      ),
    ).not.toBeNull();

    const forgedRevision = structuredClone(snapshot) as {
      projections: Array<{ publicCardRevision: string }>;
    };
    const forgedRevisionProjection = forgedRevision.projections[0];
    if (forgedRevisionProjection === undefined)
      throw new Error("snapshot fixture missing projection");
    forgedRevisionProjection.publicCardRevision = "pcr_9007199254740992";
    expect(restoreProjectionGatewayStore(forgedRevision)).toEqual({
      outcome: "INVALID_SNAPSHOT",
    });

    const unsafeOccurrence = structuredClone(snapshot) as {
      projections: Array<{ occurrence: { occurrenceSeq: number } }>;
    };
    const unsafeOccurrenceProjection = unsafeOccurrence.projections[0];
    if (unsafeOccurrenceProjection === undefined)
      throw new Error("snapshot fixture missing projection");
    unsafeOccurrenceProjection.occurrence.occurrenceSeq = Number.MAX_SAFE_INTEGER + 1;
    expect(restoreProjectionGatewayStore(unsafeOccurrence)).toEqual({
      outcome: "INVALID_SNAPSHOT",
    });

    const strippedTerminalHistory = structuredClone(snapshot) as {
      projections: Array<{ tombstones: unknown[] }>;
    };
    const strippedProjection = strippedTerminalHistory.projections[0];
    if (strippedProjection === undefined) throw new Error("snapshot fixture missing projection");
    strippedProjection.tombstones = [];
    expect(restoreProjectionGatewayStore(strippedTerminalHistory)).toEqual({
      outcome: "INVALID_SNAPSHOT",
    });
  });
});
