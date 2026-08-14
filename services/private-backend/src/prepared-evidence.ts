import {
  CommandIdSchema,
  ControlRevisionSchema,
  controllerEpoch,
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
} from "@impromptu/contracts/private";
import {
  type AudienceDisplaySession,
  AudienceDisplaySessionSchema,
  DisplayBindingEpochSchema,
  displayBindingEpoch,
  type PublicationTombstone,
  PublicCardRevisionSchema,
  PublicSlideKeySchema,
  type PublishedAudienceCard,
  type PublishedDeckArtifact,
  PublishedDeckArtifactSchema,
  publicCardRevision,
} from "@impromptu/contracts/public";
import {
  applyAuthorizedPublicCardEvent,
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

type MaybePromise<Value> = Value | Promise<Value>;

export interface PreparedEvidenceProjectionPort {
  bindDisplay(
    input: {
      readonly displayJoinId: string;
      readonly presentationSessionId: string;
      readonly presentationSessionEpoch: string;
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
  projectCard(
    presentationSessionId: string,
    event: PublishedAudienceCard | PublicationTombstone,
  ): MaybePromise<boolean>;
}

type CandidateRecord = {
  readonly candidate: EvidenceCandidate;
  lifecycle: CandidateLifecycleState;
};

type PresentationRecord = {
  lifecycle: PresentationSessionLifecycle;
  readonly privateDeck: PrivateDeckContext;
  readonly publicDeck: PublishedDeckArtifact;
  playback: PlaybackAuthorityState;
  cards: PublicCardStreamState;
  readonly candidates: Map<string, CandidateRecord>;
  audienceDisplaySession: AudienceDisplaySession | null;
};

export interface LiveEvidenceAuthorizer {
  authorize(candidate: EvidenceCandidate): Promise<boolean>;
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
        "audienceDisplaySession",
      ]) ||
      !Array.isArray(presentationInput.candidates)
    ) {
      return { outcome: "INVALID_SNAPSHOT" };
    }
    const lifecycle = PresentationSessionLifecycleSchema.safeParse(presentationInput.lifecycle);
    const privateDeck = PrivateDeckContextSchema.safeParse(presentationInput.privateDeck);
    const publicDeck = PublishedDeckArtifactSchema.safeParse(presentationInput.publicDeck);
    const playback = restorePlaybackAuthority(presentationInput.playback);
    const cards = restorePublicCardStream(presentationInput.cards);
    const audienceDisplaySession =
      presentationInput.audienceDisplaySession === null
        ? { success: true as const, data: null }
        : AudienceDisplaySessionSchema.safeParse(presentationInput.audienceDisplaySession);
    if (
      !lifecycle.success ||
      !privateDeck.success ||
      !publicDeck.success ||
      playback.outcome !== "RESTORED" ||
      cards.outcome !== "RESTORED" ||
      !audienceDisplaySession.success ||
      lifecycle.data.presentationSessionId !== playback.state.presentationSessionId ||
      lifecycle.data.presentationSessionId !== cards.state.presentationSessionId ||
      lifecycle.data.presentationSessionEpoch !== playback.state.presentationSessionEpoch ||
      lifecycle.data.presentationSessionEpoch !== cards.state.presentationSessionEpoch ||
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
      candidates.set(candidate.data.candidateId, {
        candidate: candidate.data,
        lifecycle: candidateLifecycle.state,
      });
    }
    store.presentations.set(lifecycle.data.presentationSessionId, {
      lifecycle: lifecycle.data,
      privateDeck: privateDeck.data,
      publicDeck: publicDeck.data,
      playback: playback.state,
      cards: cards.state,
      candidates,
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

function accountSessionRejection(
  session: AccountSession | undefined,
  nowMs: number,
): SessionRejection | null {
  if (session === undefined) return "ACCOUNT_SESSION_UNKNOWN";
  if (session.revokedAtMs !== null) return "ACCOUNT_SESSION_REVOKED";
  if (nowMs >= session.expiresAtMs) return "ACCOUNT_SESSION_EXPIRED";
  return null;
}

export class PreparedEvidenceCoordinator {
  readonly #store: PreparedEvidenceStore;
  readonly #projection: PreparedEvidenceProjectionPort;
  readonly #accountSessionTtlMs: number;
  readonly #presentationCapabilityTtlMs: number;
  readonly #liveEvidenceAuthorizer: LiveEvidenceAuthorizer | undefined;
  readonly #controllerSockets = new Map<string, Set<MutableControllerSocket>>();

  constructor(
    projection: PreparedEvidenceProjectionPort,
    store: PreparedEvidenceStore = createPreparedEvidenceStore(),
    options: {
      readonly accountSessionTtlMs?: number;
      readonly presentationCapabilityTtlMs?: number;
      readonly liveEvidenceAuthorizer?: LiveEvidenceAuthorizer;
    } = {},
  ) {
    this.#projection = projection;
    this.#store = store;
    this.#accountSessionTtlMs = options.accountSessionTtlMs ?? 8 * 60 * 60 * 1_000;
    this.#presentationCapabilityTtlMs = options.presentationCapabilityTtlMs ?? 4 * 60 * 60 * 1_000;
    this.#liveEvidenceAuthorizer = options.liveEvidenceAuthorizer;
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

  createAccountSession(
    verifiedIdentity: { readonly accountId: string; readonly actorId: string },
    nowMs: number,
  ): AccountSession {
    const session = AccountSessionSchema.parse({
      accountSessionId: `account_session_${opaqueHex(24)}`,
      accountId: verifiedIdentity.accountId,
      actorId: verifiedIdentity.actorId,
      expiresAtMs: nowMs + this.#accountSessionTtlMs,
      revokedAtMs: null,
    });
    this.#store.accountSessions.set(session.accountSessionId, session);
    return session;
  }

  readAccountSession(accountSessionId: string, nowMs: number): OperationResult<AccountSession> {
    const session = this.#store.accountSessions.get(accountSessionId);
    const rejection = accountSessionRejection(session, nowMs);
    return rejection === null && session !== undefined
      ? { outcome: "APPLIED", value: session }
      : { outcome: "REJECTED", reason: rejection ?? "ACCOUNT_SESSION_UNKNOWN" };
  }

  revokeAccountSession(accountSessionId: string, nowMs: number): OperationResult<null> {
    const session = this.#store.accountSessions.get(accountSessionId);
    const rejection = accountSessionRejection(session, nowMs);
    if (rejection !== null || session === undefined) {
      return { outcome: "REJECTED", reason: rejection ?? "ACCOUNT_SESSION_UNKNOWN" };
    }
    this.#store.accountSessions.set(
      accountSessionId,
      AccountSessionSchema.parse({ ...session, revokedAtMs: nowMs }),
    );
    return { outcome: "APPLIED", value: null };
  }

  createPresentation(
    accountSessionId: string,
    input: { readonly privateDeck: unknown; readonly publicDeck: unknown },
    nowMs: number,
  ): OperationResult<{
    readonly lifecycle: PresentationSessionLifecycle;
    readonly lease: PlaybackAuthorityState["activeLease"];
    readonly authority: PublicationAuthority;
  }> {
    const account = this.readAccountSession(accountSessionId, nowMs);
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
      audienceDisplaySession: null,
    });
    return { outcome: "APPLIED", value: { lifecycle, lease, authority } };
  }

  endPresentation(
    accountSessionId: string,
    presentationSessionId: string,
    nowMs: number,
  ): OperationResult<PresentationSessionLifecycle> {
    const authorized = this.#authorizedPresentation(accountSessionId, presentationSessionId, nowMs);
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
    const authorized = this.#authorizedPresentation(
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

  connectPlaybackController(
    accountSessionId: string,
    presentationSessionId: string,
    nowMs: number,
    onClose: (reason: ControllerSocketCloseReason) => void,
  ): OperationResult<ControllerSocket> {
    const authorized = this.#authorizedPresentation(accountSessionId, presentationSessionId, nowMs);
    if (authorized.outcome === "REJECTED") return authorized;
    const account = this.readAccountSession(accountSessionId, nowMs);
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

  takeoverPlaybackLease(
    accountSessionId: string,
    input: unknown,
    nowMs: number,
  ): OperationResult<{
    readonly lease: PlaybackAuthorityState["activeLease"];
    readonly supersededReceipts: readonly SupersededCommandReceipt[];
  }> {
    const takeover = PlaybackLeaseTakeoverSchema.safeParse(input);
    if (!takeover.success) return { outcome: "REJECTED", reason: "INVALID_LEASE_TAKEOVER" };
    const authorized = this.#authorizedPresentation(
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
    const account = this.readAccountSession(accountSessionId, nowMs);
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
    const authorized = this.#authorizedPresentation(
      accountSessionId,
      input.presentationSessionId,
      nowMs,
    );
    if (authorized.outcome === "REJECTED") return authorized;
    const account = this.readAccountSession(accountSessionId, nowMs);
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

  addCuratedCandidate(
    accountSessionId: string,
    candidateInput: unknown,
    nowMs: number,
  ): OperationResult<CandidateLifecycleState> {
    const candidate = EvidenceCandidateSchema.safeParse(candidateInput);
    if (!candidate.success || candidate.data.provenance !== "CURATED_PREAPPROVED") {
      return { outcome: "REJECTED", reason: "INVALID_CURATED_CANDIDATE" };
    }
    const authorized = this.#authorizedPresentation(
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
    const authorized = this.#authorizedPresentation(
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

  async approveCandidate(
    accountSessionId: string,
    input: {
      readonly presentationSessionId: string;
      readonly candidateId: string;
      readonly expectedCandidateRevision: string;
      readonly expectedPublicCardRevision: string;
      readonly authorityId: string;
      readonly expiresAtMs: number | null;
    },
    nowMs: number,
  ): Promise<OperationResult<PublishedAudienceCard>> {
    const authorized = this.#authorizedPresentation(
      accountSessionId,
      input.presentationSessionId,
      nowMs,
    );
    if (authorized.outcome === "REJECTED") return authorized;
    const record = authorized.value.candidates.get(input.candidateId);
    if (record === undefined) return { outcome: "REJECTED", reason: "CANDIDATE_NOT_FOUND" };
    if (
      record.candidate.causal.presentationSessionEpoch !==
        authorized.value.lifecycle.presentationSessionEpoch ||
      record.candidate.causal.displayBindingEpoch !==
        authorized.value.playback.displayBindingEpoch ||
      record.candidate.causal.deckVersion !== authorized.value.publicDeck.deckVersion ||
      record.candidate.causal.manifestHash !== authorized.value.publicDeck.manifestHash
    ) {
      return { outcome: "REJECTED", reason: "STALE_CANDIDATE" };
    }
    if (record.lifecycle.candidateRevision !== input.expectedCandidateRevision) {
      return { outcome: "REJECTED", reason: "CANDIDATE_CAS_CONFLICT" };
    }
    if (
      record.candidate.provenance === "LIVE_VERIFIED" &&
      (this.#liveEvidenceAuthorizer === undefined ||
        !(await this.#liveEvidenceAuthorizer.authorize(record.candidate)))
    ) {
      return { outcome: "REJECTED", reason: "EVIDENCE_AUTHORIZATION_DENIED" };
    }
    const expectedPublicCardRevision = PublicCardRevisionSchema.safeParse(
      input.expectedPublicCardRevision,
    );
    if (!expectedPublicCardRevision.success) {
      return { outcome: "REJECTED", reason: "INVALID_PUBLIC_CARD_REVISION" };
    }
    const nextRevision = publicCardRevision(Number(expectedPublicCardRevision.data.slice(4)) + 1);
    const projectionId = `projection_${opaqueHex(24)}` as PublishedAudienceCard["projectionId"];
    const event: PublishedAudienceCard = {
      projectionId,
      status: "PUBLISHED",
      claim: record.candidate.claimText,
      supportSummary: record.candidate.evidenceExcerpt,
      sourceLabel: `Prepared source ${projectionId.slice(-8)}`,
      publishedAtMs: nowMs,
      expiresAtMs: input.expiresAtMs,
      publicCardRevision: nextRevision,
      deckVersion: record.candidate.causal.deckVersion,
      manifestHash: record.candidate.causal.manifestHash,
      occurrence: record.candidate.causal.occurrence,
    };
    const applied = applyAuthorizedPublicCardEvent(
      authorized.value.cards,
      record.lifecycle,
      {
        presentationSessionId: authorized.value.lifecycle.presentationSessionId,
        presentationSessionEpoch: authorized.value.lifecycle.presentationSessionEpoch,
        authorityId: input.authorityId,
        expectedRevision: expectedPublicCardRevision.data,
        payload: event,
      },
      nowMs,
    );
    if (applied.outcome !== "APPLIED") return { outcome: "REJECTED", reason: applied.reason };
    const published = reduceCandidateLifecycle(record.lifecycle, {
      type: "PUBLISH",
      presentationSessionId: record.lifecycle.presentationSessionId,
      presentationSessionEpoch: record.lifecycle.presentationSessionEpoch,
      candidateId: record.lifecycle.candidateId,
      candidateVersion: record.lifecycle.candidateVersion,
      expectedRevision: record.lifecycle.candidateRevision,
      projectionId,
      publicCardRevision: nextRevision,
    });
    if (published.outcome !== "APPLIED") throw new Error("publication lifecycle invariant failed");
    // This second check is intentionally adjacent to the publication side effect.
    if (
      record.candidate.provenance === "LIVE_VERIFIED" &&
      (this.#liveEvidenceAuthorizer === undefined ||
        !(await this.#liveEvidenceAuthorizer.authorize(record.candidate)))
    ) {
      return { outcome: "REJECTED", reason: "EVIDENCE_AUTHORIZATION_DENIED" };
    }
    if (!(await this.#projection.projectCard(input.presentationSessionId, event))) {
      return { outcome: "REJECTED", reason: "PROJECTION_REJECTED" };
    }
    authorized.value.cards = applied.state;
    record.lifecycle = published.state;
    return { outcome: "APPLIED", value: event };
  }

  async terminateCard(
    accountSessionId: string,
    input: {
      readonly presentationSessionId: string;
      readonly projectionId: string;
      readonly expectedPublicCardRevision: string;
      readonly authorityId: string;
      readonly status: "RETRACTED" | "EXPIRED";
    },
    nowMs: number,
  ): Promise<OperationResult<PublicationTombstone>> {
    const authorized = this.#authorizedPresentation(
      accountSessionId,
      input.presentationSessionId,
      nowMs,
    );
    if (authorized.outcome === "REJECTED") return authorized;
    if (authorized.value.cards.cards[input.projectionId] === undefined) {
      return { outcome: "REJECTED", reason: "PUBLICATION_NOT_ACTIVE" };
    }
    const expectedPublicCardRevision = PublicCardRevisionSchema.safeParse(
      input.expectedPublicCardRevision,
    );
    if (!expectedPublicCardRevision.success) {
      return { outcome: "REJECTED", reason: "INVALID_PUBLIC_CARD_REVISION" };
    }
    const event: PublicationTombstone = {
      projectionId: input.projectionId as PublicationTombstone["projectionId"],
      status: input.status,
      publicCardRevision: publicCardRevision(Number(expectedPublicCardRevision.data.slice(4)) + 1),
      occurredAtMs: nowMs,
    };
    const applied = applyAuthorizedPublicCardEvent(
      authorized.value.cards,
      null,
      {
        presentationSessionId: authorized.value.lifecycle.presentationSessionId,
        presentationSessionEpoch: authorized.value.lifecycle.presentationSessionEpoch,
        authorityId: input.authorityId,
        expectedRevision: expectedPublicCardRevision.data,
        payload: event,
      },
      nowMs,
    );
    if (applied.outcome !== "APPLIED") return { outcome: "REJECTED", reason: applied.reason };
    if (!(await this.#projection.projectCard(input.presentationSessionId, event))) {
      return { outcome: "REJECTED", reason: "PROJECTION_REJECTED" };
    }
    authorized.value.cards = applied.state;
    return { outcome: "APPLIED", value: event };
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

  #authorizedPresentation(
    accountSessionId: string,
    presentationSessionId: string,
    nowMs: number,
  ): OperationResult<PresentationRecord> {
    const account = this.readAccountSession(accountSessionId, nowMs);
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
