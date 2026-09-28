import {
  CommandIdSchema,
  ControlRevisionSchema,
  controllerEpoch,
  controlRevisionValue,
  PlaybackControlLeaseSchema,
  type StageAppliedReceipt,
  type SupersededCommandReceipt,
} from "@impromptu/contracts/control";
import {
  type AccountSession,
  AccountSessionSchema,
  CreateDisplayInvitationRequestSchema,
  type CreateDisplayInvitationResponse,
  DisplayApprovalSchema,
  DisplayInvitationIdSchema,
  type EvidenceCandidate,
  EvidenceCandidateSchema,
  PlaybackLeaseTakeoverSchema,
  type PresentationDetailResponse,
  type PresentationListResponse,
  PresentationRenameRequestSchema,
  type PresentationSessionLifecycle,
  PresentationSessionLifecycleSchema,
  type PresentationSummary,
  type PrivateDeckContext,
  PrivateDeckContextSchema,
  type PublicationAuthority,
  presentationSessionEpochValue,
} from "@impromptu/contracts/private";
import {
  type AudienceDisplaySession,
  AudienceDisplaySessionSchema,
  DisplayBindingEpochSchema,
  type DisplayInvitationPendingView,
  DisplayInvitationPendingViewSchema,
  DisplayInvitationViewSchema,
  displayBindingEpoch,
  IssuedDisplayInvitationSchema,
  type PublicationTombstone,
  PublicationTombstoneSchema,
  PublicSlideKeySchema,
  type PublishedAudienceCard,
  PublishedAudienceCardSchema,
  type PublishedDeckArtifact,
  PublishedDeckArtifactSchema,
} from "@impromptu/contracts/public";
import {
  type CandidateLifecycleState,
  createCandidateLifecycle,
  createPlaybackAuthorityState,
  createPublicCardStream,
  markStageApplied,
  type PlaybackAuthorityState,
  type PublicCardStreamState,
  reduceCandidateLifecycle,
  reducePlaybackCommand,
  replacePlaybackLease,
  restoreCandidateLifecycle,
  restorePlaybackAuthority,
  restorePublicCardStream,
  rotatePlaybackDisplayBinding,
  setPlaybackStageStatus,
} from "@impromptu/state";
import {
  type AccountSessionStore,
  createInMemoryAccountSessionStore,
} from "./account-session-store.ts";

type MaybePromise<Value> = Value | Promise<Value>;

export interface PreparedEvidenceProjectionPort {
  /**
   * Mints a one-use, <=90s, non-authorizing display invitation at the gateway. The returned
   * token is shown to the presenter once; the gateway persists only its digest.
   */
  issueDisplayInvitation(
    input: {
      readonly presentationSessionId: string;
      readonly deckVersion: string;
    },
    nowMs: number,
  ): MaybePromise<
    | Readonly<{ outcome: "ISSUED"; invitation: unknown }>
    | Readonly<{ outcome: "REJECTED"; reason: string }>
  >;
  /**
   * Reads the owner-facing invitation view (pending join identity, expiry, status). The
   * token and its digest must never appear in the value.
   */
  readDisplayInvitation(
    invitationId: string,
    nowMs: number,
  ): MaybePromise<
    | Readonly<{ outcome: "FOUND"; invitation: unknown }>
    | Readonly<{ outcome: "REJECTED"; reason: string }>
  >;
  bindDisplay(
    input: {
      readonly displayJoinId: string;
      readonly presentationSessionId: string;
      readonly presentationSessionEpoch: string;
      readonly publicationPolicyVersion: string;
      readonly expectedDisplayBindingEpoch: string;
      readonly expectedDeckVersion: string;
      readonly approvedDisplayId: string;
      readonly approvedDisplayFingerprint: string;
      readonly deck: PublishedDeckArtifact;
    },
    nowMs: number,
  ): MaybePromise<
    | Readonly<{ outcome: "BOUND"; session: unknown }>
    | Readonly<{ outcome: "REJECTED"; reason: string }>
  >;
  projectPlayback(
    presentationSessionId: string,
    event: {
      readonly commandId: string;
      readonly displayBindingEpoch: string;
      readonly acceptedControlRevision: string;
      readonly occurrence: { readonly publicSlideKey: string; readonly occurrenceSeq: number };
      readonly blackout: boolean;
    },
  ): MaybePromise<boolean>;
  recordPlaybackApplied(
    presentationSessionId: string,
    displayBindingEpoch: string,
    publicPlaybackRevision: string,
  ): MaybePromise<boolean>;
}

type CandidateRecord = {
  readonly candidate: EvidenceCandidate;
  lifecycle: CandidateLifecycleState;
};

type IdempotentPublicationRecord = Readonly<{
  requestHash: string;
  event: PublishedAudienceCard | PublicationTombstone;
}>;

type PresentationRecord = {
  lifecycle: PresentationSessionLifecycle;
  readonly privateDeck: PrivateDeckContext;
  readonly publicDeck: PublishedDeckArtifact;
  playback: PlaybackAuthorityState;
  cards: PublicCardStreamState;
  readonly candidates: Map<string, CandidateRecord>;
  readonly approvedPublicationActorIds: Set<string>;
  readonly publicationOperations: Map<string, IdempotentPublicationRecord>;
  audienceDisplaySession: AudienceDisplaySession | null;
};

export type CandidateApprovalInput = Readonly<{
  presentationSessionId: string;
  candidateId: string;
  candidateVersion?: string;
  expectedCandidateRevision: string;
  expectedPublicCardRevision: string;
  authorityId: string;
  approvalId?: string;
  authoritativeSnapshotHash?: string;
  expiresAtMs: number | null;
}>;

export type CardTerminationInput = Readonly<{
  presentationSessionId: string;
  projectionId: string;
  expectedPublicCardRevision: string;
  authorityId: string;
  operationId?: string;
  status: "RETRACTED" | "EXPIRED";
}>;

export type LiveCandidateSnapshot = Readonly<{
  authoritativeSnapshotHash: string;
  presentationSessionId: string;
  presentationSessionEpoch: string;
  publicationPolicyVersion: string;
  publicationAuthorityId: string;
  publicCardRevision: string;
  livePublicEnabled: boolean;
  candidates: readonly Readonly<{
    candidateId: string;
    candidateVersion: string;
    candidateRevision: string;
    claimText: string;
    evidenceExcerpt: string;
    occurrence: Readonly<{ publicSlideKey: string; occurrenceSeq: number }>;
  }>[];
}>;

export interface LiveEvidenceAuthorizer {
  authorize(candidate: EvidenceCandidate): Promise<boolean>;
}

export interface PreparedEvidenceReportObserver {
  onAcceptedSlideSet(input: {
    readonly tenantId: string;
    readonly presentationSessionId: string;
    readonly ownerSubject: string;
    readonly presentationSessionEpoch: number;
    readonly sequence: number;
    readonly publicSlideKey: string;
    readonly acceptedOffsetMs: number;
    readonly producerId: string;
  }): void;
  onFailure(error: unknown): void;
}

export interface PreparedEvidenceStore {
  readonly accountSessions: Map<string, AccountSession>;
  readonly presentations: Map<string, PresentationRecord>;
}

export function createPreparedEvidenceStore(): PreparedEvidenceStore {
  return { accountSessions: new Map(), presentations: new Map() };
}

export class PreparedEvidenceSnapshotError extends Error {
  readonly code = "INVALID_PREPARED_EVIDENCE_SNAPSHOT";

  constructor(message: string) {
    super(message);
    this.name = "PreparedEvidenceSnapshotError";
  }
}

export type PreparedEvidenceStoreRestoreResult =
  | Readonly<{ outcome: "RESTORED"; store: PreparedEvidenceStore }>
  | Readonly<{ outcome: "INVALID_SNAPSHOT" }>;

function snapshotRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
  );
}

