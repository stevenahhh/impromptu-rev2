import {
  type DisplayInvitationStatus,
  type DisplayInvitationView,
  DisplayJoinSchema,
  type IssuedDisplayInvitation,
  IssuedDisplayInvitationSchema,
  type PublishedDeckArtifact,
  PublishedDeckArtifactSchema,
  type StoredDisplayInvitation,
  StoredDisplayInvitationSchema,
} from "@impromptu/contracts/public";

export type PublicDeckArtifact = PublishedDeckArtifact;

export interface DisplayJoinLocator {
  readonly displayJoinId: string;
  readonly displayId: string;
  readonly deckVersion: string;
  readonly displayFingerprint: string;
  readonly expiresAtMs: number;
}

export interface DisplayBindingRecord {
  readonly displayBindingId: string;
  readonly presentationSessionId: string;
  readonly presentationSessionEpoch: string;
  readonly displayId: string;
  readonly displayBindingEpoch: string;
  readonly deckVersion: string;
  readonly manifestHash: string;
}

export interface AudienceDisplaySessionRecord {
  readonly audienceDisplaySessionId: string;
  readonly binding: DisplayBindingRecord;
  readonly expiresAtMs: number;
}

export interface PlaybackProjectionInput {
  readonly commandId: string;
  readonly displayBindingEpoch: string;
  readonly acceptedControlRevision: string;
  readonly occurrence: { readonly publicSlideKey: string; readonly occurrenceSeq: number };
  readonly blackout: boolean;
}

export interface PlaybackProjection extends PlaybackProjectionInput {
  readonly presentationSessionEpoch: string;
  readonly publicPlaybackRevision: string;
}

export interface AudienceProjectionSnapshot {
  readonly role: "PUBLIC_STAGE";
  readonly stateHash: string;
  readonly presentationSessionId: string;
  readonly presentationSessionEpoch: string;
  readonly displayBindingEpoch: string;
  readonly publicPlaybackRevision: string;
  readonly publicCardRevision: string;
  readonly publicationPolicyVersion: string | null;
  readonly deck: PublicDeckArtifact;
  readonly occurrence: { readonly publicSlideKey: string; readonly occurrenceSeq: number };
  readonly blackout: boolean;
  readonly cards: readonly [];
  readonly tombstones: readonly [];
  readonly tombstoneWatermark: string;
  readonly tombstoneRetentionMs: number;
}

export type { StoredDisplayInvitation };

type JoinState = {
  readonly locator: DisplayJoinLocator;
  consumed: boolean;
  claimed: boolean;
  audienceDisplaySessionId: string | null;
};
type ProjectionState = {
  binding: DisplayBindingRecord;
  displaySession: AudienceDisplaySessionRecord;
  deck: PublicDeckArtifact;
  publicPlaybackRevision: string;
  occurrence: { readonly publicSlideKey: string; readonly occurrenceSeq: number };
  blackout: boolean;
  publicationPolicyVersion: string | null;
};

export interface ProjectionGatewayStore {
  readonly joins: Map<string, JoinState>;
  readonly projections: Map<string, ProjectionState>;
  /**
   * One-use display invitations keyed by invitation id. Deliberately outside the durable
   * gateway snapshot: invitations persist through snapshotDisplayInvitationState into a
   * separately versioned record so the previous binary can still restore joins/projections.
   */
  readonly invitations: Map<string, StoredDisplayInvitation>;
}

export function createProjectionGatewayStore(): ProjectionGatewayStore {
  return { joins: new Map(), projections: new Map(), invitations: new Map() };
}

export class ProjectionGatewaySnapshotError extends Error {
  readonly code = "INVALID_PROJECTION_DATABASE_SNAPSHOT";

  constructor(message: string) {
    super(message);
    this.name = "ProjectionGatewaySnapshotError";
  }
}

export type ProjectionGatewayStoreRestoreResult =
  | Readonly<{ outcome: "RESTORED"; store: ProjectionGatewayStore }>
  | Readonly<{ outcome: "INVALID_SNAPSHOT" }>;

function snapshotRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

