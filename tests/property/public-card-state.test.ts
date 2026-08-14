import { describe, expect, test } from "bun:test";
import {
  CandidateIdSchema,
  candidateRevision,
  PublicationAuthoritySchema,
} from "@impromptu/contracts/private";
import {
  AudienceSnapshotSchema,
  displayBindingEpoch,
  PresentationSessionIdSchema,
  PublicationTombstoneSchema,
  PublishedAudienceCardSchema,
  presentationSessionEpoch,
  publicPlaybackRevision,
} from "@impromptu/contracts/public";
import {
  applyAuthorizedPublicCardEvent,
  applyPublicCardEvent,
  applyPublicPlaybackEvent,
  createAudienceCardSnapshotState,
  createCandidateLifecycle,
  createPublicCardStream,
  initialPublicPlaybackState,
  reduceCandidateLifecycle,
  restoreAudienceCardSnapshotState,
  restoreAudienceRoleStreams,
  restorePublicCardStream,
  snapshotAudienceCardState,
} from "@impromptu/state";
import { fastCheckParameters } from "@impromptu/test-harness";
import fc from "fast-check";

const hash = (digit: string): string => digit.repeat(64);
const nowMs = 1_700_000_000_000;
const propertyOptions = fastCheckParameters();

function card(revision: number, projectionId = "projection_card-1") {
  return PublishedAudienceCardSchema.parse({
    projectionId,
    status: "PUBLISHED",
    claim: "A declassified claim",
    supportSummary: "A declassified summary",
    sourceLabel: "Approved source",
    publishedAtMs: nowMs,
    expiresAtMs: null,
    publicCardRevision: `pcr_${revision}`,
    deckVersion: "deck_v1",
    manifestHash: hash("a"),
    occurrence: { publicSlideKey: "slide_1", occurrenceSeq: 1 },
  });
}

function tombstone(revision: number, projectionId = "projection_card-1") {
  return PublicationTombstoneSchema.parse({
    projectionId,
    status: "RETRACTED",
    publicCardRevision: `pcr_${revision}`,
    occurredAtMs: nowMs + revision,
  });
}

function authority() {
  return PublicationAuthoritySchema.parse({
    authorityId: "pubauth_primary",
    presentationSessionId: "ps_session-1",
    presentationSessionEpoch: "pse_3",
    actorId: "actor_publisher-1",
    policyVersion: "policy-v2",
    expiresAtMs: 1_800_000_000_000,
  });
}

function stream() {
  return createPublicCardStream({
    presentationSessionId: PresentationSessionIdSchema.parse("ps_session-1"),
    presentationSessionEpoch: presentationSessionEpoch(3),
    authority: authority(),
  });
}

function audienceCards() {
  return createAudienceCardSnapshotState({
    presentationSessionId: PresentationSessionIdSchema.parse("ps_session-1"),
    presentationSessionEpoch: presentationSessionEpoch(3),
  });
}

function candidate() {
  const initial = createCandidateLifecycle({
    presentationSessionId: PresentationSessionIdSchema.parse("ps_session-1"),
    presentationSessionEpoch: presentationSessionEpoch(3),
    candidateId: CandidateIdSchema.parse("candidate_primary"),
    candidateVersion: "candidate-v1",
    contentHash: hash("c"),
  });
  return reduceCandidateLifecycle(initial, {
    type: "QUALIFY",
    presentationSessionId: initial.presentationSessionId,
    presentationSessionEpoch: initial.presentationSessionEpoch,
    candidateId: initial.candidateId,
    candidateVersion: initial.candidateVersion,
    expectedRevision: candidateRevision(0),
  }).state;
}

function audienceSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    role: "PUBLIC_STAGE",
    presentationSessionId: "ps_session-1",
    presentationSessionEpoch: "pse_3",
    displayBindingEpoch: "dbe_2",
    publicPlaybackRevision: "pbr_1",
    publicCardRevision: "pcr_2",
    deck: {
      deckVersion: "deck_v1",
      manifestHash: hash("a"),
      title: "Published deck",
      slides: [
        {
          publicSlideKey: "slide_1",
          ordinal: 1,
          image: {
            url: "https://published.example/slide-1.png",
            contentHash: hash("b"),
            width: 1920,
            height: 1080,
          },
          accessibilityLabel: "Published slide",
        },
      ],
    },
    occurrence: { publicSlideKey: "slide_1", occurrenceSeq: 1 },
    blackout: false,
    cards: [],
    tombstones: [tombstone(2)],
    tombstoneWatermark: "pcr_1",
    ...overrides,
  };
}

describe("audience snapshot invariants", () => {
  test("rejects entries beyond the stream head and invalid watermarks", () => {
    expect(
      AudienceSnapshotSchema.safeParse(
        audienceSnapshot({ publicCardRevision: "pcr_1", tombstones: [tombstone(2)] }),
      ).success,
    ).toBe(false);
    expect(
      AudienceSnapshotSchema.safeParse(audienceSnapshot({ tombstoneWatermark: "pcr_3" })).success,
    ).toBe(false);
  });

  test("rejects active/tombstoned overlap and cards at or below the watermark", () => {
    expect(
      AudienceSnapshotSchema.safeParse(
        audienceSnapshot({ cards: [card(1)], tombstones: [tombstone(2)] }),
      ).success,
    ).toBe(false);
    expect(
      AudienceSnapshotSchema.safeParse(
        audienceSnapshot({ cards: [card(1, "projection_live")], tombstones: [tombstone(2)] }),
      ).success,
    ).toBe(false);
    expect(
      AudienceSnapshotSchema.safeParse(
        audienceSnapshot({
          cards: [card(2, "projection_live")],
          tombstones: [],
          tombstoneWatermark: "pcr_1",
        }),
      ).success,
    ).toBe(true);
  });
});

