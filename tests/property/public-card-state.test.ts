import { describe, expect, test } from "bun:test";
import { PublicationAuthoritySchema } from "@impromptu/contracts/private";
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
  createCandidateLifecycle,
  createPublicCardStream,
  initialPublicPlaybackState,
  reduceCandidateLifecycle,
  restoreAudienceRoleStreams,
  restorePublicCardStream,
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

function candidate() {
  const initial = createCandidateLifecycle("candidate_primary", "candidate-v1", hash("c"));
  return reduceCandidateLifecycle(initial, {
    type: "QUALIFY",
    candidateVersion: "candidate-v1",
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
      candidateVersion: "candidate-v1",
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
    const resurrection = applyPublicCardEvent(restored, card(3));
    expect(resurrection).toMatchObject({ outcome: "TERMINAL_PROJECTION" });
    expect(resurrection.state).toEqual(restored);
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
      stream(),
      audienceSnapshot(),
      "PUBLIC_STAGE",
    );
    expect(restored.outcome).toBe("APPLIED");
    expect(String(restored.playback.publicPlaybackRevision)).toBe("pbr_1");
    expect(String(restored.cards.publicCardRevision)).toBe("pcr_2");

    expect(
      restoreAudienceRoleStreams(playback, stream(), audienceSnapshot(), "CONTROLLER").outcome,
    ).toBe("UNAUTHORIZED_ROLE");
    expect(
      restoreAudienceRoleStreams(playback, stream(), { role: "PUBLIC_STAGE" }, "PUBLIC_STAGE")
        .outcome,
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
      stream(),
      audienceSnapshot({ blackout: true }),
      "PUBLIC_STAGE",
    );
    expect(conflict.outcome).toBe("CONFLICTING_SNAPSHOT");
    expect(conflict.playback).toEqual(current);

    const hashConflict = restoreAudienceRoleStreams(
      current,
      stream(),
      audienceSnapshot({ deck: { ...parsed.deck, manifestHash: hash("d") } }),
      "PUBLIC_STAGE",
    );
    expect(hashConflict.outcome).toBe("CONFLICTING_SNAPSHOT");
    expect(hashConflict.playback).toEqual(current);

    const cardsAtTwo = applyPublicCardEvent(
      applyPublicCardEvent(stream(), card(1, "projection_live")).state,
      tombstone(2, "projection_other"),
    ).state;
    const stale = restoreAudienceRoleStreams(
      playback,
      cardsAtTwo,
      audienceSnapshot({ publicCardRevision: "pcr_1", tombstones: [] }),
      "PUBLIC_STAGE",
    );
    expect(stale.outcome).toBe("STALE_SNAPSHOT");
    expect(stale.cards).toEqual(cardsAtTwo);
  });
});
