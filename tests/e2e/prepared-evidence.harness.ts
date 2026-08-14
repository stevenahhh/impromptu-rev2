import { createHash } from "node:crypto";
import {
  createPreparedEvidenceStore,
  PreparedEvidenceCoordinator,
} from "@impromptu/private-backend";
import { PreparedEvidenceProjectionGateway } from "@impromptu/projection-gateway";

export interface PreparedEvidenceEvidence {
  readonly milestones: readonly string[];
  readonly acceptedCommandIds: readonly string[];
  readonly appliedCommandIds: readonly string[];
  readonly cardEvents: readonly string[];
  readonly connectedTombstoneLatencyMs: number;
  readonly reconnectActiveCardCount: number;
  readonly reconnectTombstoneStatuses: readonly string[];
  readonly browserStorageEntries: number;
}

class ExactSignal<Value> {
  readonly #promise: Promise<Value>;
  #resolve: ((value: Value) => void) | null = null;

  constructor(label: string, timeoutMs = 2_000) {
    const timeout = AbortSignal.timeout(timeoutMs);
    this.#promise = new Promise<Value>((resolve, reject) => {
      this.#resolve = resolve;
      timeout.addEventListener(
        "abort",
        () => reject(new Error(`${label} was not observed within ${timeoutMs}ms`)),
        { once: true },
      );
    });
  }

  emit(value: Value): void {
    const resolve = this.#resolve;
    if (resolve === null) throw new Error("exact signal emitted more than once");
    this.#resolve = null;
    resolve(value);
  }

  wait(): Promise<Value> {
    return this.#promise;
  }
}

function artifactsFromUpload(ownerAccountId: string, bytes: Uint8Array) {
  const sourceHash = createHash("sha256").update(bytes).digest("hex");
  const manifestHash = createHash("sha256").update(`prepared-manifest:${sourceHash}`).digest("hex");
  const imageHash = createHash("sha256").update(`public-slide:${sourceHash}`).digest("hex");
  return {
    sourceHash,
    privateDeck: {
      deckId: `private_deck_${sourceHash}`,
      deckVersion: `deck_${sourceHash}`,
      manifestHash,
      title: "Prepared evidence E2E",
      ownerAccountId,
      aclPolicyVersion: "acl-1",
      privateObjectPrefix: `private-decks/${ownerAccountId}/${sourceHash}`,
      slides: [
        {
          privateSlideId: `private_slide_${sourceHash}`,
          publicSlideKey: `slide_${sourceHash}`,
          ordinal: 1,
          speakerNotes: "private presenter note",
          extractedText: "Prepared evidence",
          sourceAssetIds: [`asset_${sourceHash}`],
        },
      ],
    },
    publicDeck: {
      deckVersion: `deck_${sourceHash}`,
      manifestHash,
      title: "Prepared evidence E2E",
      slides: [
        {
          publicSlideKey: `slide_${sourceHash}`,
          ordinal: 1,
          image: {
            url: `https://public.example.test/slides/${imageHash}.png`,
            contentHash: imageHash,
            width: 1920,
            height: 1080,
          },
          accessibilityLabel: "Prepared evidence slide",
        },
      ],
    },
  };
}

function requireApplied<Value>(
  result:
    | Readonly<{ outcome: "APPLIED"; value: Value }>
    | Readonly<{ outcome: "REJECTED"; reason: string }>,
  label: string,
): Value {
  if (result.outcome !== "APPLIED") throw new Error(`${label}: ${result.reason}`);
  return result.value;
}

function candidate(
  id: string,
  presentationSessionId: string,
  deckVersion: string,
  manifestHash: string,
  publicSlideKey: string,
  sourceHash: string,
) {
  return {
    candidateId: id,
    candidateVersion: "candidate-version-1",
    provenance: "CURATED_PREAPPROVED",
    verdict: "SUPPORTED",
    claimText: `Prepared claim ${id}`,
    evidenceExcerpt: "Prepared support with approved rights.",
    privateSourceUri: `private://curated/${id}`,
    causal: {
      presentationSessionId,
      presentationSessionEpoch: "pse_1",
      displayBindingEpoch: "dbe_1",
      deckVersion,
      manifestHash,
      occurrence: { publicSlideKey, occurrenceSeq: 1 },
      transcriptFinalId: null,
      source: { sourceId: `source_${id}`, revision: "source-revision-1", contentHash: sourceHash },
      decisions: {
        acl: "acl-1",
        publicationPolicy: "publication-policy-1",
        rights: "rights-1",
        dlp: "dlp-1",
      },
    },
  };
}