describe("candidate and public card stream separation", () => {
  test("keeps candidate lifecycle immutable and stale candidates non-public", () => {
    const eligible = candidate();
    const published = applyAuthorizedPublicCardEvent(
      stream(),
      eligible,
      {
        presentationSessionId: "ps_session-1",
        presentationSessionEpoch: "pse_3",
        authorityId: "pubauth_primary",
        expectedRevision: "pcr_0",
        payload: card(1),
      },
      nowMs,
    );
    expect(published.outcome).toBe("APPLIED");
    expect(eligible.status).toBe("ELIGIBLE");

    const stale = reduceCandidateLifecycle(eligible, {
      type: "MARK_STALE",
      presentationSessionId: eligible.presentationSessionId,
      presentationSessionEpoch: eligible.presentationSessionEpoch,
      candidateId: eligible.candidateId,
      candidateVersion: eligible.candidateVersion,
      expectedRevision: eligible.candidateRevision,
    }).state;
    const rejected = applyAuthorizedPublicCardEvent(
      stream(),
      stale,
      {
        presentationSessionId: "ps_session-1",
        presentationSessionEpoch: "pse_3",
        authorityId: "pubauth_primary",
        expectedRevision: "pcr_0",
        payload: card(1),
      },
      nowMs,
    );
    expect(rejected.outcome).toBe("REJECTED");
    if (rejected.outcome !== "REJECTED") throw new Error("stale candidate was published");
    expect(rejected.reason).toBe("CANDIDATE_NOT_ELIGIBLE");
    expect(stale).toMatchObject({
      candidateId: eligible.candidateId,
      candidateVersion: eligible.candidateVersion,
      contentHash: eligible.contentHash,
    });

    const superseded = reduceCandidateLifecycle(eligible, {
      type: "SUPERSEDE",
      presentationSessionId: eligible.presentationSessionId,
      presentationSessionEpoch: eligible.presentationSessionEpoch,
      candidateId: eligible.candidateId,
      candidateVersion: eligible.candidateVersion,
      expectedRevision: eligible.candidateRevision,
    }).state;
    const supersededResult = applyAuthorizedPublicCardEvent(
      stream(),
      superseded,
      {
        presentationSessionId: "ps_session-1",
        presentationSessionEpoch: "pse_3",
        authorityId: "pubauth_primary",
        expectedRevision: "pcr_0",
        payload: card(1),
      },
      nowMs,
    );
    expect(supersededResult).toMatchObject({
      outcome: "REJECTED",
      reason: "CANDIDATE_NOT_ELIGIBLE",
    });
  });

  test("validates publication authority and presentation epoch before stream CAS", () => {
    const event = {
      presentationSessionId: "ps_session-1",
      presentationSessionEpoch: "pse_2",
      authorityId: "pubauth_primary",
      expectedRevision: "pcr_99",
      payload: card(100),
    } as const;
    const staleSession = applyAuthorizedPublicCardEvent(stream(), candidate(), event, nowMs);
    expect(staleSession).toMatchObject({ outcome: "REJECTED", reason: "STALE_SESSION_EPOCH" });

    const staleAuthority = applyAuthorizedPublicCardEvent(
      stream(),
      candidate(),
      { ...event, presentationSessionEpoch: "pse_3", authorityId: "pubauth_old" },
      nowMs,
    );
    expect(staleAuthority).toMatchObject({ outcome: "REJECTED", reason: "STALE_AUTHORITY" });
  });

  test("detects gaps and makes tombstones terminal across restart", () => {
    const upserted = applyPublicCardEvent(stream(), card(1));
    expect(upserted.outcome).toBe("APPLIED");
    const gap = applyPublicCardEvent(upserted.state, tombstone(3));
    expect(gap.outcome).toBe("GAP_REQUIRES_SNAPSHOT");

    const retracted = applyPublicCardEvent(upserted.state, tombstone(2));
    expect(retracted.outcome).toBe("APPLIED");
    const restored = restorePublicCardStream(structuredClone(retracted.state));
    expect(restored.outcome).toBe("RESTORED");
    if (restored.outcome !== "RESTORED") throw new Error("valid card snapshot was rejected");
    expect(
      restorePublicCardStream({
        ...retracted.state,
        cards: { [card(3).projectionId]: card(3) },
      }),
    ).toEqual({ outcome: "INVALID_SNAPSHOT" });
    expect(
      restorePublicCardStream({
        ...retracted.state,
        publicCardRevision: "pcr_9007199254740992",
      }),
    ).toEqual({ outcome: "INVALID_SNAPSHOT" });
    expect(
      restorePublicCardStream({
        ...retracted.state,
        eventsByRevision: { pcr_2: tombstone(2) },
      }),
    ).toEqual({ outcome: "INVALID_SNAPSHOT" });
    expect(
      restorePublicCardStream({
        ...retracted.state,
        eventsByRevision: { pcr_1: tombstone(2), pcr_2: tombstone(2) },
      }),
    ).toEqual({ outcome: "INVALID_SNAPSHOT" });
    expect(
      restorePublicCardStream({
        ...retracted.state,
        tombstones: {},
      }),
    ).toEqual({ outcome: "INVALID_SNAPSHOT" });
    expect(
      restorePublicCardStream({
        ...retracted.state,
        tombstoneWatermark: "pcr_1",
      }),
    ).toEqual({ outcome: "INVALID_SNAPSHOT" });
    expect(
      restorePublicCardStream({
        ...retracted.state,
        publicCardRevision: "pcr_3",
        eventsByRevision: {
          ...retracted.state.eventsByRevision,
          pcr_3: card(3),
        },
      }),
    ).toEqual({ outcome: "INVALID_SNAPSHOT" });
    const resurrection = applyPublicCardEvent(restored.state, card(3));
    expect(resurrection).toMatchObject({ outcome: "TERMINAL_PROJECTION" });
    expect(resurrection.state).toEqual(restored.state);
  });

  test("converges generated duplicate and out-of-order card schedules without resurrection", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 1 }), { maxLength: 80 }), (selectors) => {
        const events = [card(1), tombstone(2)] as const;
        const schedule = [
          ...selectors.map((selector) => (selector === 0 ? events[0] : events[1])),
          ...events,
        ];
        const first = schedule.reduce(
          (state, event) => applyPublicCardEvent(state, event).state,
          stream(),
        );
        const replay = schedule.reduce(
          (state, event) => applyPublicCardEvent(state, event).state,
          stream(),
        );
        expect(first).toEqual(replay);
        expect(first.cards["projection_card-1"]).toBeUndefined();
        expect(first.tombstones["projection_card-1"]).toBeDefined();
        expect(applyPublicCardEvent(first, card(3)).outcome).toBe("TERMINAL_PROJECTION");
      }),
      propertyOptions,
    );
  });
});

