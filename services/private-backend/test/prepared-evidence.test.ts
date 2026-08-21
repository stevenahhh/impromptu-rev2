import { describe, expect, test } from "bun:test";
import type { EvidenceCandidate } from "@impromptu/contracts/private";
import { PreparedEvidenceProjectionGateway } from "@impromptu/projection-gateway";
import { applyAuthorizedPublicCardEvent, reduceCandidateLifecycle } from "@impromptu/state";
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

async function createBoundFlow(
  nowMs = 1_000,
  liveEvidenceAuthorizer?: { authorize(candidate: EvidenceCandidate): Promise<boolean> },
  livePublicEnabled = false,
) {
  const gateway = new PreparedEvidenceProjectionGateway();
  const store = createPreparedEvidenceStore();
  const coordinator = new PreparedEvidenceCoordinator(gateway, store, {
    accountSessionTtlMs: 10_000,
    presentationCapabilityTtlMs: 10_000,
    ...(liveEvidenceAuthorizer === undefined ? {} : { liveEvidenceAuthorizer }),
    livePublicEnabled,
  });
  const account = await coordinator.createAccountSession(
    { accountId: "account_alpha", actorId: "actor_alpha" },
    nowMs,
  );
  const created = await coordinator.createPresentation(
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
  test("rejects every forged public-card transition before state or projection side effects", async () => {
    const flow = await createBoundFlow();
    const before = JSON.stringify(snapshotPreparedEvidenceStore(flow.store));
    const forgedApproval = {
      presentationSessionId: flow.created.lifecycle.presentationSessionId,
      candidateId: "candidate_forged_source_kind",
      expectedCandidateRevision: "candrev_9007199254740991",
      expectedPublicCardRevision: "pcr_9007199254740991",
      authorityId: flow.created.authority.authorityId,
      expiresAtMs: null,
      sourceKind: "CURATED_PREAPPROVED",
    };

    expect(
      await flow.coordinator.approveCandidate(flow.account.accountSessionId, forgedApproval, 1_001),
    ).toEqual({ outcome: "REJECTED", reason: "PUBLICATION_DISABLED" });
    expect(
      await flow.coordinator.terminateCard(
        flow.account.accountSessionId,
        {
          presentationSessionId: flow.created.lifecycle.presentationSessionId,
          projectionId: "projection_forged",
          expectedPublicCardRevision: "pcr_9007199254740991",
          authorityId: flow.created.authority.authorityId,
          status: "RETRACTED",
        },
        1_001,
      ),
    ).toEqual({ outcome: "REJECTED", reason: "PUBLICATION_DISABLED" });
    expect(JSON.stringify(snapshotPreparedEvidenceStore(flow.store))).toBe(before);
    expect(flow.gateway.snapshot(flow.bound.audienceDisplaySessionId, 1_002)?.cards).toEqual([]);
  });

  test("rejects expired and revoked account sessions", async () => {
    const gateway = new PreparedEvidenceProjectionGateway();
    const coordinator = new PreparedEvidenceCoordinator(gateway, undefined, {
      accountSessionTtlMs: 100,
    });
    const expired = await coordinator.createAccountSession(
      { accountId: "account_alpha", actorId: "actor_alpha" },
      1_000,
    );
    expect(await coordinator.readAccountSession(expired.accountSessionId, 1_100)).toEqual({
      outcome: "REJECTED",
      reason: "ACCOUNT_SESSION_EXPIRED",
    });
    const revoked = await coordinator.createAccountSession(
      { accountId: "account_alpha", actorId: "actor_alpha" },
      2_000,
    );
    expect((await coordinator.revokeAccountSession(revoked.accountSessionId, 2_001)).outcome).toBe(
      "APPLIED",
    );
    expect(await coordinator.readAccountSession(revoked.accountSessionId, 2_002)).toEqual({
      outcome: "REJECTED",
      reason: "ACCOUNT_SESSION_REVOKED",
    });
  });

  test("takes over an authenticated lease, supersedes pending work, and closes the old socket", async () => {
    const flow = await createBoundFlow();
    const closeReasons: string[] = [];
    const socket = await flow.coordinator.connectPlaybackController(
      flow.account.accountSessionId,
      flow.created.lifecycle.presentationSessionId,
      1_002,
      (reason) => closeReasons.push(reason),
    );
    expect(socket.outcome).toBe("APPLIED");
    expect(
      (
        await flow.coordinator.setSlide(
          flow.account.accountSessionId,
          {
            presentationSessionId: flow.created.lifecycle.presentationSessionId,
            commandId: "cmd_pending_takeover",
            publicSlideKey: "slide_two",
            displayBindingEpoch: "dbe_1",
            baseRevision: "cr_0",
          },
          1_003,
        )
      ).outcome,
    ).toBe("APPLIED");
    const replacementAccount = await flow.coordinator.createAccountSession(
      { accountId: "account_alpha", actorId: "actor_beta" },
      1_004,
    );
    expect(
      await flow.coordinator.takeoverPlaybackLease(
        replacementAccount.accountSessionId,
        {
          presentationSessionId: flow.created.lifecycle.presentationSessionId,
          expectedDisplayBindingEpoch: "dbe_0",
        },
        1_005,
      ),
    ).toEqual({ outcome: "REJECTED", reason: "STALE_DISPLAY_BINDING" });
    const takeover = await flow.coordinator.takeoverPlaybackLease(
      replacementAccount.accountSessionId,
      {
        presentationSessionId: flow.created.lifecycle.presentationSessionId,
        expectedDisplayBindingEpoch: "dbe_1",
      },
      1_006,
    );
    expect(takeover.outcome).toBe("APPLIED");
    if (takeover.outcome !== "APPLIED") throw new Error("takeover fixture failed");
    expect(String(takeover.value.lease.controllerEpoch)).toBe("ce_2");
    expect(takeover.value.supersededReceipts).toHaveLength(1);
    expect(takeover.value.supersededReceipts[0]?.status).toBe("SUPERSEDED");
    expect(String(takeover.value.supersededReceipts[0]?.commandId)).toBe("cmd_pending_takeover");
    expect(closeReasons).toEqual(["SUPERSEDED"]);
    const rejectedOldController = await flow.coordinator.setSlide(
      flow.account.accountSessionId,
      {
        presentationSessionId: flow.created.lifecycle.presentationSessionId,
        commandId: "cmd_old_controller",
        publicSlideKey: "slide_one",
        displayBindingEpoch: "dbe_1",
        baseRevision: "cr_1",
      },
      1_007,
    );
    expect(rejectedOldController).toEqual({ outcome: "REJECTED", reason: "UNAUTHORIZED" });
  });

  test("restores durable sessions and rejects forged candidate lifecycle identity", async () => {
    const flow = await createBoundFlow();
    expect(
      (
        await flow.coordinator.addCuratedCandidate(
          flow.account.accountSessionId,
          {
            candidateId: "candidate_durable_identity",
            candidateVersion: "candidate-version-durable",
            provenance: "CURATED_PREAPPROVED",
            verdict: "SUPPORTED",
            claimText: "Durable candidate",
            evidenceExcerpt: "Durable support",
            privateSourceUri: "private://source/durable",
            causal: {
              presentationSessionId: flow.created.lifecycle.presentationSessionId,
              presentationSessionEpoch: "pse_1",
              displayBindingEpoch: "dbe_1",
              deckVersion: publicDeck.deckVersion,
              manifestHash,
              occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
              transcriptFinalId: null,
              source: {
                sourceId: "source_durable",
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
          },
          1_002,
        )
      ).outcome,
    ).toBe("APPLIED");
    const snapshot = snapshotPreparedEvidenceStore(flow.store);
    const restored = restorePreparedEvidenceStore(snapshot);
    expect(restored.outcome).toBe("RESTORED");
    if (restored.outcome !== "RESTORED") throw new Error("snapshot restore failed");
    const restarted = new PreparedEvidenceCoordinator(flow.gateway, restored.store);
    expect((await restarted.readAccountSession(flow.account.accountSessionId, 1_002)).outcome).toBe(
      "APPLIED",
    );

    const forged = structuredClone(snapshot) as {
      presentations: Array<{ playback: { controlRevision: string } }>;
    };
    const presentation = forged.presentations[0];
    if (presentation === undefined) throw new Error("snapshot fixture missing presentation");
    presentation.playback.controlRevision = "cr_9007199254740992";
    expect(restorePreparedEvidenceStore(forged)).toEqual({ outcome: "INVALID_SNAPSHOT" });

    const mismatchedCandidateHash = structuredClone(snapshot) as {
      presentations: Array<{
        candidates: Array<{ lifecycle: { contentHash: string } }>;
      }>;
    };
    const hashCandidate = mismatchedCandidateHash.presentations[0]?.candidates[0];
    if (hashCandidate === undefined) throw new Error("candidate snapshot fixture missing");
    hashCandidate.lifecycle.contentHash = "c".repeat(64);
    expect(restorePreparedEvidenceStore(mismatchedCandidateHash)).toEqual({
      outcome: "INVALID_SNAPSHOT",
    });

    const mismatchedCandidateVersion = structuredClone(snapshot) as {
      presentations: Array<{
        candidates: Array<{ lifecycle: { candidateVersion: string } }>;
      }>;
    };
    const versionCandidate = mismatchedCandidateVersion.presentations[0]?.candidates[0];
    if (versionCandidate === undefined) throw new Error("candidate snapshot fixture missing");
    versionCandidate.lifecycle.candidateVersion = "candidate-version-forged";
    expect(restorePreparedEvidenceStore(mismatchedCandidateVersion)).toEqual({
      outcome: "INVALID_SNAPSHOT",
    });
  });

  test("reads and discards legacy card revisions and published candidate lifecycle on restore", async () => {
    const flow = await createBoundFlow();
    const candidate = {
      candidateId: "candidate_legacy_published",
      candidateVersion: "candidate-version-legacy",
      provenance: "CURATED_PREAPPROVED",
      verdict: "SUPPORTED",
      claimText: "Legacy public claim",
      evidenceExcerpt: "Legacy public support",
      privateSourceUri: "private://source/legacy",
      causal: {
        presentationSessionId: flow.created.lifecycle.presentationSessionId,
        presentationSessionEpoch: "pse_1",
        displayBindingEpoch: "dbe_1",
        deckVersion: publicDeck.deckVersion,
        manifestHash,
        occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
        transcriptFinalId: null,
        source: {
          sourceId: "source_legacy",
          revision: "source-revision-legacy",
          contentHash: sourceHash,
        },
        decisions: {
          acl: "acl-1",
          publicationPolicy: "publication-policy-1",
          rights: "rights-1",
          dlp: "dlp-1",
        },
      },
    } as const;
    expect(
      (await flow.coordinator.addCuratedCandidate(flow.account.accountSessionId, candidate, 1_002))
        .outcome,
    ).toBe("APPLIED");
    const presentation = flow.store.presentations.get(flow.created.lifecycle.presentationSessionId);
    const record = presentation?.candidates.get(candidate.candidateId);
    if (presentation === undefined || record === undefined) {
      throw new Error("legacy snapshot fixture is incomplete");
    }
    const legacyCard = {
      projectionId: "projection_legacy_published",
      status: "PUBLISHED",
      claim: candidate.claimText,
      supportSummary: candidate.evidenceExcerpt,
      sourceLabel: "Legacy source",
      publishedAtMs: 1_003,
      expiresAtMs: null,
      publicCardRevision: "pcr_1",
      deckVersion: publicDeck.deckVersion,
      manifestHash,
      occurrence: candidate.causal.occurrence,
    } as const;
    const cardResult = applyAuthorizedPublicCardEvent(
      presentation.cards,
      record.lifecycle,
      {
        presentationSessionId: flow.created.lifecycle.presentationSessionId,
        presentationSessionEpoch: "pse_1",
        authorityId: flow.created.authority.authorityId,
        expectedRevision: "pcr_0",
        payload: legacyCard,
      },
      1_003,
    );
    const lifecycleResult = reduceCandidateLifecycle(record.lifecycle, {
      type: "PUBLISH",
      presentationSessionId: flow.created.lifecycle.presentationSessionId,
      presentationSessionEpoch: "pse_1",
      candidateId: candidate.candidateId,
      candidateVersion: candidate.candidateVersion,
      expectedRevision: "candrev_1",
      projectionId: legacyCard.projectionId,
      publicCardRevision: "pcr_1",
    });
    if (cardResult.outcome !== "APPLIED" || lifecycleResult.outcome !== "APPLIED") {
      throw new Error("legacy publication fixture failed");
    }
    presentation.cards = cardResult.state;
    record.lifecycle = lifecycleResult.state;

    const restored = restorePreparedEvidenceStore(snapshotPreparedEvidenceStore(flow.store));
    expect(restored.outcome).toBe("RESTORED");
    if (restored.outcome !== "RESTORED") throw new Error("legacy restore failed");
    const normalized = JSON.stringify(snapshotPreparedEvidenceStore(restored.store));
    expect(normalized).not.toContain(legacyCard.projectionId);
    expect(normalized).toContain('"publicCardRevision":"pcr_0"');
    expect(normalized).toContain('"publicationState":"PRIVATE"');
    expect(normalized).not.toContain('"publicationState":"PUBLISHED"');
  });

  test("accepts absolute slide.set and records only the ordered Stage prefix after restart", async () => {
    const flow = await createBoundFlow();
    const playbackEvents: string[] = [];
    flow.gateway.connectStage(
      flow.bound.audienceDisplaySessionId,
      {
        onPlayback: (event) => playbackEvents.push(event.commandId),
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

  test("keeps curated evidence private without mutating its lifecycle or card revision", async () => {
    const flow = await createBoundFlow();
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
    } as const;
    expect(
      (await flow.coordinator.addCuratedCandidate(flow.account.accountSessionId, candidate, 1_002))
        .outcome,
    ).toBe("APPLIED");
    const before = JSON.stringify(snapshotPreparedEvidenceStore(flow.store));

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
        1_003,
      ),
    ).toEqual({ outcome: "REJECTED", reason: "PUBLICATION_DISABLED" });
    expect(JSON.stringify(snapshotPreparedEvidenceStore(flow.store))).toBe(before);
    expect(flow.gateway.snapshot(flow.bound.audienceDisplaySessionId, 1_004)?.cards).toEqual([]);
  });

  test("denies live publication when ACL is revoked immediately before projection", async () => {
    let authorizationChecks = 0;
    const flow = await createBoundFlow(1_000, {
      async authorize() {
        authorizationChecks += 1;
        return authorizationChecks < 3;
      },
    });
    const candidate = {
      candidateId: "candidate_live_revoked",
      candidateVersion: "candidate-version-1",
      provenance: "LIVE_VERIFIED",
      verdict: "SUPPORTED",
      claimText: "Live claim",
      evidenceExcerpt: "Live support",
      privateSourceUri: "private://source/live",
      causal: {
        presentationSessionId: flow.created.lifecycle.presentationSessionId,
        presentationSessionEpoch: "pse_1",
        displayBindingEpoch: "dbe_1",
        deckVersion: publicDeck.deckVersion,
        manifestHash,
        occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
        transcriptFinalId: "transcript_live_one",
        source: { sourceId: "source_live", revision: "source-revision-1", contentHash: sourceHash },
        decisions: {
          acl: "acl-1",
          publicationPolicy: "publication-policy-1",
          rights: "rights-1",
          dlp: "dlp-1",
        },
      },
    };
    expect(
      (await flow.coordinator.addLiveCandidate(flow.account.accountSessionId, candidate, 1_002))
        .outcome,
    ).toBe("APPLIED");
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
        1_003,
      ),
    ).toEqual({ outcome: "REJECTED", reason: "PUBLICATION_DISABLED" });
    expect(authorizationChecks).toBe(1);
    expect(flow.gateway.snapshot(flow.bound.audienceDisplaySessionId, 1_004)?.cards).toEqual([]);
  });

  test("rejects conflicting concurrent reuse of one approval id", async () => {
    const flow = await createBoundFlow(
      1_000,
      {
        async authorize() {
          return true;
        },
      },
      true,
    );
    const candidate = {
      candidateId: "candidate_live_idempotency",
      candidateVersion: "candidate-version-1",
      provenance: "LIVE_VERIFIED",
      verdict: "SUPPORTED",
      claimText: "Idempotent live claim",
      evidenceExcerpt: "Authoritative support",
      privateSourceUri: "private://source/idempotency",
      causal: {
        presentationSessionId: flow.created.lifecycle.presentationSessionId,
        presentationSessionEpoch: "pse_1",
        displayBindingEpoch: "dbe_1",
        deckVersion: publicDeck.deckVersion,
        manifestHash,
        occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
        transcriptFinalId: "transcript_idempotency",
        source: {
          sourceId: "source_idempotency",
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
    } as const;
    expect(
      (await flow.coordinator.addLiveCandidate(flow.account.accountSessionId, candidate, 1_002))
        .outcome,
    ).toBe("APPLIED");
    const snapshot = await flow.coordinator.readLiveCandidateSnapshot(
      flow.account.accountSessionId,
      flow.created.lifecycle.presentationSessionId,
      1_003,
    );
    if (snapshot.outcome !== "APPLIED") throw new Error("snapshot failed");
    const approval = {
      presentationSessionId: flow.created.lifecycle.presentationSessionId,
      candidateId: candidate.candidateId,
      candidateVersion: candidate.candidateVersion,
      expectedCandidateRevision: "candrev_1",
      expectedPublicCardRevision: "pcr_0",
      authorityId: flow.created.authority.authorityId,
      approvalId: "approval_conflicting_reuse",
      authoritativeSnapshotHash: snapshot.value.authoritativeSnapshotHash,
      expiresAtMs: null,
    } as const;
    const results = await Promise.all([
      flow.coordinator.approveCandidate(flow.account.accountSessionId, approval, 1_004),
      flow.coordinator.approveCandidate(
        flow.account.accountSessionId,
        { ...approval, candidateId: "candidate_wrong_request" },
        1_004,
      ),
    ]);
    expect(results).toEqual([
      { outcome: "REJECTED", reason: "PUBLICATION_DISABLED" },
      { outcome: "REJECTED", reason: "PUBLICATION_DISABLED" },
    ]);
  });

  test("rejects approval and termination before projection", async () => {
    const flow = await createBoundFlow();
    expect(
      await flow.coordinator.approveCandidate(
        flow.account.accountSessionId,
        {
          presentationSessionId: flow.created.lifecycle.presentationSessionId,
          candidateId: "candidate_missing",
          expectedCandidateRevision: "candrev_0",
          expectedPublicCardRevision: "pcr_0",
          authorityId: flow.created.authority.authorityId,
          expiresAtMs: null,
        },
        1_003,
      ),
    ).toEqual({ outcome: "REJECTED", reason: "PUBLICATION_DISABLED" });
    expect(
      await flow.coordinator.terminateCard(
        flow.account.accountSessionId,
        {
          presentationSessionId: flow.created.lifecycle.presentationSessionId,
          projectionId: "projection_missing",
          expectedPublicCardRevision: "pcr_0",
          authorityId: flow.created.authority.authorityId,
          operationId: "termination_disabled",
          status: "RETRACTED",
        },
        1_004,
      ),
    ).toEqual({ outcome: "REJECTED", reason: "PUBLICATION_DISABLED" });
    expect(flow.gateway.snapshot(flow.bound.audienceDisplaySessionId, 1_005)?.cards).toEqual([]);
  });

  test("rejects concurrent supervised live approvals without an idempotency winner", async () => {
    const flow = await createBoundFlow(
      1_000,
      {
        async authorize() {
          return true;
        },
      },
      true,
    );
    const input = {
      presentationSessionId: flow.created.lifecycle.presentationSessionId,
      candidateId: "candidate_live_disabled",
      candidateVersion: "candidate-version-1",
      expectedCandidateRevision: "candrev_1",
      expectedPublicCardRevision: "pcr_0",
      authorityId: flow.created.authority.authorityId,
      approvalId: "approval_disabled",
      authoritativeSnapshotHash: "f".repeat(64),
      expiresAtMs: null,
    } as const;
    const approvals = await Promise.all([
      flow.coordinator.approveCandidate(flow.account.accountSessionId, input, 1_004),
      flow.coordinator.approveCandidate(
        flow.account.accountSessionId,
        { ...input, approvalId: "approval_disabled_two" },
        1_004,
      ),
    ]);
    expect(approvals).toEqual([
      { outcome: "REJECTED", reason: "PUBLICATION_DISABLED" },
      { outcome: "REJECTED", reason: "PUBLICATION_DISABLED" },
    ]);
    expect(flow.gateway.snapshot(flow.bound.audienceDisplaySessionId, 1_005)?.cards).toEqual([]);
  });

  test("keeps verified live evidence private when the safety gate is fail-closed", async () => {
    const flow = await createBoundFlow(1_000, {
      async authorize() {
        return true;
      },
    });
    const candidate = {
      candidateId: "candidate_live_fail_closed",
      candidateVersion: "candidate-version-1",
      provenance: "LIVE_VERIFIED",
      verdict: "SUPPORTED",
      claimText: "Private recommendation",
      evidenceExcerpt: "Verified but not public",
      privateSourceUri: "private://source/fail-closed",
      causal: {
        presentationSessionId: flow.created.lifecycle.presentationSessionId,
        presentationSessionEpoch: "pse_1",
        displayBindingEpoch: "dbe_1",
        deckVersion: publicDeck.deckVersion,
        manifestHash,
        occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
        transcriptFinalId: "transcript_fail_closed",
        source: {
          sourceId: "source_fail_closed",
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
    } as const;
    expect(
      (await flow.coordinator.addLiveCandidate(flow.account.accountSessionId, candidate, 1_002))
        .outcome,
    ).toBe("APPLIED");
    const snapshot = await flow.coordinator.readLiveCandidateSnapshot(
      flow.account.accountSessionId,
      flow.created.lifecycle.presentationSessionId,
      1_003,
    );
    if (snapshot.outcome !== "APPLIED") throw new Error("snapshot failed");
    expect(snapshot.value).toMatchObject({
      livePublicEnabled: false,
      candidates: [{ candidateId: candidate.candidateId }],
    });
    expect(
      await flow.coordinator.approveCandidate(
        flow.account.accountSessionId,
        {
          presentationSessionId: flow.created.lifecycle.presentationSessionId,
          candidateId: candidate.candidateId,
          candidateVersion: candidate.candidateVersion,
          expectedCandidateRevision: "candrev_1",
          expectedPublicCardRevision: "pcr_0",
          authorityId: flow.created.authority.authorityId,
          approvalId: "approval_disabled",
          authoritativeSnapshotHash: snapshot.value.authoritativeSnapshotHash,
          expiresAtMs: null,
        },
        1_004,
      ),
    ).toEqual({ outcome: "REJECTED", reason: "PUBLICATION_DISABLED" });
    const join = flow.gateway.createDisplayJoin(
      {
        displayId: "display_fail_closed_rebind",
        deckVersion: publicDeck.deckVersion,
        displayFingerprint: "fingerprint-fail-closed-rebind",
      },
      1_005,
    );
    expect(
      (
        await flow.coordinator.approveDisplay(
          flow.account.accountSessionId,
          {
            presentationSessionId: flow.created.lifecycle.presentationSessionId,
            displayJoinId: join.displayJoinId,
            expectedDisplayBindingEpoch: "dbe_1",
            expectedDeckVersion: publicDeck.deckVersion,
            approvedDisplayId: join.displayId,
            approvedDisplayFingerprint: join.displayFingerprint,
          },
          1_005,
        )
      ).outcome,
    ).toBe("APPLIED");
    expect(
      await flow.coordinator.readLiveCandidateSnapshot(
        flow.account.accountSessionId,
        flow.created.lifecycle.presentationSessionId,
        1_006,
      ),
    ).toMatchObject({ outcome: "APPLIED", value: { candidates: [] } });
    expect(
      await flow.coordinator.approveCandidate(
        flow.account.accountSessionId,
        {
          presentationSessionId: flow.created.lifecycle.presentationSessionId,
          candidateId: candidate.candidateId,
          candidateVersion: candidate.candidateVersion,
          expectedCandidateRevision: "candrev_1",
          expectedPublicCardRevision: "pcr_0",
          authorityId: flow.created.authority.authorityId,
          approvalId: "approval_stale_rebind",
          authoritativeSnapshotHash: snapshot.value.authoritativeSnapshotHash,
          expiresAtMs: null,
        },
        1_006,
      ),
    ).toEqual({ outcome: "REJECTED", reason: "PUBLICATION_DISABLED" });
    expect(flow.gateway.snapshot(flow.bound.audienceDisplaySessionId, 1_007)).toBeNull();
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
      (await flow.coordinator.addCuratedCandidate(flow.account.accountSessionId, candidate, 1_002))
        .outcome,
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
    ).toEqual({ outcome: "REJECTED", reason: "PUBLICATION_DISABLED" });
  });
});
