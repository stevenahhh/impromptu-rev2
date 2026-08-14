import { describe, expect, test } from "bun:test";
import { PreparedEvidenceProjectionGateway } from "@impromptu/projection-gateway";
import {
  createPreparedEvidenceStore,
  PreparedEvidenceCoordinator,
  restorePreparedEvidenceStore,
  snapshotPreparedEvidenceStore,
} from "../src/prepared-evidence.ts";

const manifestHash = "a".repeat(64);
const sourceHash = "b".repeat(64);
const imageHash = "c".repeat(64);
const privateDeck = {
  deckId: "private_deck_alpha",
  deckVersion: "deck_alpha",
  manifestHash,
  title: "Prepared deck",
  ownerAccountId: "account_alpha",
  aclPolicyVersion: "acl-1",
  privateObjectPrefix: "private-decks/account-alpha/deck-alpha",
  slides: [
    {
      privateSlideId: "private_slide_one",
      publicSlideKey: "slide_one",
      ordinal: 1,
      speakerNotes: "private note",
      extractedText: "Slide one",
      sourceAssetIds: ["asset_one"],
    },
    {
      privateSlideId: "private_slide_two",
      publicSlideKey: "slide_two",
      ordinal: 2,
      speakerNotes: "private note two",
      extractedText: "Slide two",
      sourceAssetIds: ["asset_two"],
    },
  ],
};
const publicDeck = {
  deckVersion: "deck_alpha",
  manifestHash,
  title: "Prepared deck",
  slides: [
    {
      publicSlideKey: "slide_one",
      ordinal: 1,
      image: {
        url: "https://public.example.test/one.png",
        contentHash: imageHash,
        width: 1920,
        height: 1080,
      },
      accessibilityLabel: "Slide one",
    },
    {
      publicSlideKey: "slide_two",
      ordinal: 2,
      image: {
        url: "https://public.example.test/two.png",
        contentHash: imageHash,
        width: 1920,
        height: 1080,
      },
      accessibilityLabel: "Slide two",
    },
  ],
};

async function createBoundFlow(nowMs = 1_000) {
  const gateway = new PreparedEvidenceProjectionGateway();
  const store = createPreparedEvidenceStore();
  const coordinator = new PreparedEvidenceCoordinator(gateway, store, {
    accountSessionTtlMs: 10_000,
    presentationCapabilityTtlMs: 10_000,
  });
  const account = coordinator.createAccountSession(
    { accountId: "account_alpha", actorId: "actor_alpha" },
    nowMs,
  );
  const created = coordinator.createPresentation(
    account.accountSessionId,
    { privateDeck, publicDeck },
    nowMs,
  );
  if (created.outcome !== "APPLIED") throw new Error("fixture failed to create presentation");
  const join = gateway.createDisplayJoin(
    {
      displayId: "display_alpha",
      deckVersion: publicDeck.deckVersion,
      displayFingerprint: "fingerprint-stage-alpha",
    },
    nowMs,
  );
  const bound = await coordinator.approveDisplay(
    account.accountSessionId,
    {
      presentationSessionId: created.value.lifecycle.presentationSessionId,
      displayJoinId: join.displayJoinId,
      expectedDisplayBindingEpoch: "dbe_0",
      expectedDeckVersion: publicDeck.deckVersion,
      approvedDisplayId: join.displayId,
      approvedDisplayFingerprint: join.displayFingerprint,
    },
    nowMs,
  );
  if (bound.outcome !== "APPLIED") throw new Error("fixture failed to bind display");
  return { gateway, store, coordinator, account, created: created.value, bound: bound.value };
}