export function snapshotPreparedEvidenceStore(store: PreparedEvidenceStore): unknown {
  return {
    stateKind: "PREPARED_EVIDENCE_COORDINATOR_SNAPSHOT",
    accountSessions: [...store.accountSessions.values()],
    presentations: [...store.presentations.values()].map((presentation) => ({
      lifecycle: presentation.lifecycle,
      privateDeck: presentation.privateDeck,
      publicDeck: presentation.publicDeck,
      playback: presentation.playback,
      cards: presentation.cards,
      candidates: [...presentation.candidates.values()],
      approvedPublicationActorIds: [...presentation.approvedPublicationActorIds].sort(),
      publicationOperations: [...presentation.publicationOperations.entries()].map(
        ([operationId, operation]) => ({ operationId, ...operation }),
      ),
      audienceDisplaySession: presentation.audienceDisplaySession,
    })),
  };
}

export function restorePreparedEvidenceStore(input: unknown): PreparedEvidenceStoreRestoreResult {
  if (
    !snapshotRecord(input) ||
    !hasExactKeys(input, ["stateKind", "accountSessions", "presentations"]) ||
    input.stateKind !== "PREPARED_EVIDENCE_COORDINATOR_SNAPSHOT" ||
    !Array.isArray(input.accountSessions) ||
    !Array.isArray(input.presentations)
  ) {
    return { outcome: "INVALID_SNAPSHOT" };
  }
  const store = createPreparedEvidenceStore();
  for (const accountInput of input.accountSessions) {
    const account = AccountSessionSchema.safeParse(accountInput);
    if (!account.success || store.accountSessions.has(account.data.accountSessionId)) {
      return { outcome: "INVALID_SNAPSHOT" };
    }
    store.accountSessions.set(account.data.accountSessionId, account.data);
  }
  for (const presentationInput of input.presentations) {
    if (
      !snapshotRecord(presentationInput) ||
      !hasExactKeys(presentationInput, [
        "lifecycle",
        "privateDeck",
        "publicDeck",
        "playback",
        "cards",
        "candidates",
        "approvedPublicationActorIds",
        "publicationOperations",
        "audienceDisplaySession",
      ]) ||
      !Array.isArray(presentationInput.candidates) ||
      !Array.isArray(presentationInput.approvedPublicationActorIds) ||
      !Array.isArray(presentationInput.publicationOperations)
    ) {
      return { outcome: "INVALID_SNAPSHOT" };
    }
    const lifecycle = PresentationSessionLifecycleSchema.safeParse(presentationInput.lifecycle);
    const privateDeck = PrivateDeckContextSchema.safeParse(presentationInput.privateDeck);
    const publicDeck = PublishedDeckArtifactSchema.safeParse(presentationInput.publicDeck);
    const playback = restorePlaybackAuthority(presentationInput.playback);
    const legacyCards = restorePublicCardStream(presentationInput.cards);
    const audienceDisplaySession =
      presentationInput.audienceDisplaySession === null
        ? { success: true as const, data: null }
        : AudienceDisplaySessionSchema.safeParse(presentationInput.audienceDisplaySession);
    if (
      !lifecycle.success ||
      !privateDeck.success ||
      !publicDeck.success ||
      playback.outcome !== "RESTORED" ||
      legacyCards.outcome !== "RESTORED" ||
      !audienceDisplaySession.success ||
      lifecycle.data.presentationSessionId !== playback.state.presentationSessionId ||
      lifecycle.data.presentationSessionId !== legacyCards.state.presentationSessionId ||
      lifecycle.data.presentationSessionEpoch !== playback.state.presentationSessionEpoch ||
      lifecycle.data.presentationSessionEpoch !== legacyCards.state.presentationSessionEpoch ||
      lifecycle.data.deckVersion !== publicDeck.data.deckVersion ||
      privateDeck.data.deckVersion !== publicDeck.data.deckVersion ||
      privateDeck.data.manifestHash !== publicDeck.data.manifestHash ||
      (audienceDisplaySession.data !== null &&
        (audienceDisplaySession.data.binding.presentationSessionId !==
          lifecycle.data.presentationSessionId ||
          audienceDisplaySession.data.binding.displayBindingEpoch !==
            playback.state.displayBindingEpoch)) ||
      store.presentations.has(lifecycle.data.presentationSessionId)
    ) {
      return { outcome: "INVALID_SNAPSHOT" };
    }
    const candidates = new Map<string, CandidateRecord>();
    for (const candidateInput of presentationInput.candidates) {
      if (
        !snapshotRecord(candidateInput) ||
        !hasExactKeys(candidateInput, ["candidate", "lifecycle"])
      ) {
        return { outcome: "INVALID_SNAPSHOT" };
      }
      const candidate = EvidenceCandidateSchema.safeParse(candidateInput.candidate);
      const candidateLifecycle = restoreCandidateLifecycle(candidateInput.lifecycle);
      if (
        !candidate.success ||
        candidateLifecycle.outcome !== "RESTORED" ||
        candidate.data.candidateId !== candidateLifecycle.state.candidateId ||
        candidate.data.candidateVersion !== candidateLifecycle.state.candidateVersion ||
        candidate.data.causal.source.contentHash !== candidateLifecycle.state.contentHash ||
        candidate.data.causal.presentationSessionId !== lifecycle.data.presentationSessionId ||
        candidates.has(candidate.data.candidateId)
      ) {
        return { outcome: "INVALID_SNAPSHOT" };
      }
      const privateLifecycle = discardLegacyCandidatePublication(candidateLifecycle.state);
      if (privateLifecycle === null) return { outcome: "INVALID_SNAPSHOT" };
      candidates.set(candidate.data.candidateId, {
        candidate: candidate.data,
        lifecycle: privateLifecycle,
      });
    }
    const approvedPublicationActorIds = new Set<string>();
    for (const actorId of presentationInput.approvedPublicationActorIds) {
      if (typeof actorId !== "string" || approvedPublicationActorIds.has(actorId)) {
        return { outcome: "INVALID_SNAPSHOT" };
      }
      approvedPublicationActorIds.add(actorId);
    }
    if (
      legacyCards.state.authority === null ||
      !approvedPublicationActorIds.has(legacyCards.state.authority.actorId)
    ) {
      return { outcome: "INVALID_SNAPSHOT" };
    }
    const cards = createPublicCardStream({
      presentationSessionId: lifecycle.data.presentationSessionId,
      presentationSessionEpoch: lifecycle.data.presentationSessionEpoch,
      authority: legacyCards.state.authority,
    });
    const publicationOperations = new Map<string, IdempotentPublicationRecord>();
    for (const operationInput of presentationInput.publicationOperations) {
      if (
        !snapshotRecord(operationInput) ||
        !hasExactKeys(operationInput, ["operationId", "requestHash", "event"]) ||
        typeof operationInput.operationId !== "string" ||
        typeof operationInput.requestHash !== "string" ||
        publicationOperations.has(operationInput.operationId)
      ) {
        return { outcome: "INVALID_SNAPSHOT" };
      }
      const published = PublishedAudienceCardSchema.safeParse(operationInput.event);
      const tombstone = PublicationTombstoneSchema.safeParse(operationInput.event);
      if (!published.success && !tombstone.success) return { outcome: "INVALID_SNAPSHOT" };
      const event = published.success ? published.data : tombstone.success ? tombstone.data : null;
      if (event === null) return { outcome: "INVALID_SNAPSHOT" };
      // Legacy publication operations are validated for snapshot compatibility, then discarded.
    }
    store.presentations.set(lifecycle.data.presentationSessionId, {
      lifecycle: lifecycle.data,
      privateDeck: privateDeck.data,
      publicDeck: publicDeck.data,
      playback: playback.state,
      cards,
      candidates,
      approvedPublicationActorIds,
      publicationOperations,
      audienceDisplaySession: audienceDisplaySession.data,
    });
  }
  return { outcome: "RESTORED", store };
}