describe("compacted audience card persistence", () => {
  test("round-trips compacted state and rejects forged maps and counters", () => {
    const parsed = AudienceSnapshotSchema.parse(audienceSnapshot());
    const restored = restoreAudienceCardSnapshotState({
      stateKind: "COMPACT_AUDIENCE_CARD_SNAPSHOT",
      presentationSessionId: parsed.presentationSessionId,
      presentationSessionEpoch: parsed.presentationSessionEpoch,
      publicCardRevision: parsed.publicCardRevision,
      tombstoneWatermark: parsed.tombstoneWatermark,
      cards: {},
      tombstones: Object.fromEntries(parsed.tombstones.map((entry) => [entry.projectionId, entry])),
    });
    expect(restored.outcome).toBe("RESTORED");
    if (restored.outcome !== "RESTORED") throw new Error("compact snapshot was rejected");
    const persisted = snapshotAudienceCardState(restored.state);
    expect(persisted).toEqual(restored);
    if (persisted.outcome !== "RESTORED") throw new Error("compact state did not snapshot");
    expect(restoreAudienceCardSnapshotState(persisted.state)).toEqual(restored);
    expect(snapshotAudienceCardState(stream())).toEqual({ outcome: "INVALID_SNAPSHOT" });
    expect(restoreAudienceCardSnapshotState(stream())).toEqual({ outcome: "INVALID_SNAPSHOT" });
    expect(restorePublicCardStream(restored.state)).toEqual({ outcome: "INVALID_SNAPSHOT" });
    expect(
      restoreAudienceCardSnapshotState({
        ...restored.state,
        tombstones: { forged: parsed.tombstones[0] },
      }),
    ).toEqual({ outcome: "INVALID_SNAPSHOT" });
    expect(
      restoreAudienceCardSnapshotState({
        ...restored.state,
        cards: { [card(2).projectionId]: card(2) },
      }),
    ).toEqual({ outcome: "INVALID_SNAPSHOT" });
    expect(
      restoreAudienceCardSnapshotState({
        ...restored.state,
        publicCardRevision: "pcr_3",
      }),
    ).toEqual({ outcome: "INVALID_SNAPSHOT" });
    expect(
      restoreAudienceCardSnapshotState({
        ...restored.state,
        publicCardRevision: "pcr_9007199254740991",
      }),
    ).toEqual({ outcome: "INVALID_SNAPSHOT" });
    expect(
      restoreAudienceCardSnapshotState({
        ...restored.state,
        publicCardRevision: "pcr_9007199254740992",
      }),
    ).toEqual({ outcome: "INVALID_SNAPSHOT" });
  });
});

