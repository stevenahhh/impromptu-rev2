export interface PublicDeckArtifact {
  readonly deckVersion: string;
  readonly manifestHash: string;
  readonly title: string;
  readonly slides: readonly {
    readonly publicSlideKey: string;
    readonly ordinal: number;
    readonly image: {
      readonly url: string;
      readonly contentHash: string;
      readonly width: number;
      readonly height: number;
    };
    readonly accessibilityLabel: string;
  }[];
}

export interface PublicCardUpsert {
  readonly projectionId: string;
  readonly status: "PUBLISHED";
  readonly mode?: "CURATED" | "LIVE";
  readonly leaseExpiresAtMs?: number | null;
  readonly offlinePackage?: Readonly<{
    readonly offlineDisplayAllowed: boolean;
    readonly localExpiresAtMs: number;
    readonly signature: string;
  }>;
  readonly claim: string;
  readonly supportSummary: string;
  readonly sourceLabel: string;
  readonly publishedAtMs: number;
  readonly expiresAtMs: number | null;
  readonly publicCardRevision: string;
  readonly deckVersion: string;
  readonly manifestHash: string;
  readonly occurrence: { readonly publicSlideKey: string; readonly occurrenceSeq: number };
}

export interface PublicCardTombstone {
  readonly projectionId: string;
  readonly status: "RETRACTED" | "EXPIRED";
  readonly publicCardRevision: string;
  readonly occurredAtMs: number;
}

export type PublicCardEvent = PublicCardUpsert | PublicCardTombstone;

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

export interface PlaybackProjection {
  readonly commandId: string;
  readonly displayBindingEpoch: string;
  readonly acceptedControlRevision: string;
  readonly occurrence: { readonly publicSlideKey: string; readonly occurrenceSeq: number };
  readonly blackout: boolean;
}

export interface AudienceProjectionSnapshot {
  readonly role: "PUBLIC_STAGE";
  readonly stateHash: string;
  readonly presentationSessionId: string;
  readonly presentationSessionEpoch: string;
  readonly displayBindingEpoch: string;
  readonly publicPlaybackRevision: string;
  readonly publicCardRevision: string;
  readonly deck: PublicDeckArtifact;
  readonly occurrence: { readonly publicSlideKey: string; readonly occurrenceSeq: number };
  readonly blackout: boolean;
  readonly cards: readonly PublicCardUpsert[];
  readonly tombstones: readonly PublicCardTombstone[];
  readonly tombstoneWatermark: string;
  readonly tombstoneRetentionMs: number;
}

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
  publicCardRevision: string;
  occurrence: { readonly publicSlideKey: string; readonly occurrenceSeq: number };
  blackout: boolean;
  cards: Map<string, PublicCardUpsert>;
  tombstones: Map<string, PublicCardTombstone>;
};

export interface ProjectionGatewayStore {
  readonly joins: Map<string, JoinState>;
  readonly projections: Map<string, ProjectionState>;
}