export type SessionRejection =
  | "ACCOUNT_SESSION_UNKNOWN"
  | "ACCOUNT_SESSION_EXPIRED"
  | "ACCOUNT_SESSION_REVOKED"
  | "PRESENTATION_NOT_FOUND"
  | "PRESENTATION_ENDED"
  | "PRESENTATION_NOT_ENDED"
  | "UNAUTHORIZED";

export type OperationResult<Value> =
  | Readonly<{ outcome: "APPLIED"; value: Value }>
  | Readonly<{ outcome: "REJECTED"; reason: SessionRejection | string }>;

/**
 * endPresentation result. A retried end by the owner keeps the REJECTED/PRESENTATION_ENDED
 * shape but carries `endedBySameOwner: true`, letting an idempotent HTTP route tell
 * "your own earlier end succeeded" apart from `PRESENTATION_NOT_FOUND` or an ownerless
 * bare PRESENTATION_ENDED.
 */
export type EndPresentationResult =
  | OperationResult<PresentationSessionLifecycle>
  | Readonly<{ outcome: "REJECTED"; reason: "PRESENTATION_ENDED"; endedBySameOwner: true }>;

export type ControllerSocketCloseReason = "SUPERSEDED" | "CLIENT_CLOSED" | "PRESENTATION_DELETED";

export interface ControllerSocket {
  readonly closed: boolean;
  readonly closeReason: ControllerSocketCloseReason | null;
  close(): void;
}

type MutableControllerSocket = {
  closed: boolean;
  closeReason: ControllerSocketCloseReason | null;
  leaseId: string;
  onClose: (reason: ControllerSocketCloseReason) => void;
};

function opaqueHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requestHash(value: unknown): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
}

function sameOccurrence(
  left: Readonly<{ publicSlideKey: string; occurrenceSeq: number }>,
  right: Readonly<{ publicSlideKey: string; occurrenceSeq: number }>,
): boolean {
  return left.publicSlideKey === right.publicSlideKey && left.occurrenceSeq === right.occurrenceSeq;
}

function accountSessionRejection(
  session: AccountSession | null,
  nowMs: number,
): SessionRejection | null {
  if (session === null) return "ACCOUNT_SESSION_UNKNOWN";
  if (session.revokedAtMs !== null) return "ACCOUNT_SESSION_REVOKED";
  if (nowMs >= session.expiresAtMs) return "ACCOUNT_SESSION_EXPIRED";
  return null;
}

function discardLegacyCandidatePublication(
  state: CandidateLifecycleState,
): CandidateLifecycleState | null {
  if (state.publicationState === "PRIVATE") return state;
  let privateState = createCandidateLifecycle({
    presentationSessionId: state.presentationSessionId,
    presentationSessionEpoch: state.presentationSessionEpoch,
    candidateId: state.candidateId,
    candidateVersion: state.candidateVersion,
    contentHash: state.contentHash,
  });
  for (const operation of Object.values(state.eventsByRevision)) {
    if (operation.type === "PUBLISH") continue;
    const replayed = reduceCandidateLifecycle(privateState, operation);
    if (replayed.outcome !== "APPLIED") return null;
    privateState = replayed.state;
  }
  return privateState;
}

export class PreparedEvidenceCoordinator {
  readonly #store: PreparedEvidenceStore;
  readonly #projection: PreparedEvidenceProjectionPort;
  readonly #accountSessions: AccountSessionStore;
  readonly #accountSessionTtlMs: number;
  readonly #presentationCapabilityTtlMs: number;
  readonly #liveEvidenceAuthorizer: LiveEvidenceAuthorizer | undefined;
  readonly #livePublicEnabled: boolean;
  readonly #reportObserver: PreparedEvidenceReportObserver | undefined;
  readonly #controllerSockets = new Map<string, Set<MutableControllerSocket>>();

  constructor(
    projection: PreparedEvidenceProjectionPort,
    store: PreparedEvidenceStore = createPreparedEvidenceStore(),
    options: {
      readonly accountSessionTtlMs?: number;
      readonly accountSessionStore?: AccountSessionStore;
      readonly presentationCapabilityTtlMs?: number;
      readonly liveEvidenceAuthorizer?: LiveEvidenceAuthorizer;
      readonly livePublicEnabled?: boolean;
      readonly reportObserver?: PreparedEvidenceReportObserver;
    } = {},
  ) {
    this.#projection = projection;
    this.#store = store;
    this.#accountSessions =
      options.accountSessionStore ?? createInMemoryAccountSessionStore(store.accountSessions);
    this.#accountSessionTtlMs = options.accountSessionTtlMs ?? 8 * 60 * 60 * 1_000;
    this.#presentationCapabilityTtlMs = options.presentationCapabilityTtlMs ?? 4 * 60 * 60 * 1_000;
    this.#liveEvidenceAuthorizer = options.liveEvidenceAuthorizer;
    this.#livePublicEnabled = options.livePublicEnabled === true;
    this.#reportObserver = options.reportObserver;
    for (const [id, presentation] of store.presentations) {
      const playback = restorePlaybackAuthority(presentation.playback);
      const cards = restorePublicCardStream(presentation.cards);
      if (playback.outcome !== "RESTORED" || cards.outcome !== "RESTORED") {
        throw new Error(`invalid persisted presentation ${id}`);
      }
      presentation.playback = playback.state;
      presentation.cards = cards.state;
    }
  }

  async createAccountSession(
    verifiedIdentity: { readonly accountId: string; readonly actorId: string },
    nowMs: number,
  ): Promise<AccountSession> {
    const session = AccountSessionSchema.parse({
      accountSessionId: `account_session_${opaqueHex(24)}`,
      accountId: verifiedIdentity.accountId,
      actorId: verifiedIdentity.actorId,
      expiresAtMs: nowMs + this.#accountSessionTtlMs,
      revokedAtMs: null,
    });
    await this.#accountSessions.create(session, nowMs);
    return session;
  }

  async readAccountSession(
    accountSessionId: string,
    nowMs: number,
  ): Promise<OperationResult<AccountSession>> {
    const session = await this.#accountSessions.read(accountSessionId);
    const rejection = accountSessionRejection(session, nowMs);
    return rejection === null && session !== null
      ? { outcome: "APPLIED", value: session }
      : { outcome: "REJECTED", reason: rejection ?? "ACCOUNT_SESSION_UNKNOWN" };
  }

  async revokeAccountSession(
    accountSessionId: string,
    nowMs: number,
  ): Promise<OperationResult<null>> {
    const session = await this.#accountSessions.read(accountSessionId);
    const rejection = accountSessionRejection(session, nowMs);
    if (rejection !== null || session === null) {
      return { outcome: "REJECTED", reason: rejection ?? "ACCOUNT_SESSION_UNKNOWN" };
    }
    AccountSessionSchema.parse({ ...session, revokedAtMs: nowMs });
    await this.#accountSessions.revoke(accountSessionId, nowMs);
    return { outcome: "APPLIED", value: null };
  }