export async function runPreparedEvidenceE2E(): Promise<PreparedEvidenceEvidence> {
  const milestones: string[] = [];
  const upload = new TextEncoder().encode("clean prepared deck upload");
  milestones.push("upload");
  const artifacts = artifactsFromUpload("account_e2e", upload);
  milestones.push("deck-artifacts");

  const gateway = new PreparedEvidenceProjectionGateway(undefined, {
    tombstoneRetentionMs: 60_000,
  });
  const store = createPreparedEvidenceStore();
  let coordinator = new PreparedEvidenceCoordinator(gateway, store);
  const account = coordinator.createAccountSession(
    { accountId: "account_e2e", actorId: "actor_e2e" },
    1_000,
  );
  milestones.push("authenticated-controller");
  const created = requireApplied(
    coordinator.createPresentation(account.accountSessionId, artifacts, 1_001),
    "presentation create",
  );
  milestones.push("presentation-session");

  const cleanStageProfile = {
    storage: new Map<string, string>(),
    displayId: "display_clean_profile",
    displayFingerprint: "clean-stage-profile-fingerprint",
  };
  const join = gateway.createDisplayJoin(
    {
      displayId: cleanStageProfile.displayId,
      deckVersion: artifacts.publicDeck.deckVersion,
      displayFingerprint: cleanStageProfile.displayFingerprint,
    },
    1_002,
  );
  milestones.push("display-join");
  const bound = requireApplied(
    await coordinator.approveDisplay(
      account.accountSessionId,
      {
        presentationSessionId: created.lifecycle.presentationSessionId,
        displayJoinId: join.displayJoinId,
        expectedDisplayBindingEpoch: "dbe_0",
        expectedDeckVersion: artifacts.publicDeck.deckVersion,
        approvedDisplayId: cleanStageProfile.displayId,
        approvedDisplayFingerprint: cleanStageProfile.displayFingerprint,
      },
      1_003,
    ),
    "display bind",
  );
  const displaySession = gateway.claimDisplaySession(
    {
      displayJoinId: join.displayJoinId,
      displayId: cleanStageProfile.displayId,
      displayFingerprint: cleanStageProfile.displayFingerprint,
    },
    1_004,
  );
  if (displaySession === null) throw new Error("Stage could not claim approved binding");
  milestones.push("display-bound");

  coordinator = new PreparedEvidenceCoordinator(gateway, store);
  milestones.push("authority-restarted");
  const acceptedCommandIds: string[] = [];
  const appliedCommandIds: string[] = [];
  const cardEvents: string[] = [];
  const playbackSignal = new ExactSignal<string>("ordered Stage applied prefix");
  const publishedSignal = new ExactSignal<string>("published card visibility");
  let publishedObserved = false;
  let tombstoneSignal = new ExactSignal<string>("connected retract tombstone");
  const socket = gateway.connectStage(
    displaySession.audienceDisplaySessionId,
    {
      onPlayback: async (event) => {
        const receipt = requireApplied(
          await coordinator.recordStageApplied({
            audienceDisplaySessionId: displaySession.audienceDisplaySessionId,
            commandId: event.commandId,
            displayBindingEpoch: event.displayBindingEpoch,
          }),
          "Stage applied receipt",
        );
        appliedCommandIds.push(receipt.commandId);
        playbackSignal.emit(receipt.commandId);
      },
      onCard: (event) => {
        cardEvents.push(`${event.publicCardRevision}:${event.status}`);
        if (event.status === "PUBLISHED" && !publishedObserved) {
          publishedObserved = true;
          publishedSignal.emit(event.projectionId);
        } else if (event.status !== "PUBLISHED") {
          tombstoneSignal.emit(event.status);
        }
      },
      onClose: () => undefined,
    },
    1_005,
  );
  if (socket === null) throw new Error("Stage socket did not connect");

  const accepted = requireApplied(
    await coordinator.setSlide(
      account.accountSessionId,
      {
        presentationSessionId: created.lifecycle.presentationSessionId,
        commandId: "cmd_e2e_absolute",
        publicSlideKey: artifacts.publicDeck.slides[0]?.publicSlideKey ?? "",
        displayBindingEpoch: "dbe_1",
        baseRevision: "cr_0",
      },
      1_006,
    ),
    "absolute slide.set",
  );
  acceptedCommandIds.push(accepted.commandId);
  await playbackSignal.wait();
  milestones.push("slide-set-accepted", "stage-applied");

  const curated = candidate(
    "candidate_e2e_retract",
    created.lifecycle.presentationSessionId,
    artifacts.publicDeck.deckVersion,
    artifacts.publicDeck.manifestHash,
    artifacts.publicDeck.slides[0]?.publicSlideKey ?? "",
    artifacts.sourceHash,
  );
  requireApplied(
    coordinator.addCuratedCandidate(account.accountSessionId, curated, 1_007),
    "curated candidate",
  );
  const published = requireApplied(
    await coordinator.approveCandidate(
      account.accountSessionId,
      {
        presentationSessionId: created.lifecycle.presentationSessionId,
        candidateId: curated.candidateId,
        expectedCandidateRevision: "candrev_1",
        expectedPublicCardRevision: "pcr_0",
        authorityId: created.authority.authorityId,
        expiresAtMs: null,
      },
      1_008,
    ),
    "candidate approval",
  );
  await publishedSignal.wait();
  const visible = gateway.snapshot(bound.audienceDisplaySessionId, 1_009);
  if (visible?.cards[0]?.projectionId !== published.projectionId) {
    throw new Error("published card was not visible on Stage");
  }
  if (published.projectionId.includes(curated.candidateId)) {
    throw new Error("public projection ID correlates to private candidate ID");
  }
  milestones.push("candidate-approved", "published-card-visible");

  const retractStartedAt = performance.now();
  requireApplied(
    await coordinator.terminateCard(
      account.accountSessionId,
      {
        presentationSessionId: created.lifecycle.presentationSessionId,
        projectionId: published.projectionId,
        expectedPublicCardRevision: "pcr_1",
        authorityId: created.authority.authorityId,
        status: "RETRACTED",
      },
      1_010,
    ),
    "publication retract",
  );
  await tombstoneSignal.wait();
  const connectedTombstoneLatencyMs = performance.now() - retractStartedAt;
  milestones.push("ordered-retract-tombstone");

  const expiring = candidate(
    "candidate_e2e_expire",
    created.lifecycle.presentationSessionId,
    artifacts.publicDeck.deckVersion,
    artifacts.publicDeck.manifestHash,
    artifacts.publicDeck.slides[0]?.publicSlideKey ?? "",
    artifacts.sourceHash,
  );
  requireApplied(
    coordinator.addCuratedCandidate(account.accountSessionId, expiring, 1_011),
    "expiring curated candidate",
  );
  const expirePublishedSignal = new ExactSignal<string>("expiring card publication");
  tombstoneSignal = new ExactSignal<string>("connected expiry tombstone");
  const secondSocket = gateway.connectStage(
    displaySession.audienceDisplaySessionId,
    {
      onPlayback: () => undefined,
      onCard: (event) => {
        if (event.status === "PUBLISHED") expirePublishedSignal.emit(event.projectionId);
      },
      onClose: () => undefined,
    },
    1_011,
  );
  if (secondSocket === null) throw new Error("second exact-event subscriber failed");
  const expiringPublished = requireApplied(
    await coordinator.approveCandidate(
      account.accountSessionId,
      {
        presentationSessionId: created.lifecycle.presentationSessionId,
        candidateId: expiring.candidateId,
        expectedCandidateRevision: "candrev_1",
        expectedPublicCardRevision: "pcr_2",
        authorityId: created.authority.authorityId,
        expiresAtMs: 1_013,
      },
      1_012,
    ),
    "expiring candidate approval",
  );
  await expirePublishedSignal.wait();
  requireApplied(
    await coordinator.terminateCard(
      account.accountSessionId,
      {
        presentationSessionId: created.lifecycle.presentationSessionId,
        projectionId: expiringPublished.projectionId,
        expectedPublicCardRevision: "pcr_3",
        authorityId: created.authority.authorityId,
        status: "EXPIRED",
      },
      1_013,
    ),
    "publication expiry",
  );
  await tombstoneSignal.wait();
  milestones.push("ordered-expiry-tombstone");

  socket.close();
  secondSocket.close();
  const reconnect = gateway.snapshot(displaySession.audienceDisplaySessionId, 1_014);
  if (reconnect === null) throw new Error("reconnect snapshot unavailable");
  milestones.push("reconnect-snapshot");
  return {
    milestones,
    acceptedCommandIds,
    appliedCommandIds,
    cardEvents,
    connectedTombstoneLatencyMs,
    reconnectActiveCardCount: reconnect.cards.length,
    reconnectTombstoneStatuses: reconnect.tombstones.map((event) => event.status),
    browserStorageEntries: cleanStageProfile.storage.size,
  };
}
