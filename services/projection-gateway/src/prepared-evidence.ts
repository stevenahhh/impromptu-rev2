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

type JoinState = { readonly locator: DisplayJoinLocator; consumed: boolean };
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

function revisionValue(revision: string, prefix: string): number | null {
  if (!revision.startsWith(prefix)) return null;
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
    this.#store.joins.set(locator.displayJoinId, { locator, consumed: false });
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
    return {
      presentationSessionId: projection.binding.presentationSessionId,
      presentationSessionEpoch: projection.binding.presentationSessionEpoch,
      displayBindingEpoch: projection.binding.displayBindingEpoch,
      publicPlaybackRevision: projection.publicPlaybackRevision,
      publicCardRevision: projection.publicCardRevision,
      deck: projection.deck,
      occurrence: projection.occurrence,
      blackout: projection.blackout,
      cards: Array.from(projection.cards.values()),
      tombstones: retainedTombstones,
      tombstoneWatermark: `pcr_${watermark}`,
      tombstoneRetentionMs: this.#tombstoneRetentionMs,
    };
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