export function createProjectionGatewayStore(): ProjectionGatewayStore {
  return { joins: new Map(), projections: new Map() };
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
  if (
    !snapshotRecord(value) ||
    !exactKeys(value, ["deckVersion", "manifestHash", "title", "slides"]) ||
    !validId(value.deckVersion, "deck_") ||
    !validHash(value.manifestHash) ||
    typeof value.title !== "string" ||
    value.title.length < 1 ||
    value.title.length > 500 ||
    !Array.isArray(value.slides) ||
    value.slides.length === 0
  ) {
    return null;
  }
  const slides: PublicDeckArtifact["slides"][number][] = [];
  for (const slide of value.slides) {
    if (
      !snapshotRecord(slide) ||
      !exactKeys(slide, ["publicSlideKey", "ordinal", "image", "accessibilityLabel"]) ||
      !validId(slide.publicSlideKey, "slide_") ||
      typeof slide.ordinal !== "number" ||
      !Number.isSafeInteger(slide.ordinal) ||
      slide.ordinal <= 0 ||
      typeof slide.accessibilityLabel !== "string" ||
      slide.accessibilityLabel.length < 1 ||
      slide.accessibilityLabel.length > 1_000 ||
      !snapshotRecord(slide.image) ||
      !exactKeys(slide.image, ["url", "contentHash", "width", "height"]) ||
      typeof slide.image.url !== "string" ||
      !URL.canParse(slide.image.url) ||
      !validHash(slide.image.contentHash) ||
      typeof slide.image.width !== "number" ||
      !Number.isSafeInteger(slide.image.width) ||
      slide.image.width <= 0 ||
      typeof slide.image.height !== "number" ||
      !Number.isSafeInteger(slide.image.height) ||
      slide.image.height <= 0
    ) {
      return null;
    }
    slides.push({
      publicSlideKey: slide.publicSlideKey,
      ordinal: slide.ordinal,
      image: {
        url: slide.image.url,
        contentHash: slide.image.contentHash,
        width: slide.image.width,
        height: slide.image.height,
      },
      accessibilityLabel: slide.accessibilityLabel,
    });
  }
  return {
    deckVersion: value.deckVersion,
    manifestHash: value.manifestHash,
    title: value.title,
    slides,
  };
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

function parseStoredCard(value: unknown): PublicCardUpsert | null {
  if (
    !snapshotRecord(value) ||
    !Object.keys(value).every((key) =>
      [
        "projectionId",
        "status",
        "mode",
        "leaseExpiresAtMs",
        "offlinePackage",
        "claim",
        "supportSummary",
        "sourceLabel",
        "publishedAtMs",
        "expiresAtMs",
        "publicCardRevision",
        "deckVersion",
        "manifestHash",
        "occurrence",
      ].includes(key),
    ) ||
    ![
      "projectionId",
      "status",
      "claim",
      "supportSummary",
      "sourceLabel",
      "publishedAtMs",
      "expiresAtMs",
      "publicCardRevision",
      "deckVersion",
      "manifestHash",
      "occurrence",
    ].every((key) => key in value) ||
    !validId(value.projectionId, "projection_") ||
    value.status !== "PUBLISHED" ||
    (value.mode !== undefined && value.mode !== "CURATED" && value.mode !== "LIVE") ||
    (value.leaseExpiresAtMs !== undefined &&
      value.leaseExpiresAtMs !== null &&
      !validTimestamp(value.leaseExpiresAtMs)) ||
    (value.offlinePackage !== undefined &&
      (!snapshotRecord(value.offlinePackage) ||
        !exactKeys(value.offlinePackage, [
          "offlineDisplayAllowed",
          "localExpiresAtMs",
          "signature",
        ]) ||
        typeof value.offlinePackage.offlineDisplayAllowed !== "boolean" ||
        !validTimestamp(value.offlinePackage.localExpiresAtMs) ||
        typeof value.offlinePackage.signature !== "string")) ||
    typeof value.claim !== "string" ||
    value.claim.length < 1 ||
    value.claim.length > 2_000 ||
    typeof value.supportSummary !== "string" ||
    value.supportSummary.length < 1 ||
    value.supportSummary.length > 4_000 ||
    typeof value.sourceLabel !== "string" ||
    value.sourceLabel.length < 1 ||
    value.sourceLabel.length > 500 ||
    !validTimestamp(value.publishedAtMs) ||
    (value.expiresAtMs !== null && !validTimestamp(value.expiresAtMs)) ||
    revisionValue(value.publicCardRevision, "pcr_") === null ||
    !validId(value.deckVersion, "deck_") ||
    !validHash(value.manifestHash) ||
    !snapshotRecord(value.occurrence) ||
    !exactKeys(value.occurrence, ["publicSlideKey", "occurrenceSeq"]) ||
    !validId(value.occurrence.publicSlideKey, "slide_") ||
    typeof value.occurrence.occurrenceSeq !== "number" ||
    !Number.isSafeInteger(value.occurrence.occurrenceSeq) ||
    value.occurrence.occurrenceSeq <= 0
  ) {
    return null;
  }
  return value as unknown as PublicCardUpsert;
}

function parseStoredTombstone(value: unknown): PublicCardTombstone | null {
  return snapshotRecord(value) &&
    exactKeys(value, ["projectionId", "status", "publicCardRevision", "occurredAtMs"]) &&
    validId(value.projectionId, "projection_") &&
    (value.status === "RETRACTED" || value.status === "EXPIRED") &&
    revisionValue(value.publicCardRevision, "pcr_") !== null &&
    validTimestamp(value.occurredAtMs)
    ? (value as unknown as PublicCardTombstone)
    : null;
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
      publicCardRevision: projection.publicCardRevision,
      occurrence: projection.occurrence,
      blackout: projection.blackout,
      cards: [...projection.cards.values()],
      tombstones: [...projection.tombstones.values()],
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
      !Array.isArray(projectionInput.tombstones)
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
    const cardRevision = revisionValue(projectionInput.publicCardRevision, "pcr_");
    if (
      displaySession === null ||
      deck === null ||
      playbackRevision === null ||
      cardRevision === null ||
      JSON.stringify(displaySession.binding) !== JSON.stringify(projectionInput.binding) ||
      displaySession.binding.deckVersion !== deck.deckVersion ||
      displaySession.binding.manifestHash !== deck.manifestHash ||
      !deck.slides.some((slide) => slide.publicSlideKey === occurrence.publicSlideKey) ||
      store.projections.has(displaySession.binding.presentationSessionId)
    ) {
      return { outcome: "INVALID_SNAPSHOT" };
    }
    const cards = new Map<string, PublicCardUpsert>();
    for (const cardInput of projectionInput.cards) {
      const card = parseStoredCard(cardInput);
      if (card === null) return { outcome: "INVALID_SNAPSHOT" };
      const eventRevision = revisionValue(card.publicCardRevision, "pcr_");
      if (eventRevision === null || eventRevision > cardRevision || cards.has(card.projectionId)) {
        return { outcome: "INVALID_SNAPSHOT" };
      }
      cards.set(card.projectionId, card);
    }
    const tombstones = new Map<string, PublicCardTombstone>();
    for (const tombstoneInput of projectionInput.tombstones) {
      const tombstone = parseStoredTombstone(tombstoneInput);
      if (tombstone === null) return { outcome: "INVALID_SNAPSHOT" };
      const eventRevision = revisionValue(tombstone.publicCardRevision, "pcr_");
      if (
        eventRevision === null ||
        eventRevision > cardRevision ||
        cards.has(tombstone.projectionId) ||
        tombstones.has(tombstone.projectionId)
      ) {
        return { outcome: "INVALID_SNAPSHOT" };
      }
      tombstones.set(tombstone.projectionId, tombstone);
    }
    const representedRevisions = [...cards.values(), ...tombstones.values()].map((event) =>
      revisionValue(event.publicCardRevision, "pcr_"),
    );
    if (
      representedRevisions.some((revision) => revision === null) ||
      (cardRevision === 0
        ? representedRevisions.length !== 0
        : Math.max(...representedRevisions.map((revision) => revision ?? -1)) !== cardRevision)
    ) {
      return { outcome: "INVALID_SNAPSHOT" };
    }
    store.projections.set(displaySession.binding.presentationSessionId, {
      binding: displaySession.binding,
      displaySession,
      deck,
      publicPlaybackRevision: projectionInput.publicPlaybackRevision,
      publicCardRevision: projectionInput.publicCardRevision,
      occurrence,
      blackout: projectionInput.blackout,
      cards,
      tombstones,
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
        | "BINDING_CAS_CONFLICT";
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
  onCard: (event: PublicCardEvent) => void;
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

function revisionValue(revision: unknown, prefix: string): number | null {
  if (typeof revision !== "string" || !revision.startsWith(prefix)) return null;
  const value = Number(revision.slice(prefix.length));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export class PreparedEvidenceProjectionGateway {
  readonly #store: ProjectionGatewayStore;
  readonly #sockets = new Map<string, Set<MutableStageSocket>>();
  readonly #joinTtlMs: number;
  readonly #displaySessionTtlMs: number;
  readonly #tombstoneRetentionMs: number;

  constructor(
    store: ProjectionGatewayStore = createProjectionGatewayStore(),
    options: {
      readonly joinTtlMs?: number;
      readonly displaySessionTtlMs?: number;
      readonly tombstoneRetentionMs?: number;
    } = {},
  ) {
    this.#store = store;
    this.#joinTtlMs = options.joinTtlMs ?? 90_000;
    this.#displaySessionTtlMs = options.displaySessionTtlMs ?? 8 * 60 * 60 * 1_000;
    this.#tombstoneRetentionMs = options.tombstoneRetentionMs ?? 24 * 60 * 60 * 1_000;
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
      publicCardRevision: current?.publicCardRevision ?? "pcr_0",
      occurrence: current?.occurrence ?? {
        publicSlideKey: initialSlide.publicSlideKey,
        occurrenceSeq: 1,
      },
      blackout: current?.blackout ?? false,
      cards: current?.cards ?? new Map(),
      tombstones: current?.tombstones ?? new Map(),
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

  projectPlayback(presentationSessionId: string, event: PlaybackProjection): boolean {
    const projection = this.#store.projections.get(presentationSessionId);
    if (
      projection === undefined ||
      event.displayBindingEpoch !== projection.binding.displayBindingEpoch
    ) {
      return false;
    }
    projection.occurrence = event.occurrence;
    projection.blackout = event.blackout;
    for (const socket of this.#sockets.get(presentationSessionId) ?? []) {
      if (!socket.closed) socket.observer.onPlayback(event);
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

  projectCard(presentationSessionId: string, event: PublicCardEvent): boolean {
    const projection = this.#store.projections.get(presentationSessionId);
    if (projection === undefined) return false;
    if (
      event.status === "PUBLISHED" &&
      event.mode === "LIVE" &&
      (event.leaseExpiresAtMs === undefined ||
        event.leaseExpiresAtMs === null ||
        event.leaseExpiresAtMs <= event.publishedAtMs ||
        event.leaseExpiresAtMs - event.publishedAtMs > 3_000)
    ) {
      return false;
    }
    const current = revisionValue(projection.publicCardRevision, "pcr_");
    const next = revisionValue(event.publicCardRevision, "pcr_");
    if (current === null || next !== current + 1) return false;
    if (projection.tombstones.has(event.projectionId)) return false;
    if (event.status === "PUBLISHED") {
      projection.cards.set(event.projectionId, event);
    } else {
      projection.cards.delete(event.projectionId);
      projection.tombstones.set(event.projectionId, event);
    }
    projection.publicCardRevision = event.publicCardRevision;
    for (const socket of this.#sockets.get(presentationSessionId) ?? []) {
      if (!socket.closed) socket.observer.onCard(event);
    }
    return true;
  }

  snapshot(audienceDisplaySessionId: string, nowMs: number): AudienceProjectionSnapshot | null {
    const projection = Array.from(this.#store.projections.values()).find(
      (candidate) => candidate.displaySession.audienceDisplaySessionId === audienceDisplaySessionId,
    );
    if (projection === undefined || nowMs >= projection.displaySession.expiresAtMs) return null;
    const retainedTombstones = Array.from(projection.tombstones.values()).filter(
      (event) => nowMs - event.occurredAtMs <= this.#tombstoneRetentionMs,
    );
    const earliestRetained = retainedTombstones
      .map((event) => revisionValue(event.publicCardRevision, "pcr_") ?? 0)
      .reduce((minimum, revision) => Math.min(minimum, revision), Number.POSITIVE_INFINITY);
    const watermark = Number.isFinite(earliestRetained) ? Math.max(0, earliestRetained - 1) : 0;
    const absoluteState = {
      role: "PUBLIC_STAGE" as const,
      presentationSessionId: projection.binding.presentationSessionId,
      presentationSessionEpoch: projection.binding.presentationSessionEpoch,
      displayBindingEpoch: projection.binding.displayBindingEpoch,
      publicPlaybackRevision: projection.publicPlaybackRevision,
      publicCardRevision: projection.publicCardRevision,
      deck: projection.deck,
      occurrence: projection.occurrence,
      blackout: projection.blackout,
      cards: Array.from(projection.cards.values()).filter(
        (card) =>
          card.mode !== "LIVE" ||
          (card.leaseExpiresAtMs !== undefined &&
            card.leaseExpiresAtMs !== null &&
            nowMs < card.leaseExpiresAtMs),
      ),
      tombstones: retainedTombstones,
      tombstoneWatermark: `pcr_${watermark}`,
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