describe("prepared evidence private coordinator", () => {
  test("rejects expired and revoked account sessions", () => {
    const gateway = new PreparedEvidenceProjectionGateway();
    const coordinator = new PreparedEvidenceCoordinator(gateway, undefined, {
      accountSessionTtlMs: 100,
    });
    const expired = coordinator.createAccountSession(
      { accountId: "account_alpha", actorId: "actor_alpha" },
      1_000,
    );
    expect(coordinator.readAccountSession(expired.accountSessionId, 1_100)).toEqual({
      outcome: "REJECTED",
      reason: "ACCOUNT_SESSION_EXPIRED",
    });
    const revoked = coordinator.createAccountSession(
      { accountId: "account_alpha", actorId: "actor_alpha" },
      2_000,
    );
    expect(coordinator.revokeAccountSession(revoked.accountSessionId, 2_001).outcome).toBe(
      "APPLIED",
    );
    expect(coordinator.readAccountSession(revoked.accountSessionId, 2_002)).toEqual({
      outcome: "REJECTED",
      reason: "ACCOUNT_SESSION_REVOKED",
    });
  });

  test("restores durable sessions and rejects forged unsafe counters", async () => {
    const flow = await createBoundFlow();
    const snapshot = snapshotPreparedEvidenceStore(flow.store);
    const restored = restorePreparedEvidenceStore(snapshot);
    expect(restored.outcome).toBe("RESTORED");
    if (restored.outcome !== "RESTORED") throw new Error("snapshot restore failed");
    const restarted = new PreparedEvidenceCoordinator(flow.gateway, restored.store);
    expect(restarted.readAccountSession(flow.account.accountSessionId, 1_002).outcome).toBe(
      "APPLIED",
    );

    const forged = structuredClone(snapshot) as {
      presentations: Array<{ playback: { controlRevision: string } }>;
    };
    const presentation = forged.presentations[0];
    if (presentation === undefined) throw new Error("snapshot fixture missing presentation");
    presentation.playback.controlRevision = "cr_9007199254740992";
    expect(restorePreparedEvidenceStore(forged)).toEqual({ outcome: "INVALID_SNAPSHOT" });
  });

  test("accepts absolute slide.set and records only the ordered Stage prefix after restart", async () => {
    const flow = await createBoundFlow();
    const playbackEvents: string[] = [];
    flow.gateway.connectStage(
      flow.bound.audienceDisplaySessionId,
      {
        onPlayback: (event) => playbackEvents.push(event.commandId),
        onCard: () => undefined,
        onClose: () => undefined,
      },
      1_001,
    );
    const first = await flow.coordinator.setSlide(
      flow.account.accountSessionId,
      {
        presentationSessionId: flow.created.lifecycle.presentationSessionId,
        commandId: "cmd_one",
        publicSlideKey: "slide_two",
        displayBindingEpoch: "dbe_1",
        baseRevision: "cr_0",
      },
      1_002,
    );
    const second = await flow.coordinator.setSlide(
      flow.account.accountSessionId,
      {
        presentationSessionId: flow.created.lifecycle.presentationSessionId,
        commandId: "cmd_two",
        publicSlideKey: "slide_one",
        displayBindingEpoch: "dbe_1",
        baseRevision: "cr_1",
      },
      1_003,
    );
    expect(first.outcome).toBe("APPLIED");
    expect(second.outcome).toBe("APPLIED");
    expect(playbackEvents).toEqual(["cmd_one", "cmd_two"]);

    const restarted = new PreparedEvidenceCoordinator(flow.gateway, flow.store);
    expect(
      await restarted.recordStageApplied({
        audienceDisplaySessionId: flow.bound.audienceDisplaySessionId,
        commandId: "cmd_two",
        displayBindingEpoch: "dbe_1",
      }),
    ).toEqual({ outcome: "REJECTED", reason: "OUT_OF_ORDER" });
    const appliedFirst = await restarted.recordStageApplied({
      audienceDisplaySessionId: flow.bound.audienceDisplaySessionId,
      commandId: "cmd_one",
      displayBindingEpoch: "dbe_1",
    });
    const appliedSecond = await restarted.recordStageApplied({
      audienceDisplaySessionId: flow.bound.audienceDisplaySessionId,
      commandId: "cmd_two",
      displayBindingEpoch: "dbe_1",
    });
    expect(appliedFirst.outcome).toBe("APPLIED");
    expect(appliedSecond.outcome).toBe("APPLIED");
    if (appliedFirst.outcome !== "APPLIED" || appliedSecond.outcome !== "APPLIED") {
      throw new Error("ordered receipts were rejected");
    }
    expect(String(appliedFirst.value.publicPlaybackRevision)).toBe("pbr_1");
    expect(String(appliedSecond.value.publicPlaybackRevision)).toBe("pbr_2");
  });

  test("publishes curated evidence with an uncorrelatable ID and terminal CAS tombstone", async () => {
    const flow = await createBoundFlow();
    const cardEvents: string[] = [];
    flow.gateway.connectStage(
      flow.bound.audienceDisplaySessionId,
      {
        onPlayback: () => undefined,
        onCard: (event) => cardEvents.push(`${event.publicCardRevision}:${event.status}`),
        onClose: () => undefined,
      },
      1_001,
    );
    const candidate = {
      candidateId: "candidate_private_alpha",
      candidateVersion: "candidate-version-1",
      provenance: "CURATED_PREAPPROVED",
      verdict: "SUPPORTED",
      claimText: "Prepared claim",
      evidenceExcerpt: "Prepared support",
      privateSourceUri: "private://source/alpha",
      causal: {
        presentationSessionId: flow.created.lifecycle.presentationSessionId,
        presentationSessionEpoch: "pse_1",
        displayBindingEpoch: "dbe_1",
        deckVersion: publicDeck.deckVersion,
        manifestHash,
        occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
        transcriptFinalId: null,
        source: {
          sourceId: "source_alpha",
          revision: "source-revision-1",
          contentHash: sourceHash,
        },
        decisions: {
          acl: "acl-1",
          publicationPolicy: "publication-policy-1",
          rights: "rights-1",
          dlp: "dlp-1",
        },
      },
    };
    const added = flow.coordinator.addCuratedCandidate(
      flow.account.accountSessionId,
      candidate,
      1_002,
    );
    expect(added.outcome).toBe("APPLIED");
    const published = await flow.coordinator.approveCandidate(
      flow.account.accountSessionId,
      {
        presentationSessionId: flow.created.lifecycle.presentationSessionId,
        candidateId: candidate.candidateId,
        expectedCandidateRevision: "candrev_1",
        expectedPublicCardRevision: "pcr_0",
        authorityId: flow.created.authority.authorityId,
        expiresAtMs: null,
      },
      1_003,
    );
    if (published.outcome !== "APPLIED") throw new Error("fixture failed to publish");
    expect(published.value.projectionId).not.toContain(candidate.candidateId);
    expect(published.value.sourceLabel).toBe(
      `Prepared source ${published.value.projectionId.slice(-8)}`,
    );
    const publicProjection = JSON.stringify(published.value);
    expect(publicProjection).not.toContain("private://");
    expect(publicProjection).not.toContain(candidate.candidateId);
    expect(publicProjection).not.toContain(candidate.causal.source.sourceId);
    expect(publicProjection).not.toContain(candidate.causal.source.contentHash);
    const stale = await flow.coordinator.terminateCard(
      flow.account.accountSessionId,
      {
        presentationSessionId: flow.created.lifecycle.presentationSessionId,
        projectionId: published.value.projectionId,
        expectedPublicCardRevision: "pcr_0",
        authorityId: flow.created.authority.authorityId,
        status: "RETRACTED",
      },
      1_004,
    );
    expect(stale).toEqual({ outcome: "REJECTED", reason: "CAS_CONFLICT" });
    const retracted = await flow.coordinator.terminateCard(
      flow.account.accountSessionId,
      {
        presentationSessionId: flow.created.lifecycle.presentationSessionId,
        projectionId: published.value.projectionId,
        expectedPublicCardRevision: "pcr_1",
        authorityId: flow.created.authority.authorityId,
        status: "RETRACTED",
      },
      1_005,
    );
    expect(retracted.outcome).toBe("APPLIED");
    expect(cardEvents).toEqual(["pcr_1:PUBLISHED", "pcr_2:RETRACTED"]);
    expect(flow.gateway.snapshot(flow.bound.audienceDisplaySessionId, 1_006)?.cards).toEqual([]);
  });

  test("rejects approval when a rebind makes the curated candidate stale", async () => {
    const flow = await createBoundFlow();
    const candidate = {
      candidateId: "candidate_pending_rebind",
      candidateVersion: "candidate-version-1",
      provenance: "CURATED_PREAPPROVED",
      verdict: "SUPPORTED",
      claimText: "Pending claim",
      evidenceExcerpt: "Pending support",
      privateSourceUri: "private://source/pending",
      causal: {
        presentationSessionId: flow.created.lifecycle.presentationSessionId,
        presentationSessionEpoch: "pse_1",
        displayBindingEpoch: "dbe_1",
        deckVersion: publicDeck.deckVersion,
        manifestHash,
        occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
        transcriptFinalId: null,
        source: {
          sourceId: "source_pending",
          revision: "source-revision-1",
          contentHash: sourceHash,
        },
        decisions: {
          acl: "acl-1",
          publicationPolicy: "publication-policy-1",
          rights: "rights-1",
          dlp: "dlp-1",
        },
      },
    };
    expect(
      flow.coordinator.addCuratedCandidate(flow.account.accountSessionId, candidate, 1_002).outcome,
    ).toBe("APPLIED");
    const join = flow.gateway.createDisplayJoin(
      {
        displayId: "display_beta",
        deckVersion: publicDeck.deckVersion,
        displayFingerprint: "fingerprint-stage-beta",
      },
      1_003,
    );
    const rebound = await flow.coordinator.approveDisplay(
      flow.account.accountSessionId,
      {
        presentationSessionId: flow.created.lifecycle.presentationSessionId,
        displayJoinId: join.displayJoinId,
        expectedDisplayBindingEpoch: "dbe_1",
        expectedDeckVersion: publicDeck.deckVersion,
        approvedDisplayId: join.displayId,
        approvedDisplayFingerprint: join.displayFingerprint,
      },
      1_004,
    );
    expect(rebound.outcome).toBe("APPLIED");
    expect(
      await flow.coordinator.approveCandidate(
        flow.account.accountSessionId,
        {
          presentationSessionId: flow.created.lifecycle.presentationSessionId,
          candidateId: candidate.candidateId,
          expectedCandidateRevision: "candrev_1",
          expectedPublicCardRevision: "pcr_0",
          authorityId: flow.created.authority.authorityId,
          expiresAtMs: null,
        },
        1_005,
      ),
    ).toEqual({ outcome: "REJECTED", reason: "STALE_CANDIDATE" });
  });
});
