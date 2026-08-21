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
  DisplayApprovalSchema,
  type EvidenceCandidate,
  EvidenceCandidateSchema,
  PlaybackLeaseTakeoverSchema,
  type PresentationSessionLifecycle,
  PresentationSessionLifecycleSchema,
  type PrivateDeckContext,
  PrivateDeckContextSchema,
  type PublicationAuthority,
  presentationSessionEpochValue,
} from "@impromptu/contracts/private";
import {
  type AudienceDisplaySession,
  AudienceDisplaySessionSchema,
  DisplayBindingEpochSchema,
  displayBindingEpoch,
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
  | "UNAUTHORIZED";

export type OperationResult<Value> =
  | Readonly<{ outcome: "APPLIED"; value: Value }>
  | Readonly<{ outcome: "REJECTED"; reason: SessionRejection | string }>;

export type ControllerSocketCloseReason = "SUPERSEDED" | "CLIENT_CLOSED";

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

  async endPresentation(
    accountSessionId: string,
    presentationSessionId: string,
    nowMs: number,
  ): Promise<OperationResult<PresentationSessionLifecycle>> {
    const authorized = await this.#authorizedPresentation(
      accountSessionId,
      presentationSessionId,
      nowMs,
    );
    if (authorized.outcome === "REJECTED") return authorized;
    authorized.value.lifecycle = PresentationSessionLifecycleSchema.parse({
      ...authorized.value.lifecycle,
      status: "ENDED",
      endedAtMs: nowMs,
    });
    return { outcome: "APPLIED", value: authorized.value.lifecycle };
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
    return { outcome: "APPLIED", value: session.data };
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
}