describe("runtime role snapshot restore", () => {
  test("parses unknown input, authorizes exact role, and restores streams independently", () => {
    const playback = initialPublicPlaybackState({
      presentationSessionId: PresentationSessionIdSchema.parse("ps_session-1"),
      presentationSessionEpoch: presentationSessionEpoch(3),
      displayBindingEpoch: displayBindingEpoch(2),
      deckVersion: AudienceSnapshotSchema.parse(audienceSnapshot()).deck.deckVersion,
      manifestHash: hash("a"),
      occurrence: AudienceSnapshotSchema.parse(audienceSnapshot()).occurrence,
      blackout: false,
    });
    const advancedPlayback = applyPublicPlaybackEvent(playback, {
      ...playback,
      publicPlaybackRevision: publicPlaybackRevision(1),
    }).state;
    const restored = restoreAudienceRoleStreams(
      advancedPlayback,
      audienceCards(),
      audienceSnapshot(),
      "PUBLIC_STAGE",
    );
    expect(restored.outcome).toBe("APPLIED");
    expect(String(restored.playback.publicPlaybackRevision)).toBe("pbr_1");
    expect(String(restored.cards.publicCardRevision)).toBe("pcr_2");
    const persistedCards = snapshotAudienceCardState(restored.cards);
    expect(persistedCards.outcome).toBe("RESTORED");
    if (persistedCards.outcome !== "RESTORED") throw new Error("role cards did not snapshot");
    const restartedCards = restoreAudienceCardSnapshotState(persistedCards.state);
    expect(restartedCards.outcome).toBe("RESTORED");
    if (restartedCards.outcome !== "RESTORED") throw new Error("role cards did not restart");
    expect(
      restoreAudienceRoleStreams(
        restored.playback,
        restartedCards.state,
        audienceSnapshot(),
        "PUBLIC_STAGE",
      ).outcome,
    ).toBe("DUPLICATE");

    expect(
      restoreAudienceRoleStreams(playback, audienceCards(), audienceSnapshot(), "CONTROLLER")
        .outcome,
    ).toBe("UNAUTHORIZED_ROLE");
    expect(
      restoreAudienceRoleStreams(
        playback,
        audienceCards(),
        { role: "PUBLIC_STAGE" },
        "PUBLIC_STAGE",
      ).outcome,
    ).toBe("INVALID_SNAPSHOT");
    expect(() =>
      restoreAudienceRoleStreams(
        playback,
        audienceCards(),
        audienceSnapshot({ publicCardRevision: "pcr_9007199254740992" }),
        "PUBLIC_STAGE",
      ),
    ).not.toThrow();
    expect(
      restoreAudienceRoleStreams(
        playback,
        audienceCards(),
        audienceSnapshot({ publicCardRevision: "pcr_9007199254740992" }),
        "PUBLIC_STAGE",
      ).outcome,
    ).toBe("INVALID_SNAPSHOT");
  });

  test("rejects equal-revision different state and stale snapshots atomically", () => {
    const parsed = AudienceSnapshotSchema.parse(audienceSnapshot());
    const playback = initialPublicPlaybackState({
      presentationSessionId: parsed.presentationSessionId,
      presentationSessionEpoch: parsed.presentationSessionEpoch,
      displayBindingEpoch: parsed.displayBindingEpoch,
      deckVersion: parsed.deck.deckVersion,
      manifestHash: parsed.deck.manifestHash,
      occurrence: parsed.occurrence,
      blackout: parsed.blackout,
    });
    const current = { ...playback, publicPlaybackRevision: parsed.publicPlaybackRevision };
    const conflict = restoreAudienceRoleStreams(
      current,
      audienceCards(),
      audienceSnapshot({ blackout: true }),
      "PUBLIC_STAGE",
    );
    expect(conflict.outcome).toBe("CONFLICTING_SNAPSHOT");
    expect(conflict.playback).toEqual(current);

    const hashConflict = restoreAudienceRoleStreams(
      current,
      audienceCards(),
      audienceSnapshot({ deck: { ...parsed.deck, manifestHash: hash("d") } }),
      "PUBLIC_STAGE",
    );
    expect(hashConflict.outcome).toBe("CONFLICTING_SNAPSHOT");
    expect(hashConflict.playback).toEqual(current);

    const cardsAtTwo = restoreAudienceCardSnapshotState({
      ...audienceCards(),
      publicCardRevision: "pcr_2",
      cards: { projection_live: card(1, "projection_live") },
      tombstones: { projection_other: tombstone(2, "projection_other") },
    });
    if (cardsAtTwo.outcome !== "RESTORED") throw new Error("current role cards were rejected");
    const stale = restoreAudienceRoleStreams(
      playback,
      cardsAtTwo.state,
      audienceSnapshot({ publicCardRevision: "pcr_1", tombstones: [] }),
      "PUBLIC_STAGE",
    );
    expect(stale.outcome).toBe("STALE_SNAPSHOT");
    expect(stale.cards).toEqual(cardsAtTwo.state);
  });
});