function validId(value: unknown, prefix: string): value is string {
  return (
    typeof value === "string" &&
    value.length <= 200 &&
    new RegExp(`^${prefix}[A-Za-z0-9][A-Za-z0-9._-]*$`).test(value)
  );
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function parseDisplayJoin(value: unknown): DisplayJoinLocator | null {
  if (
    !snapshotRecord(value) ||
    !exactKeys(value, [
      "displayJoinId",
      "displayId",
      "deckVersion",
      "displayFingerprint",
      "expiresAtMs",
    ]) ||
    typeof value.displayJoinId !== "string" ||
    !/^join_[0-9a-f]{32,}$/.test(value.displayJoinId) ||
    !validId(value.displayId, "display_") ||
    !validId(value.deckVersion, "deck_") ||
    typeof value.displayFingerprint !== "string" ||
    value.displayFingerprint.length < 16 ||
    value.displayFingerprint.length > 256 ||
    !validTimestamp(value.expiresAtMs)
  ) {
    return null;
  }
  return {
    displayJoinId: value.displayJoinId,
    displayId: value.displayId,
    deckVersion: value.deckVersion,
    displayFingerprint: value.displayFingerprint,
    expiresAtMs: value.expiresAtMs,
  };
}

function parseDeck(value: unknown): PublicDeckArtifact | null {
  const parsed = PublishedDeckArtifactSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseDisplaySession(value: unknown): AudienceDisplaySessionRecord | null {
  if (
    !snapshotRecord(value) ||
    !exactKeys(value, ["audienceDisplaySessionId", "binding", "expiresAtMs"]) ||
    !validId(value.audienceDisplaySessionId, "audience_") ||
    !validTimestamp(value.expiresAtMs) ||
    !snapshotRecord(value.binding) ||
    !exactKeys(value.binding, [
      "displayBindingId",
      "presentationSessionId",
      "presentationSessionEpoch",
      "displayId",
      "displayBindingEpoch",
      "deckVersion",
      "manifestHash",
    ]) ||
    !validId(value.binding.displayBindingId, "binding_") ||
    !validId(value.binding.presentationSessionId, "ps_") ||
    revisionValue(value.binding.presentationSessionEpoch, "pse_") === null ||
    !validId(value.binding.displayId, "display_") ||
    revisionValue(value.binding.displayBindingEpoch, "dbe_") === null ||
    !validId(value.binding.deckVersion, "deck_") ||
    !validHash(value.binding.manifestHash)
  ) {
    return null;
  }
  return {
    audienceDisplaySessionId: value.audienceDisplaySessionId,
    binding: value.binding as unknown as DisplayBindingRecord,
    expiresAtMs: value.expiresAtMs,
  };
}

export function snapshotProjectionGatewayStore(store: ProjectionGatewayStore): unknown {
  return {
    stateKind: "PREPARED_EVIDENCE_PROJECTION_DATABASE_SNAPSHOT",
    joins: [...store.joins.values()],
    projections: [...store.projections.values()].map((projection) => ({
      binding: projection.binding,
      displaySession: projection.displaySession,
      deck: projection.deck,
      publicPlaybackRevision: projection.publicPlaybackRevision,
      publicCardRevision: "pcr_0",
      occurrence: projection.occurrence,
      blackout: projection.blackout,
      cards: [],
      tombstones: [],
      liveDisplayBindingEpochs: [],
      publicationPolicyVersion: projection.publicationPolicyVersion,
    })),
  };
}

export function restoreProjectionGatewayStore(input: unknown): ProjectionGatewayStoreRestoreResult {
  if (
    !snapshotRecord(input) ||
    !exactKeys(input, ["stateKind", "joins", "projections"]) ||
    input.stateKind !== "PREPARED_EVIDENCE_PROJECTION_DATABASE_SNAPSHOT" ||
    !Array.isArray(input.joins) ||
    !Array.isArray(input.projections)
  ) {
    return { outcome: "INVALID_SNAPSHOT" };
  }
  const store = createProjectionGatewayStore();
  for (const joinInput of input.joins) {
    if (
      !snapshotRecord(joinInput) ||
      !exactKeys(joinInput, ["locator", "consumed", "claimed", "audienceDisplaySessionId"]) ||
      typeof joinInput.consumed !== "boolean" ||
      typeof joinInput.claimed !== "boolean" ||
      (joinInput.audienceDisplaySessionId !== null &&
        typeof joinInput.audienceDisplaySessionId !== "string")
    ) {
      return { outcome: "INVALID_SNAPSHOT" };
    }
    const locator = parseDisplayJoin(joinInput.locator);
    if (
      locator === null ||
      store.joins.has(locator.displayJoinId) ||
      (joinInput.claimed && !joinInput.consumed) ||
      joinInput.consumed !== (joinInput.audienceDisplaySessionId !== null)
    ) {
      return { outcome: "INVALID_SNAPSHOT" };
    }
    store.joins.set(locator.displayJoinId, {
      locator,
      consumed: joinInput.consumed,
      claimed: joinInput.claimed,
      audienceDisplaySessionId: joinInput.audienceDisplaySessionId,
    });
  }
  for (const projectionInput of input.projections) {
    if (
      !snapshotRecord(projectionInput) ||
      !exactKeys(projectionInput, [
        "binding",
        "displaySession",
        "deck",
        "publicPlaybackRevision",
        "publicCardRevision",
        "occurrence",
        "blackout",
        "cards",
        "tombstones",
        "liveDisplayBindingEpochs",
        "publicationPolicyVersion",
      ]) ||
      typeof projectionInput.publicPlaybackRevision !== "string" ||
      typeof projectionInput.publicCardRevision !== "string" ||
      typeof projectionInput.blackout !== "boolean" ||
      !snapshotRecord(projectionInput.occurrence) ||
      typeof projectionInput.occurrence.publicSlideKey !== "string" ||
      typeof projectionInput.occurrence.occurrenceSeq !== "number" ||
      !Number.isSafeInteger(projectionInput.occurrence.occurrenceSeq) ||
      projectionInput.occurrence.occurrenceSeq <= 0 ||
      !Array.isArray(projectionInput.cards) ||
      !Array.isArray(projectionInput.tombstones) ||
      !Array.isArray(projectionInput.liveDisplayBindingEpochs) ||
      (projectionInput.publicationPolicyVersion !== null &&
        typeof projectionInput.publicationPolicyVersion !== "string")
    ) {
      return { outcome: "INVALID_SNAPSHOT" };
    }
    const displaySession = parseDisplaySession(projectionInput.displaySession);
    const deck = parseDeck(projectionInput.deck);
    const occurrence = {
      publicSlideKey: projectionInput.occurrence.publicSlideKey,
      occurrenceSeq: projectionInput.occurrence.occurrenceSeq,
    };
    const playbackRevision = revisionValue(projectionInput.publicPlaybackRevision, "pbr_");
    const legacyCardRevision = revisionValue(projectionInput.publicCardRevision, "pcr_");
    if (
      displaySession === null ||
      deck === null ||
      playbackRevision === null ||
      legacyCardRevision === null ||
      JSON.stringify(displaySession.binding) !== JSON.stringify(projectionInput.binding) ||
      displaySession.binding.deckVersion !== deck.deckVersion ||
      displaySession.binding.manifestHash !== deck.manifestHash ||
      !deck.slides.some((slide) => slide.publicSlideKey === occurrence.publicSlideKey) ||
      store.projections.has(displaySession.binding.presentationSessionId)
    ) {
      return { outcome: "INVALID_SNAPSHOT" };
    }
    store.projections.set(displaySession.binding.presentationSessionId, {
      binding: displaySession.binding,
      displaySession,
      deck,
      publicPlaybackRevision: projectionInput.publicPlaybackRevision,
      occurrence,
      blackout: projectionInput.blackout,
      publicationPolicyVersion: projectionInput.publicationPolicyVersion,
    });
  }
  for (const join of store.joins.values()) {
    if (
      join.audienceDisplaySessionId !== null &&
      ![...store.projections.values()].some(
        (projection) =>
          projection.displaySession.audienceDisplaySessionId === join.audienceDisplaySessionId,
      )
    ) {
      return { outcome: "INVALID_SNAPSHOT" };
    }
  }
  return { outcome: "RESTORED", store };
}

const DISPLAY_INVITATION_SNAPSHOT_KIND = "DISPLAY_INVITATION_STATE_SNAPSHOT";

export function snapshotDisplayInvitationState(store: ProjectionGatewayStore): unknown {
  return {
    stateKind: DISPLAY_INVITATION_SNAPSHOT_KIND,
    invitations: [...store.invitations.values()],
  };
}

export type DisplayInvitationRestoreResult =
  | Readonly<{ outcome: "RESTORED" }>
  | Readonly<{ outcome: "INVALID_SNAPSHOT" }>;

/**
 * Restores invitation records into an existing gateway store. The envelope and records are
 * closed; records carrying a join must be marked consumed and vice versa, which
 * StoredDisplayInvitationSchema refines for us.
 */
export function restoreDisplayInvitationState(
  store: ProjectionGatewayStore,
  input: unknown,
): DisplayInvitationRestoreResult {
  if (
    !snapshotRecord(input) ||
    !exactKeys(input, ["stateKind", "invitations"]) ||
    input.stateKind !== DISPLAY_INVITATION_SNAPSHOT_KIND ||
    !Array.isArray(input.invitations)
  ) {
    return { outcome: "INVALID_SNAPSHOT" };
  }
  const restored: StoredDisplayInvitation[] = [];
  for (const invitationInput of input.invitations) {
    const record = StoredDisplayInvitationSchema.safeParse(invitationInput);
    if (
      !record.success ||
      restored.some((item) => item.invitationId === record.data.invitationId)
    ) {
      return { outcome: "INVALID_SNAPSHOT" };
    }
    restored.push(record.data);
  }
  store.invitations.clear();
  for (const record of restored) {
    store.invitations.set(record.invitationId, record);
  }
  return { outcome: "RESTORED" };
}

export type BindDisplayResult =
  | Readonly<{ outcome: "BOUND"; session: AudienceDisplaySessionRecord }>
  | Readonly<{
      outcome: "REJECTED";
      reason:
        | "UNKNOWN_JOIN"
        | "JOIN_EXPIRED"
        | "JOIN_REPLAYED"
        | "WRONG_DECK"
        | "DISPLAY_IDENTITY_MISMATCH"
        | "JOIN_SESSION_MISMATCH"
        | "BINDING_CAS_CONFLICT";
    }>;

export type IssueDisplayInvitationResult =
  | Readonly<{ outcome: "ISSUED"; invitation: IssuedDisplayInvitation }>
  | Readonly<{ outcome: "REJECTED"; reason: "INVALID_INVITATION_REQUEST" }>;

export type ExchangeDisplayInvitationResult =
  | Readonly<{ outcome: "CREATED"; locator: DisplayJoinLocator }>
  | Readonly<{
      outcome: "REJECTED";
      reason:
        | "INVITATION_UNKNOWN"
        | "INVITATION_EXPIRED"
        | "INVITATION_CONSUMED"
        | "INVITATION_DECK_MISMATCH";
    }>;

export interface ReconnectSnapshotPins {
  readonly role: string;
  readonly presentationSessionEpoch: string;
  readonly displayBindingEpoch: string;
  readonly deckVersion: string;
  readonly manifestHash: string;
  readonly stateHash?: string;
}

export type ReconcileSnapshotResult =
  | Readonly<{ outcome: "SNAPSHOT"; snapshot: AudienceProjectionSnapshot }>
  | Readonly<{ outcome: "RECONCILE_REQUIRED" }>
  | Readonly<{ outcome: "SESSION_EXPIRED" }>;

export type StageSocketCloseReason = "REBOUND" | "SESSION_EXPIRED" | "CLIENT_CLOSED";

export interface StageSocket {
  readonly closed: boolean;
  readonly closeReason: StageSocketCloseReason | null;
  close(): void;
}

type StageObserver = Readonly<{
  onPlayback: (event: PlaybackProjection) => void;
  onClose: (reason: StageSocketCloseReason) => void;
}>;

type MutableStageSocket = {
  closed: boolean;
  closeReason: StageSocketCloseReason | null;
  observer: StageObserver;
};

function opaqueHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sha256Hex(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function revisionValue(revision: unknown, prefix: string): number | null {
  if (typeof revision !== "string" || !revision.startsWith(prefix)) return null;
  const value = Number(revision.slice(prefix.length));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Hard ceiling on display-invitation lifetime, pinned by plan task 6: an invitation is a
 * non-authorizing, one-use locator the presenter hands to a Stage, so its validity window
 * must never exceed 90 seconds regardless of configuration.
 */
export const MAX_DISPLAY_INVITATION_TTL_MS = 90_000;

export class PreparedEvidenceProjectionGateway {
  readonly #store: ProjectionGatewayStore;
  readonly #sockets = new Map<string, Set<MutableStageSocket>>();
  readonly #joinTtlMs: number;
  readonly #invitationTtlMs: number;
  readonly #displaySessionTtlMs: number;
  readonly #tombstoneRetentionMs: number;

  constructor(
    store: ProjectionGatewayStore = createProjectionGatewayStore(),
    options: {
      readonly joinTtlMs?: number;
      readonly invitationTtlMs?: number;
      readonly displaySessionTtlMs?: number;
      readonly tombstoneRetentionMs?: number;
    } = {},
  ) {
    this.#store = store;
    this.#joinTtlMs = options.joinTtlMs ?? 90_000;
    const invitationTtlMs = options.invitationTtlMs ?? MAX_DISPLAY_INVITATION_TTL_MS;
    if (
      !Number.isSafeInteger(invitationTtlMs) ||
      invitationTtlMs <= 0 ||
      invitationTtlMs > MAX_DISPLAY_INVITATION_TTL_MS
    ) {
      throw new Error("display invitation TTL must be a positive integer within 90000 ms");
    }
    this.#invitationTtlMs = invitationTtlMs;
    this.#displaySessionTtlMs = options.displaySessionTtlMs ?? 8 * 60 * 60 * 1_000;
    this.#tombstoneRetentionMs = options.tombstoneRetentionMs ?? 24 * 60 * 60 * 1_000;
  }

  /**
   * Mints the one-use invitation token and stores only its digest. The token leaves this
   * process exactly once, in the ISSUED result; it is never reachable from the store.
   */
  issueDisplayInvitation(
    input: {
      readonly presentationSessionId: string;
      readonly deckVersion: string;
    },
    nowMs: number,
  ): IssueDisplayInvitationResult {
    if (!validId(input.presentationSessionId, "ps_") || !validId(input.deckVersion, "deck_")) {
      return { outcome: "REJECTED", reason: "INVALID_INVITATION_REQUEST" };
    }
    const token = `dinv_${opaqueHex(32)}`;
    const stored = StoredDisplayInvitationSchema.safeParse({
      invitationId: `dinvite_${opaqueHex(16)}`,
      tokenDigest: sha256Hex(token),
      presentationSessionId: input.presentationSessionId,
      deckVersion: input.deckVersion,
      expiresAtMs: nowMs + this.#invitationTtlMs,
      consumedAtMs: null,
      join: null,
    });
    if (!stored.success) return { outcome: "REJECTED", reason: "INVALID_INVITATION_REQUEST" };
    this.#store.invitations.set(stored.data.invitationId, stored.data);
    return {
      outcome: "ISSUED",
      invitation: IssuedDisplayInvitationSchema.parse({
        invitationId: stored.data.invitationId,
        token,
        deckVersion: stored.data.deckVersion,
        expiresAtMs: stored.data.expiresAtMs,
      }),
    };
  }

  /**
   * Public, non-authorizing exchange: the token resolves to exactly one pending join.
   * Consumption is committed in the same synchronous turn that creates the join, so a
   * replayed token can never mint a second locator.
   */
  exchangeDisplayInvitation(
    input: {
      readonly invitationToken: string;
      readonly displayId: string;
      readonly deckVersion: string;
      readonly displayFingerprint: string;
    },
    nowMs: number,
  ): ExchangeDisplayInvitationResult {
    const digest = sha256Hex(input.invitationToken);
    const invitation = [...this.#store.invitations.values()].find(
      (candidate) => candidate.tokenDigest === digest,
    );
    if (invitation === undefined) {
      return { outcome: "REJECTED", reason: "INVITATION_UNKNOWN" };
    }
    if (invitation.consumedAtMs !== null) {
      return { outcome: "REJECTED", reason: "INVITATION_CONSUMED" };
    }
    if (nowMs >= invitation.expiresAtMs) {
      return { outcome: "REJECTED", reason: "INVITATION_EXPIRED" };
    }
    if (invitation.deckVersion !== input.deckVersion) {
      return { outcome: "REJECTED", reason: "INVITATION_DECK_MISMATCH" };
    }
    const locator = this.createDisplayJoin(
      {
        displayId: input.displayId,
        deckVersion: input.deckVersion,
        displayFingerprint: input.displayFingerprint,
      },
      nowMs,
    );
    this.#store.invitations.set(invitation.invitationId, {
      ...invitation,
      consumedAtMs: nowMs,
      join: DisplayJoinSchema.parse(locator),
    });
    return { outcome: "CREATED", locator };
  }

  /**
   * Internal read for the private backend's owner-facing pending endpoint. The token and
   * its digest never appear in the view.
   */
  readDisplayInvitation(
    invitationId: string,
    nowMs: number,
  ):
    | Readonly<{ outcome: "FOUND"; invitation: DisplayInvitationView }>
    | Readonly<{
        outcome: "REJECTED";
        reason: "INVITATION_UNKNOWN";
      }> {
    const record = this.#store.invitations.get(invitationId);
    if (record === undefined) {
      return { outcome: "REJECTED", reason: "INVITATION_UNKNOWN" };
    }
    const status: DisplayInvitationStatus =
      record.join !== null ? "JOINED" : nowMs >= record.expiresAtMs ? "EXPIRED" : "PENDING";
    return {
      outcome: "FOUND",
      invitation: {
        invitationId: record.invitationId,
        presentationSessionId: record.presentationSessionId,
        deckVersion: record.deckVersion,
        expiresAtMs: record.expiresAtMs,
        status,
        join: record.join === null ? null : DisplayJoinSchema.parse(record.join),
      },
    };
  }

  createDisplayJoin(
    input: {
      readonly displayId: string;
      readonly deckVersion: string;
      readonly displayFingerprint: string;
    },
    nowMs: number,
  ): DisplayJoinLocator {
    const locator: DisplayJoinLocator = {
      displayJoinId: `join_${opaqueHex(16)}`,
      displayId: input.displayId,
      deckVersion: input.deckVersion,
      displayFingerprint: input.displayFingerprint,
      expiresAtMs: nowMs + this.#joinTtlMs,
    };
    this.#store.joins.set(locator.displayJoinId, {
      locator,
      consumed: false,
      claimed: false,
      audienceDisplaySessionId: null,
    });
    return locator;
  }

  bindDisplay(
    input: {
      readonly displayJoinId: string;
      readonly presentationSessionId: string;
      readonly presentationSessionEpoch: string;
      readonly publicationPolicyVersion?: string;
      readonly expectedDisplayBindingEpoch: string;
      readonly expectedDeckVersion: string;
      readonly approvedDisplayId: string;
      readonly approvedDisplayFingerprint: string;
      readonly deck: PublicDeckArtifact;
    },
    nowMs: number,
  ): BindDisplayResult {
    const join = this.#store.joins.get(input.displayJoinId);
    if (join === undefined) return { outcome: "REJECTED", reason: "UNKNOWN_JOIN" };
    if (join.consumed) return { outcome: "REJECTED", reason: "JOIN_REPLAYED" };
    if (nowMs >= join.locator.expiresAtMs) return { outcome: "REJECTED", reason: "JOIN_EXPIRED" };
    if (
      join.locator.deckVersion !== input.expectedDeckVersion ||
      input.deck.deckVersion !== input.expectedDeckVersion
    ) {
      return { outcome: "REJECTED", reason: "WRONG_DECK" };
    }
    if (
      join.locator.displayId !== input.approvedDisplayId ||
      join.locator.displayFingerprint !== input.approvedDisplayFingerprint
    ) {
      return { outcome: "REJECTED", reason: "DISPLAY_IDENTITY_MISMATCH" };
    }
    // An invitation-minted join is pinned to the presentation session it was issued for:
    // a presenter approving "the display in front of me" can never slide a token minted for
    // a previous or sibling session onto a different one.
    const invitation = [...this.#store.invitations.values()].find(
      (candidate) => candidate.join?.displayJoinId === join.locator.displayJoinId,
    );
    if (
      invitation !== undefined &&
      invitation.presentationSessionId !== input.presentationSessionId
    ) {
      return { outcome: "REJECTED", reason: "JOIN_SESSION_MISMATCH" };
    }

    const current = this.#store.projections.get(input.presentationSessionId);
    const currentEpoch = current?.binding.displayBindingEpoch ?? "dbe_0";
    if (input.expectedDisplayBindingEpoch !== currentEpoch) {
      return { outcome: "REJECTED", reason: "BINDING_CAS_CONFLICT" };
    }
    const epochValue = revisionValue(currentEpoch, "dbe_");
    if (epochValue === null) return { outcome: "REJECTED", reason: "BINDING_CAS_CONFLICT" };

    join.consumed = true;
    const binding: DisplayBindingRecord = {
      displayBindingId: `binding_${opaqueHex(16)}`,
      presentationSessionId: input.presentationSessionId,
      presentationSessionEpoch: input.presentationSessionEpoch,
      displayId: join.locator.displayId,
      displayBindingEpoch: `dbe_${epochValue + 1}`,
      deckVersion: input.deck.deckVersion,
      manifestHash: input.deck.manifestHash,
    };
    const session: AudienceDisplaySessionRecord = {
      audienceDisplaySessionId: `audience_${opaqueHex(24)}`,
      binding,
      expiresAtMs: nowMs + this.#displaySessionTtlMs,
    };
    join.audienceDisplaySessionId = session.audienceDisplaySessionId;
    const initialSlide = input.deck.slides[0];
    if (initialSlide === undefined) throw new Error("published deck must contain a slide");
    this.#closeSockets(input.presentationSessionId, "REBOUND");
    this.#store.projections.set(input.presentationSessionId, {
      binding,
      displaySession: session,
      deck: input.deck,
      publicPlaybackRevision: current?.publicPlaybackRevision ?? "pbr_0",
      occurrence: current?.occurrence ?? {
        publicSlideKey: initialSlide.publicSlideKey,
        occurrenceSeq: 1,
      },
      blackout: current?.blackout ?? false,
      publicationPolicyVersion:
        input.publicationPolicyVersion ?? current?.publicationPolicyVersion ?? null,
    });
    return { outcome: "BOUND", session };
  }

  claimDisplaySession(
    input: {
      readonly displayJoinId: string;
      readonly displayId: string;
      readonly displayFingerprint: string;
    },
    nowMs: number,
  ): AudienceDisplaySessionRecord | null {
    const join = this.#store.joins.get(input.displayJoinId);
    if (
      join === undefined ||
      !join.consumed ||
      join.claimed ||
      join.audienceDisplaySessionId === null ||
      join.locator.displayId !== input.displayId ||
      join.locator.displayFingerprint !== input.displayFingerprint
    ) {
      return null;
    }
    const projection = Array.from(this.#store.projections.values()).find(
      (candidate) =>
        candidate.displaySession.audienceDisplaySessionId === join.audienceDisplaySessionId,
    );
    if (projection === undefined || nowMs >= projection.displaySession.expiresAtMs) return null;
    join.claimed = true;
    return projection.displaySession;
  }

  connectStage(
    audienceDisplaySessionId: string,
    observer: StageObserver,
    nowMs: number,
  ): StageSocket | null {
    const projection = Array.from(this.#store.projections.values()).find(
      (candidate) => candidate.displaySession.audienceDisplaySessionId === audienceDisplaySessionId,
    );
    if (projection === undefined) return null;
    if (nowMs >= projection.displaySession.expiresAtMs) {
      observer.onClose("SESSION_EXPIRED");
      return null;
    }
    const mutable: MutableStageSocket = { closed: false, closeReason: null, observer };
    const sockets = this.#sockets.get(projection.binding.presentationSessionId) ?? new Set();
    sockets.add(mutable);
    this.#sockets.set(projection.binding.presentationSessionId, sockets);
    return {
      get closed() {
        return mutable.closed;
      },
      get closeReason() {
        return mutable.closeReason;
      },
      close: () =>
        this.#closeSocket(projection.binding.presentationSessionId, mutable, "CLIENT_CLOSED"),
    };
  }

  setPublicationPolicyVersion(
    presentationSessionId: string,
    publicationPolicyVersion: string,
  ): boolean {
    const projection = this.#store.projections.get(presentationSessionId);
    if (projection === undefined) return false;
    projection.publicationPolicyVersion = publicationPolicyVersion;
    return true;
  }

  projectPlayback(presentationSessionId: string, event: PlaybackProjectionInput): boolean {
    const projection = this.#store.projections.get(presentationSessionId);
    if (
      projection === undefined ||
      event.displayBindingEpoch !== projection.binding.displayBindingEpoch
    ) {
      return false;
    }
    const currentRevision = revisionValue(projection.publicPlaybackRevision, "pbr_");
    if (currentRevision === null) return false;
    const delivered: PlaybackProjection = {
      ...event,
      presentationSessionEpoch: projection.binding.presentationSessionEpoch,
      publicPlaybackRevision: `pbr_${currentRevision + 1}`,
    };
    projection.occurrence = event.occurrence;
    projection.blackout = event.blackout;
    for (const socket of this.#sockets.get(presentationSessionId) ?? []) {
      if (!socket.closed) socket.observer.onPlayback(delivered);
    }
    return true;
  }

  recordPlaybackApplied(
    presentationSessionId: string,
    displayBindingEpoch: string,
    publicPlaybackRevision: string,
  ): boolean {
    const projection = this.#store.projections.get(presentationSessionId);
    if (
      projection === undefined ||
      projection.binding.displayBindingEpoch !== displayBindingEpoch
    ) {
      return false;
    }
    const current = revisionValue(projection.publicPlaybackRevision, "pbr_");
    const next = revisionValue(publicPlaybackRevision, "pbr_");
    if (current === null || next !== current + 1) return false;
    projection.publicPlaybackRevision = publicPlaybackRevision;
    return true;
  }

  snapshot(audienceDisplaySessionId: string, nowMs: number): AudienceProjectionSnapshot | null {
    const projection = Array.from(this.#store.projections.values()).find(
      (candidate) => candidate.displaySession.audienceDisplaySessionId === audienceDisplaySessionId,
    );
    if (projection === undefined || nowMs >= projection.displaySession.expiresAtMs) return null;
    const absoluteState = {
      role: "PUBLIC_STAGE" as const,
      presentationSessionId: projection.binding.presentationSessionId,
      presentationSessionEpoch: projection.binding.presentationSessionEpoch,
      displayBindingEpoch: projection.binding.displayBindingEpoch,
      publicPlaybackRevision: projection.publicPlaybackRevision,
      publicCardRevision: "pcr_0",
      publicationPolicyVersion: projection.publicationPolicyVersion,
      deck: projection.deck,
      occurrence: projection.occurrence,
      blackout: projection.blackout,
      cards: [] as const,
      tombstones: [] as const,
      tombstoneWatermark: "pcr_0",
      tombstoneRetentionMs: this.#tombstoneRetentionMs,
    };
    const stateHash = new Bun.CryptoHasher("sha256")
      .update(JSON.stringify(absoluteState))
      .digest("hex");
    return { ...absoluteState, stateHash };
  }

  reconcileSnapshot(
    audienceDisplaySessionId: string,
    pins: ReconnectSnapshotPins,
    nowMs: number,
  ): ReconcileSnapshotResult {
    const snapshot = this.snapshot(audienceDisplaySessionId, nowMs);
    if (snapshot === null) return { outcome: "SESSION_EXPIRED" };
    if (
      pins.role !== "PUBLIC_STAGE" ||
      pins.presentationSessionEpoch !== snapshot.presentationSessionEpoch ||
      pins.displayBindingEpoch !== snapshot.displayBindingEpoch ||
      pins.deckVersion !== snapshot.deck.deckVersion ||
      pins.manifestHash !== snapshot.deck.manifestHash ||
      (pins.stateHash !== undefined && pins.stateHash !== snapshot.stateHash)
    ) {
      return { outcome: "RECONCILE_REQUIRED" };
    }
    return { outcome: "SNAPSHOT", snapshot };
  }

  #closeSocket(
    presentationSessionId: string,
    socket: MutableStageSocket,
    reason: StageSocketCloseReason,
  ): void {
    if (socket.closed) return;
    socket.closed = true;
    socket.closeReason = reason;
    this.#sockets.get(presentationSessionId)?.delete(socket);
    socket.observer.onClose(reason);
  }

  #closeSockets(presentationSessionId: string, reason: StageSocketCloseReason): void {
    for (const socket of [...(this.#sockets.get(presentationSessionId) ?? [])]) {
      this.#closeSocket(presentationSessionId, socket, reason);
    }
  }
}