  async createPresentation(
    accountSessionId: string,
    input: { readonly privateDeck: unknown; readonly publicDeck: unknown },
    nowMs: number,
  ): Promise<
    OperationResult<{
      readonly lifecycle: PresentationSessionLifecycle;
      readonly lease: PlaybackAuthorityState["activeLease"];
      readonly authority: PublicationAuthority;
    }>
  > {
    const account = await this.readAccountSession(accountSessionId, nowMs);
    if (account.outcome === "REJECTED") return account;
    const privateDeck = PrivateDeckContextSchema.safeParse(input.privateDeck);
    const publicDeck = PublishedDeckArtifactSchema.safeParse(input.publicDeck);
    if (!privateDeck.success || !publicDeck.success) {
      return { outcome: "REJECTED", reason: "INVALID_DECK_ARTIFACTS" };
    }
    if (
      privateDeck.data.ownerAccountId !== account.value.accountId ||
      privateDeck.data.deckVersion !== publicDeck.data.deckVersion ||
      privateDeck.data.manifestHash !== publicDeck.data.manifestHash
    ) {
      return { outcome: "REJECTED", reason: "DECK_ARTIFACT_MISMATCH" };
    }

    const presentationSessionId = `ps_${opaqueHex(16)}`;
    const presentationSessionEpoch = "pse_1";
    const lifecycle = PresentationSessionLifecycleSchema.parse({
      presentationSessionId,
      presentationSessionEpoch,
      ownerAccountId: account.value.accountId,
      deckVersion: publicDeck.data.deckVersion,
      status: "ACTIVE",
      createdAtMs: nowMs,
      endedAtMs: null,
      qaStartedAtMs: null,
      // Additive library fields, set explicitly so the created row's updatedAtMs starts at
      // creation and its title falls back to the uploaded deck title until renamed.
      presentationTitle: null,
      updatedAtMs: nowMs,
    });
    const lease = PlaybackControlLeaseSchema.parse({
      leaseId: `lease_${opaqueHex(16)}`,
      presentationSessionId: lifecycle.presentationSessionId,
      presentationSessionEpoch: lifecycle.presentationSessionEpoch,
      actorId: account.value.actorId,
      controllerEpoch: controllerEpoch(1),
      expiresAtMs: nowMs + this.#presentationCapabilityTtlMs,
    });
    const authority: PublicationAuthority = {
      authorityId: `pubauth_${opaqueHex(16)}` as PublicationAuthority["authorityId"],
      presentationSessionId: lifecycle.presentationSessionId,
      presentationSessionEpoch: lifecycle.presentationSessionEpoch,
      actorId: account.value.actorId,
      policyVersion: "publication-policy-1",
      expiresAtMs: nowMs + this.#presentationCapabilityTtlMs,
    };
    const firstSlide = publicDeck.data.slides[0];
    if (firstSlide === undefined) throw new Error("published deck must contain a slide");
    const playback = createPlaybackAuthorityState({
      presentationSessionId: lifecycle.presentationSessionId,
      presentationSessionEpoch: lifecycle.presentationSessionEpoch,
      activeLease: lease,
      displayBindingEpoch: displayBindingEpoch(0),
      stageStatus: "UNBOUND",
      slideOrder: publicDeck.data.slides.map((slide) => slide.publicSlideKey),
      initialSlideKey: firstSlide.publicSlideKey,
    });
    const cards = createPublicCardStream({
      presentationSessionId: lifecycle.presentationSessionId,
      presentationSessionEpoch: lifecycle.presentationSessionEpoch,
      authority,
    });
    this.#store.presentations.set(lifecycle.presentationSessionId, {
      lifecycle,
      privateDeck: privateDeck.data,
      publicDeck: publicDeck.data,
      playback,
      cards,
      candidates: new Map(),
      approvedPublicationActorIds: new Set([account.value.actorId]),
      publicationOperations: new Map(),
      audienceDisplaySession: null,
    });
    return { outcome: "APPLIED", value: { lifecycle, lease, authority } };
  }

  async beginQuestions(
    accountSessionId: string,
    presentationSessionId: string,
    nowMs: number,
  ): Promise<OperationResult<PresentationSessionLifecycle>> {
    const account = await this.readAccountSession(accountSessionId, nowMs);
    if (account.outcome === "REJECTED") return account;
    const presentation = this.#store.presentations.get(presentationSessionId);
    if (presentation === undefined)
      return { outcome: "REJECTED", reason: "PRESENTATION_NOT_FOUND" };
    // Deliberate divergence from #authorizedPresentation, whose ACTIVE-only spine every
    // other operation shares unchanged: Q&A opens only AFTER the talk ends (post-talk rule),
    // so an in-progress talk gets its own typed rejection instead.
    if (presentation.lifecycle.status !== "ENDED")
      return { outcome: "REJECTED", reason: "PRESENTATION_NOT_ENDED" };
    if (presentation.lifecycle.ownerAccountId !== account.value.accountId)
      return { outcome: "REJECTED", reason: "UNAUTHORIZED" };
    const lifecycle = presentation.lifecycle;
    // Idempotent repeat while Q&A is open: return the ORIGINAL timestamp, write nothing.
    if (lifecycle.qaStartedAtMs !== null) return { outcome: "APPLIED", value: lifecycle };
    const opened = PresentationSessionLifecycleSchema.parse({
      ...lifecycle,
      qaStartedAtMs: nowMs,
      updatedAtMs: nowMs,
    });
    presentation.lifecycle = opened;
    return { outcome: "APPLIED", value: opened };
  }

  async endPresentation(
    accountSessionId: string,
    presentationSessionId: string,
    nowMs: number,
  ): Promise<EndPresentationResult> {
    // Mirrors #authorizedPresentation, but checks ownership BEFORE the ENDED status so a
    // retried end by the same owner stays distinguishable from "not yours" / "not found".
    const account = await this.readAccountSession(accountSessionId, nowMs);
    if (account.outcome === "REJECTED") return account;
    const presentation = this.#store.presentations.get(presentationSessionId);
    if (presentation === undefined)
      return { outcome: "REJECTED", reason: "PRESENTATION_NOT_FOUND" };
    const isOwner = presentation.lifecycle.ownerAccountId === account.value.accountId;
    if (presentation.lifecycle.status !== "ACTIVE") {
      return isOwner
        ? { outcome: "REJECTED", reason: "PRESENTATION_ENDED", endedBySameOwner: true }
        : { outcome: "REJECTED", reason: "PRESENTATION_ENDED" };
    }
    if (!isOwner) return { outcome: "REJECTED", reason: "UNAUTHORIZED" };
    presentation.lifecycle = PresentationSessionLifecycleSchema.parse({
      ...presentation.lifecycle,
      status: "ENDED",
      endedAtMs: nowMs,
      updatedAtMs: nowMs,
    });
    return { outcome: "APPLIED", value: presentation.lifecycle };
  }

  /**
   * Owner-scoped library read: the caller's presentations, most recently created first, with
   * the opaque cursor continuing strictly after the last returned row. A cursor this account
   * never received is rejected rather than silently restarted.
   */
  async listPresentations(
    accountSessionId: string,
    options: { readonly limit: number; readonly cursor?: string },
    nowMs: number,
  ): Promise<OperationResult<PresentationListResponse>> {
    const account = await this.readAccountSession(accountSessionId, nowMs);
    if (account.outcome === "REJECTED") return account;
    const owned = Array.from(this.#store.presentations.values())
      .filter((record) => record.lifecycle.ownerAccountId === account.value.accountId)
      .sort(
        (left, right) =>
          right.lifecycle.createdAtMs - left.lifecycle.createdAtMs ||
          right.lifecycle.presentationSessionId.localeCompare(left.lifecycle.presentationSessionId),
      );
    let startIndex = 0;
    if (options.cursor !== undefined) {
      const cursor = this.#presentationCursor(options.cursor);
      if (cursor === null) {
        return { outcome: "REJECTED", reason: "INVALID_CURSOR" };
      }
      const cursorIndex = owned.findIndex(
        (record) =>
          record.lifecycle.createdAtMs === cursor.createdAtMs &&
          record.lifecycle.presentationSessionId === cursor.presentationSessionId,
      );
      if (cursorIndex < 0) return { outcome: "REJECTED", reason: "INVALID_CURSOR" };
      startIndex = cursorIndex + 1;
    }
    const page = owned.slice(startIndex, startIndex + options.limit);
    const tail = owned[startIndex + page.length];
    return {
      outcome: "APPLIED",
      value: {
        presentations: page.map((record) => this.#presentationSummary(record)),
        nextCursor:
          tail === undefined || page.length === 0
            ? null
            : this.#encodePresentationCursor(page[page.length - 1] as PresentationRecord),
      },
    };
  }

  /**
   * Owner-scoped resume read: everything the Console needs to re-enter a deck it already
   * uploaded — the public deck plus the current playback authority state — and nothing else.
   * ENDED presentations resolve (their report is the meaningful re-entry), unlike
   * #authorizedPresentation which exists to gate ACTIVE-only mutations.
   */
  async readPresentation(
    accountSessionId: string,
    presentationSessionId: string,
    nowMs: number,
  ): Promise<OperationResult<PresentationDetailResponse>> {
    const owned = await this.#ownedPresentation(accountSessionId, presentationSessionId, nowMs);
    if (owned.outcome === "REJECTED") return owned;
    const record = owned.value;
    const { playback } = record;
    return {
      outcome: "APPLIED",
      value: {
        presentation: this.#presentationSummary(record),
        publicDeck: record.publicDeck,
        playback: {
          displayBindingEpoch: playback.displayBindingEpoch,
          controlRevision: playback.controlRevision,
          stageStatus: playback.stageStatus,
          occurrence: playback.occurrence,
          activeLease: {
            actorId: playback.activeLease.actorId,
            expiresAtMs: playback.activeLease.expiresAtMs,
          },
        },
      },
    };
  }

  /** Owner-scoped rename: the only mutable field of a library row. */
  async renamePresentation(
    accountSessionId: string,
    presentationSessionId: string,
    input: unknown,
    nowMs: number,
  ): Promise<OperationResult<PresentationSummary>> {
    const rename = PresentationRenameRequestSchema.safeParse(input);
    if (!rename.success) {
      return { outcome: "REJECTED", reason: "INVALID_PRESENTATION_TITLE" };
    }
    const owned = await this.#ownedPresentation(accountSessionId, presentationSessionId, nowMs);
    if (owned.outcome === "REJECTED") return owned;
    owned.value.lifecycle = PresentationSessionLifecycleSchema.parse({
      ...owned.value.lifecycle,
      presentationTitle: rename.data.title,
      updatedAtMs: nowMs,
    });
    return { outcome: "APPLIED", value: this.#presentationSummary(owned.value) };
  }

  /**
   * Owner-scoped delete: removes the whole presentation record — deck artifacts, playback
   * authority, evidence candidates, and the publication ledger — so a deleted deck can never
   * be listed, resumed, renamed, or have its report read again. Report-side routes resolve
   * ownership through this same map, so removal alone revokes every downstream read. Open
   * controller sockets are told why they died instead of being abandoned mid-command.
   */
  async deletePresentation(
    accountSessionId: string,
    presentationSessionId: string,
    nowMs: number,
  ): Promise<OperationResult<PresentationSummary>> {
    const owned = await this.#ownedPresentation(accountSessionId, presentationSessionId, nowMs);
    if (owned.outcome === "REJECTED") return owned;
    const summary = this.#presentationSummary(owned.value);
    for (const socket of [...(this.#controllerSockets.get(presentationSessionId) ?? [])]) {
      this.#closeControllerSocket(presentationSessionId, socket, "PRESENTATION_DELETED");
    }
    this.#controllerSockets.delete(presentationSessionId);
    this.#store.presentations.delete(presentationSessionId);
    return { outcome: "APPLIED", value: summary };
  }

  async approveDisplay(
    accountSessionId: string,
    input: unknown,
    nowMs: number,
  ): Promise<OperationResult<AudienceDisplaySession>> {
    const approval = DisplayApprovalSchema.safeParse(input);
    if (!approval.success) return { outcome: "REJECTED", reason: "INVALID_DISPLAY_APPROVAL" };
    const authorized = await this.#authorizedPresentation(
      accountSessionId,
      approval.data.presentationSessionId,
      nowMs,
    );
    if (authorized.outcome === "REJECTED") return authorized;
    if (approval.data.expectedDeckVersion !== authorized.value.publicDeck.deckVersion) {
      return { outcome: "REJECTED", reason: "WRONG_DECK" };
    }
    // The display-binding CAS is decided by private authority before any public side
    // effect: a stale expected epoch fails closed here instead of round-tripping to the
    // gateway. GAP-11: the client must echo the epoch from the pending read, not "dbe_0".
    if (
      approval.data.expectedDisplayBindingEpoch !== authorized.value.playback.displayBindingEpoch
    ) {
      return { outcome: "REJECTED", reason: "STALE_DISPLAY_BINDING" };
    }
    const result = await this.#projection.bindDisplay(
      {
        displayJoinId: approval.data.displayJoinId,
        presentationSessionId: authorized.value.lifecycle.presentationSessionId,
        presentationSessionEpoch: authorized.value.lifecycle.presentationSessionEpoch,
        publicationPolicyVersion: authorized.value.cards.authority?.policyVersion ?? "unavailable",
        expectedDisplayBindingEpoch: approval.data.expectedDisplayBindingEpoch,
        expectedDeckVersion: approval.data.expectedDeckVersion,
        approvedDisplayId: approval.data.approvedDisplayId,
        approvedDisplayFingerprint: approval.data.approvedDisplayFingerprint,
        deck: authorized.value.publicDeck,
      },
      nowMs,
    );
    if (result.outcome === "REJECTED") return result;
    const session = AudienceDisplaySessionSchema.safeParse(result.session);
    if (!session.success) return { outcome: "REJECTED", reason: "INVALID_PROJECTION_RESPONSE" };
    authorized.value.audienceDisplaySession = session.data;
    authorized.value.playback = setPlaybackStageStatus(
      rotatePlaybackDisplayBinding(
        authorized.value.playback,
        session.data.binding.displayBindingEpoch,
      ),
      "READY",
    );
    this.#touch(authorized.value, nowMs);
    return { outcome: "APPLIED", value: session.data };
  }

  /**
   * Issues a short-lived, non-authorizing Stage invitation for a presentation the caller
   * owns. The gateway mints the token; this boundary only ever returns the minted DTO —
   * no session, cookie, or binding material travels with it.
   */
  async issueDisplayInvitation(
    accountSessionId: string,
    input: unknown,
    nowMs: number,
  ): Promise<OperationResult<CreateDisplayInvitationResponse>> {
    const request = CreateDisplayInvitationRequestSchema.safeParse(input);
    if (!request.success) {
      return { outcome: "REJECTED", reason: "INVALID_DISPLAY_INVITATION" };
    }
    const authorized = await this.#authorizedPresentation(
      accountSessionId,
      request.data.presentationSessionId,
      nowMs,
    );
    if (authorized.outcome === "REJECTED") return authorized;
    const issued = await this.#projection.issueDisplayInvitation(
      {
        presentationSessionId: authorized.value.lifecycle.presentationSessionId,
        deckVersion: authorized.value.publicDeck.deckVersion,
      },
      nowMs,
    );
    if (issued.outcome === "REJECTED") return issued;
    const minted = IssuedDisplayInvitationSchema.safeParse(issued.invitation);
    if (!minted.success || minted.data.deckVersion !== authorized.value.publicDeck.deckVersion) {
      return { outcome: "REJECTED", reason: "INVALID_PROJECTION_RESPONSE" };
    }
    // The Stage URL the Console copies: fragment-carried token only, so the secret never
    // appears in a query string, referrer, or server access log. Exact origin composition
    // stays with the Console's own stage resolution.
    return {
      outcome: "APPLIED",
      value: {
        ...minted.data,
        stagePath: `/?deck=${minted.data.deckVersion}#invite=${minted.data.token}`,
      },
    };
  }

  /**
   * Owner-only read of an invitation's pending state: the exact visible display identity
   * awaiting approval plus the authoritative display binding epoch the approval CAS is
   * written against. The projection record pins the presentation session, so a token minted
   * for one session can never surface as a pending request on another.
   */
  async readDisplayInvitation(
    accountSessionId: string,
    invitationId: string,
    nowMs: number,
  ): Promise<OperationResult<DisplayInvitationPendingView>> {
    const invitation = DisplayInvitationIdSchema.safeParse(invitationId);
    if (!invitation.success) {
      return { outcome: "REJECTED", reason: "INVITATION_UNKNOWN" };
    }
    const projectionView = await this.#projection.readDisplayInvitation(invitation.data, nowMs);
    if (projectionView.outcome === "REJECTED") {
      return { outcome: "REJECTED", reason: projectionView.reason };
    }
    const view = DisplayInvitationViewSchema.safeParse(projectionView.invitation);
    if (!view.success) return { outcome: "REJECTED", reason: "INVALID_PROJECTION_RESPONSE" };
    const authorized = await this.#authorizedPresentation(
      accountSessionId,
      view.data.presentationSessionId,
      nowMs,
    );
    if (authorized.outcome === "REJECTED") return authorized;
    return {
      outcome: "APPLIED",
      value: DisplayInvitationPendingViewSchema.parse({
        invitationId: view.data.invitationId,
        presentationSessionId: view.data.presentationSessionId,
        deckVersion: view.data.deckVersion,
        expiresAtMs: view.data.expiresAtMs,
        status: view.data.status,
        displayBindingEpoch: authorized.value.playback.displayBindingEpoch,
        join: view.data.join,
      }),
    };
  }

  async connectPlaybackController(
    accountSessionId: string,
    presentationSessionId: string,
    nowMs: number,
    onClose: (reason: ControllerSocketCloseReason) => void,
  ): Promise<OperationResult<ControllerSocket>> {
    const authorized = await this.#authorizedPresentation(
      accountSessionId,
      presentationSessionId,
      nowMs,
    );
    if (authorized.outcome === "REJECTED") return authorized;
    const account = await this.readAccountSession(accountSessionId, nowMs);
    if (
      account.outcome === "REJECTED" ||
      account.value.actorId !== authorized.value.playback.activeLease.actorId
    ) {
      return { outcome: "REJECTED", reason: "UNAUTHORIZED" };
    }
    const mutable: MutableControllerSocket = {
      closed: false,
      closeReason: null,
      leaseId: authorized.value.playback.activeLease.leaseId,
      onClose,
    };
    const sockets = this.#controllerSockets.get(presentationSessionId) ?? new Set();
    sockets.add(mutable);
    this.#controllerSockets.set(presentationSessionId, sockets);
    return {
      outcome: "APPLIED",
      value: {
        get closed() {
          return mutable.closed;
        },
        get closeReason() {
          return mutable.closeReason;
        },
        close: () => this.#closeControllerSocket(presentationSessionId, mutable, "CLIENT_CLOSED"),
      },
    };
  }

  async takeoverPlaybackLease(
    accountSessionId: string,
    input: unknown,
    nowMs: number,
  ): Promise<
    OperationResult<{
      readonly lease: PlaybackAuthorityState["activeLease"];
      readonly supersededReceipts: readonly SupersededCommandReceipt[];
    }>
  > {
    const takeover = PlaybackLeaseTakeoverSchema.safeParse(input);
    if (!takeover.success) return { outcome: "REJECTED", reason: "INVALID_LEASE_TAKEOVER" };
    const authorized = await this.#authorizedPresentation(
      accountSessionId,
      takeover.data.presentationSessionId,
      nowMs,
    );
    if (authorized.outcome === "REJECTED") return authorized;
    if (
      takeover.data.expectedDisplayBindingEpoch !== authorized.value.playback.displayBindingEpoch
    ) {
      return { outcome: "REJECTED", reason: "STALE_DISPLAY_BINDING" };
    }
    const account = await this.readAccountSession(accountSessionId, nowMs);
    if (account.outcome === "REJECTED") return account;
    const previousLease = authorized.value.playback.activeLease;
    const currentEpoch = Number(previousLease.controllerEpoch.slice(3));
    let replacementLease: PlaybackAuthorityState["activeLease"];
    try {
      replacementLease = PlaybackControlLeaseSchema.parse({
        leaseId: `lease_${opaqueHex(16)}`,
        presentationSessionId: previousLease.presentationSessionId,
        presentationSessionEpoch: previousLease.presentationSessionEpoch,
        actorId: account.value.actorId,
        controllerEpoch: controllerEpoch(currentEpoch + 1),
        expiresAtMs: nowMs + this.#presentationCapabilityTtlMs,
      });
    } catch {
      return { outcome: "REJECTED", reason: "CONTROLLER_EPOCH_EXHAUSTED" };
    }
    const replaced = replacePlaybackLease(authorized.value.playback, replacementLease);
    authorized.value.playback = replaced;
    this.#touch(authorized.value, nowMs);
    const supersededReceipts = Object.values(replaced.acceptedCommands).flatMap((record) =>
      record.supersededReceipt !== null &&
      record.supersededReceipt.supersededByLeaseId === replacementLease.leaseId
        ? [record.supersededReceipt]
        : [],
    );
    for (const socket of this.#controllerSockets.get(takeover.data.presentationSessionId) ?? []) {
      if (!socket.closed && socket.leaseId === previousLease.leaseId) {
        this.#closeControllerSocket(takeover.data.presentationSessionId, socket, "SUPERSEDED");
      }
    }
    return { outcome: "APPLIED", value: { lease: replacementLease, supersededReceipts } };
  }

  async setSlide(
    accountSessionId: string,
    input: {
      readonly presentationSessionId: string;
      readonly commandId: string;
      readonly publicSlideKey: string;
      readonly displayBindingEpoch: string;
      readonly baseRevision: string;
    },
    nowMs: number,
  ): Promise<OperationResult<ReturnType<typeof reducePlaybackCommand>["receipt"]>> {
    const authorized = await this.#authorizedPresentation(
      accountSessionId,
      input.presentationSessionId,
      nowMs,
    );
    if (authorized.outcome === "REJECTED") return authorized;
    const account = await this.readAccountSession(accountSessionId, nowMs);
    if (
      account.outcome === "REJECTED" ||
      account.value.actorId !== authorized.value.playback.activeLease.actorId
    ) {
      return { outcome: "REJECTED", reason: "UNAUTHORIZED" };
    }
    const commandId = CommandIdSchema.safeParse(input.commandId);
    const baseRevision = ControlRevisionSchema.safeParse(input.baseRevision);
    const bindingEpoch = DisplayBindingEpochSchema.safeParse(input.displayBindingEpoch);
    const publicSlideKey = PublicSlideKeySchema.safeParse(input.publicSlideKey);
    if (
      !(commandId.success && baseRevision.success && bindingEpoch.success && publicSlideKey.success)
    ) {
      return { outcome: "REJECTED", reason: "INVALID_COMMAND" };
    }
    const playback = authorized.value.playback;
    const reduction = reducePlaybackCommand(
      playback,
      {
        type: "SLIDE_SET",
        presentationSessionId: playback.presentationSessionId,
        presentationSessionEpoch: playback.presentationSessionEpoch,
        actorId: playback.activeLease.actorId,
        leaseId: playback.activeLease.leaseId,
        controllerEpoch: playback.activeLease.controllerEpoch,
        commandId: commandId.data,
        baseRevision: baseRevision.data,
        delivery: "LIVE",
        displayBindingEpoch: bindingEpoch.data,
        publicSlideKey: publicSlideKey.data,
      },
      nowMs,
    );
    if (reduction.receipt.status !== "ACCEPTED" || reduction.effect === null) {
      return {
        outcome: "REJECTED",
        reason:
          reduction.receipt.status === "REJECTED" ? reduction.receipt.reason : "COMMAND_REJECTED",
      };
    }
    authorized.value.playback = reduction.state;
    if (
      !(await this.#projection.projectPlayback(input.presentationSessionId, {
        commandId: reduction.effect.commandId,
        displayBindingEpoch: reduction.receipt.displayBindingEpoch,
        acceptedControlRevision: reduction.effect.acceptedControlRevision,
        occurrence: reduction.effect.occurrence,
        blackout: reduction.effect.blackout,
      }))
    ) {
      authorized.value.playback = playback;
      return { outcome: "REJECTED", reason: "PROJECTION_REJECTED" };
    }
    this.#touch(authorized.value, nowMs);
    if (this.#reportObserver !== undefined) {
      try {
        this.#reportObserver.onAcceptedSlideSet({
          tenantId: authorized.value.lifecycle.ownerAccountId,
          presentationSessionId: authorized.value.lifecycle.presentationSessionId,
          ownerSubject: authorized.value.lifecycle.ownerAccountId,
          presentationSessionEpoch: presentationSessionEpochValue(
            authorized.value.lifecycle.presentationSessionEpoch,
          ),
          sequence: controlRevisionValue(reduction.effect.acceptedControlRevision),
          publicSlideKey: reduction.effect.occurrence.publicSlideKey,
          acceptedOffsetMs: nowMs - authorized.value.lifecycle.createdAtMs,
          producerId: reduction.effect.commandId,
        });
      } catch (error) {
        this.#reportObserver.onFailure(error);
      }
    }
    return { outcome: "APPLIED", value: reduction.receipt };
  }

  async recordStageApplied(input: {
    readonly audienceDisplaySessionId: string;
    readonly commandId: string;
    readonly displayBindingEpoch: string;
  }): Promise<OperationResult<StageAppliedReceipt>> {
    const presentation = Array.from(this.#store.presentations.values()).find(
      (candidate) =>
        candidate.audienceDisplaySession?.audienceDisplaySessionId ===
        input.audienceDisplaySessionId,
    );
    if (presentation === undefined)
      return { outcome: "REJECTED", reason: "DISPLAY_SESSION_UNKNOWN" };
    const commandId = CommandIdSchema.safeParse(input.commandId);
    const epoch = DisplayBindingEpochSchema.safeParse(input.displayBindingEpoch);
    if (!commandId.success || !epoch.success) {
      return { outcome: "REJECTED", reason: "INVALID_RECEIPT" };
    }
    const result = markStageApplied(presentation.playback, commandId.data, epoch.data);
    if (result.receipt === null) return { outcome: "REJECTED", reason: result.outcome };
    if (
      !(await this.#projection.recordPlaybackApplied(
        presentation.lifecycle.presentationSessionId,
        input.displayBindingEpoch,
        result.receipt.publicPlaybackRevision,
      ))
    ) {
      return { outcome: "REJECTED", reason: "PROJECTION_RECEIPT_REJECTED" };
    }
    presentation.playback = result.state;
    return { outcome: "APPLIED", value: result.receipt };
  }

  async addCuratedCandidate(
    accountSessionId: string,
    candidateInput: unknown,
    nowMs: number,
  ): Promise<OperationResult<CandidateLifecycleState>> {
    const candidate = EvidenceCandidateSchema.safeParse(candidateInput);
    if (!candidate.success || candidate.data.provenance !== "CURATED_PREAPPROVED") {
      return { outcome: "REJECTED", reason: "INVALID_CURATED_CANDIDATE" };
    }
    const authorized = await this.#authorizedPresentation(
      accountSessionId,
      candidate.data.causal.presentationSessionId,
      nowMs,
    );
    if (authorized.outcome === "REJECTED") return authorized;
    if (
      candidate.data.causal.presentationSessionEpoch !==
        authorized.value.lifecycle.presentationSessionEpoch ||
      candidate.data.causal.deckVersion !== authorized.value.publicDeck.deckVersion ||
      candidate.data.causal.manifestHash !== authorized.value.publicDeck.manifestHash ||
      candidate.data.causal.displayBindingEpoch !== authorized.value.playback.displayBindingEpoch
    ) {
      return { outcome: "REJECTED", reason: "STALE_CANDIDATE" };
    }
    let lifecycle = createCandidateLifecycle({
      presentationSessionId: candidate.data.causal.presentationSessionId,
      presentationSessionEpoch: candidate.data.causal.presentationSessionEpoch,
      candidateId: candidate.data.candidateId,
      candidateVersion: candidate.data.candidateVersion,
      contentHash: candidate.data.causal.source.contentHash,
    });
    const qualified = reduceCandidateLifecycle(lifecycle, {
      type: "QUALIFY",
      presentationSessionId: lifecycle.presentationSessionId,
      presentationSessionEpoch: lifecycle.presentationSessionEpoch,
      candidateId: lifecycle.candidateId,
      candidateVersion: lifecycle.candidateVersion,
      expectedRevision: lifecycle.candidateRevision,
    });
    if (qualified.outcome !== "APPLIED") throw new Error("curated qualification invariant failed");
    lifecycle = qualified.state;
    authorized.value.candidates.set(candidate.data.candidateId, {
      candidate: candidate.data,
      lifecycle,
    });
    return { outcome: "APPLIED", value: lifecycle };
  }

  async addLiveCandidate(
    accountSessionId: string,
    candidateInput: unknown,
    nowMs: number,
  ): Promise<OperationResult<CandidateLifecycleState>> {
    const candidate = EvidenceCandidateSchema.safeParse(candidateInput);
    if (!candidate.success || candidate.data.provenance !== "LIVE_VERIFIED") {
      return { outcome: "REJECTED", reason: "INVALID_LIVE_CANDIDATE" };
    }
    if (
      this.#liveEvidenceAuthorizer === undefined ||
      !(await this.#liveEvidenceAuthorizer.authorize(candidate.data))
    ) {
      return { outcome: "REJECTED", reason: "EVIDENCE_AUTHORIZATION_DENIED" };
    }
    const authorized = await this.#authorizedPresentation(
      accountSessionId,
      candidate.data.causal.presentationSessionId,
      nowMs,
    );
    if (authorized.outcome === "REJECTED") return authorized;
    if (
      candidate.data.causal.presentationSessionEpoch !==
        authorized.value.lifecycle.presentationSessionEpoch ||
      candidate.data.causal.deckVersion !== authorized.value.publicDeck.deckVersion ||
      candidate.data.causal.manifestHash !== authorized.value.publicDeck.manifestHash ||
      candidate.data.causal.displayBindingEpoch !== authorized.value.playback.displayBindingEpoch ||
      !sameOccurrence(candidate.data.causal.occurrence, authorized.value.playback.occurrence) ||
      candidate.data.causal.decisions.publicationPolicy !==
        authorized.value.cards.authority?.policyVersion
    )
      return { outcome: "REJECTED", reason: "STALE_CANDIDATE" };
    let lifecycle = createCandidateLifecycle({
      presentationSessionId: candidate.data.causal.presentationSessionId,
      presentationSessionEpoch: candidate.data.causal.presentationSessionEpoch,
      candidateId: candidate.data.candidateId,
      candidateVersion: candidate.data.candidateVersion,
      contentHash: candidate.data.causal.source.contentHash,
    });
    const qualified = reduceCandidateLifecycle(lifecycle, {
      type: "QUALIFY",
      presentationSessionId: lifecycle.presentationSessionId,
      presentationSessionEpoch: lifecycle.presentationSessionEpoch,
      candidateId: lifecycle.candidateId,
      candidateVersion: lifecycle.candidateVersion,
      expectedRevision: lifecycle.candidateRevision,
    });
    if (qualified.outcome !== "APPLIED") throw new Error("live qualification invariant failed");
    lifecycle = qualified.state;
    authorized.value.candidates.set(candidate.data.candidateId, {
      candidate: candidate.data,
      lifecycle,
    });
    return { outcome: "APPLIED", value: lifecycle };
  }

  async approvePublicationTeammate(
    accountSessionId: string,
    presentationSessionId: string,
    teammateActorId: string,
    nowMs: number,
  ): Promise<OperationResult<null>> {
    const authorized = await this.#authorizedPresentation(
      accountSessionId,
      presentationSessionId,
      nowMs,
    );
    if (authorized.outcome === "REJECTED") return authorized;
    const account = await this.readAccountSession(accountSessionId, nowMs);
    if (
      account.outcome === "REJECTED" ||
      authorized.value.cards.authority?.actorId !== account.value.actorId ||
      !/^actor_[A-Za-z0-9._-]+$/.test(teammateActorId)
    ) {
      return { outcome: "REJECTED", reason: "UNAUTHORIZED" };
    }
    authorized.value.approvedPublicationActorIds.add(teammateActorId);
    return { outcome: "APPLIED", value: null };
  }

  async readLiveCandidateSnapshot(
    accountSessionId: string,
    presentationSessionId: string,
    nowMs: number,
  ): Promise<OperationResult<LiveCandidateSnapshot>> {
    const authorized = await this.#authorizedPresentation(
      accountSessionId,
      presentationSessionId,
      nowMs,
    );
    if (authorized.outcome === "REJECTED") return authorized;
    const account = await this.readAccountSession(accountSessionId, nowMs);
    if (
      account.outcome === "REJECTED" ||
      !authorized.value.approvedPublicationActorIds.has(account.value.actorId)
    ) {
      return { outcome: "REJECTED", reason: "PUBLICATION_AUTHORITY_REQUIRED" };
    }
    return { outcome: "APPLIED", value: this.#liveCandidateSnapshot(authorized.value) };
  }

  async approveCandidate(
    _accountSessionId: string,
    _input: CandidateApprovalInput,
    _nowMs: number,
  ): Promise<OperationResult<PublishedAudienceCard>> {
    return { outcome: "REJECTED", reason: "PUBLICATION_DISABLED" };
  }

  async terminateCard(
    _accountSessionId: string,
    _input: CardTerminationInput,
    _nowMs: number,
  ): Promise<OperationResult<PublicationTombstone>> {
    return { outcome: "REJECTED", reason: "PUBLICATION_DISABLED" };
  }

  #liveCandidateSnapshot(presentation: PresentationRecord): LiveCandidateSnapshot {
    const candidates = [...presentation.candidates.values()]
      .filter(
        (record) =>
          record.candidate.provenance === "LIVE_VERIFIED" &&
          record.lifecycle.verdict === "SUPPORTED" &&
          record.lifecycle.publicationState === "PRIVATE" &&
          record.lifecycle.freshness === "FRESH" &&
          record.candidate.causal.presentationSessionEpoch ===
            presentation.lifecycle.presentationSessionEpoch &&
          record.candidate.causal.displayBindingEpoch ===
            presentation.playback.displayBindingEpoch &&
          record.candidate.causal.deckVersion === presentation.publicDeck.deckVersion &&
          record.candidate.causal.manifestHash === presentation.publicDeck.manifestHash &&
          record.candidate.causal.decisions.publicationPolicy ===
            presentation.cards.authority?.policyVersion &&
          sameOccurrence(record.candidate.causal.occurrence, presentation.playback.occurrence),
      )
      .map((record) => ({
        candidateId: record.candidate.candidateId,
        candidateVersion: record.candidate.candidateVersion,
        candidateRevision: record.lifecycle.candidateRevision,
        claimText: record.candidate.claimText,
        evidenceExcerpt: record.candidate.evidenceExcerpt,
        occurrence: record.candidate.causal.occurrence,
      }))
      .sort((left, right) => left.candidateId.localeCompare(right.candidateId));
    const payload = {
      presentationSessionId: presentation.lifecycle.presentationSessionId,
      presentationSessionEpoch: presentation.lifecycle.presentationSessionEpoch,
      publicationPolicyVersion: presentation.cards.authority?.policyVersion ?? "unavailable",
      publicationAuthorityId: presentation.cards.authority?.authorityId ?? "unavailable",
      publicCardRevision: presentation.cards.publicCardRevision,
      displayBindingEpoch: presentation.playback.displayBindingEpoch,
      occurrence: presentation.playback.occurrence,
      candidates,
    };
    return {
      authoritativeSnapshotHash: requestHash(payload),
      presentationSessionId: payload.presentationSessionId,
      presentationSessionEpoch: payload.presentationSessionEpoch,
      publicationPolicyVersion: payload.publicationPolicyVersion,
      publicationAuthorityId: payload.publicationAuthorityId,
      publicCardRevision: payload.publicCardRevision,
      livePublicEnabled: this.#livePublicEnabled,
      candidates,
    };
  }

  #closeControllerSocket(
    presentationSessionId: string,
    socket: MutableControllerSocket,
    reason: ControllerSocketCloseReason,
  ): void {
    if (socket.closed) return;
    socket.closed = true;
    socket.closeReason = reason;
    this.#controllerSockets.get(presentationSessionId)?.delete(socket);
    socket.onClose(reason);
  }

  async #authorizedPresentation(
    accountSessionId: string,
    presentationSessionId: string,
    nowMs: number,
  ): Promise<OperationResult<PresentationRecord>> {
    const account = await this.readAccountSession(accountSessionId, nowMs);
    if (account.outcome === "REJECTED") return account;
    const presentation = this.#store.presentations.get(presentationSessionId);
    if (presentation === undefined)
      return { outcome: "REJECTED", reason: "PRESENTATION_NOT_FOUND" };
    if (presentation.lifecycle.status !== "ACTIVE")
      return { outcome: "REJECTED", reason: "PRESENTATION_ENDED" };
    if (presentation.lifecycle.ownerAccountId !== account.value.accountId) {
      return { outcome: "REJECTED", reason: "UNAUTHORIZED" };
    }
    return { outcome: "APPLIED", value: presentation };
  }

  /**
   * The ownership check the library reads share: account session plus ownership, with NO
   * ACTIVE-only phase gate. Read and rename paths must reach ENDED presentations too.
   */
  async #ownedPresentation(
    accountSessionId: string,
    presentationSessionId: string,
    nowMs: number,
  ): Promise<OperationResult<PresentationRecord>> {
    const account = await this.readAccountSession(accountSessionId, nowMs);
    if (account.outcome === "REJECTED") return account;
    const presentation = this.#store.presentations.get(presentationSessionId);
    if (presentation === undefined)
      return { outcome: "REJECTED", reason: "PRESENTATION_NOT_FOUND" };
    if (presentation.lifecycle.ownerAccountId !== account.value.accountId) {
      return { outcome: "REJECTED", reason: "UNAUTHORIZED" };
    }
    return { outcome: "APPLIED", value: presentation };
  }

  /** Display title falls back to the uploaded deck title until the presenter renames it. */
  #presentationSummary(record: PresentationRecord): PresentationSummary {
    const { lifecycle } = record;
    return {
      presentationSessionId: lifecycle.presentationSessionId,
      presentationSessionEpoch: lifecycle.presentationSessionEpoch,
      title: lifecycle.presentationTitle ?? record.privateDeck.title,
      status: lifecycle.status,
      createdAtMs: lifecycle.createdAtMs,
      updatedAtMs: lifecycle.updatedAtMs ?? lifecycle.createdAtMs,
      endedAtMs: lifecycle.endedAtMs,
      deckVersion: lifecycle.deckVersion,
      slideCount: record.publicDeck.slides.length,
    };
  }

  /** Rewrites only the library timestamp; lifecycle shape itself is untouched. */
  #touch(record: PresentationRecord, nowMs: number): void {
    record.lifecycle = PresentationSessionLifecycleSchema.parse({
      ...record.lifecycle,
      updatedAtMs: nowMs,
    });
  }

  #encodePresentationCursor(record: PresentationRecord): string {
    return Buffer.from(
      JSON.stringify({
        createdAtMs: record.lifecycle.createdAtMs,
        presentationSessionId: record.lifecycle.presentationSessionId,
      }),
      "utf8",
    ).toString("base64url");
  }

  /**
   * Decodes a cursor this account was issued. Anything malformed, fabricated, or pointing at
   * a row outside the owner's ordering fails closed so a foreign session id can never steer
   * the scan.
   */
  #presentationCursor(
    value: string,
  ): { readonly createdAtMs: number; readonly presentationSessionId: string } | null {
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return null;
    const candidate = decoded as Record<string, unknown>;
    if (
      typeof candidate.createdAtMs !== "number" ||
      !Number.isInteger(candidate.createdAtMs) ||
      typeof candidate.presentationSessionId !== "string" ||
      !/^ps_[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidate.presentationSessionId)
    ) {
      return null;
    }
    return {
      createdAtMs: candidate.createdAtMs,
      presentationSessionId: candidate.presentationSessionId,
    };
  }
}
