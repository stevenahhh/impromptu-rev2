export const LIVE_CARD_MAX_LEASE_MS = 3_000;

export type RealtimeIdentity = Readonly<{
  presentationSessionId: string;
  presentationSessionEpoch: string;
  displayBindingEpoch: string;
  deckVersion: string;
  manifestHash: string;
}>;

export type RealtimeCard = Readonly<{
  projectionId: string;
  mode: "LIVE" | "CURATED";
  leaseExpiresAtMs: number | null;
  publicCardRevision: string;
  offlinePackage?: Readonly<{
    offlineDisplayAllowed: boolean;
    localExpiresAtMs: number;
    signatureVerified: boolean;
  }>;
}>;

export type RealtimeSnapshot = RealtimeIdentity &
  Readonly<{
    role: "PUBLIC_STAGE";
    stateHash: string;
    publicPlaybackRevision: string;
    publicCardRevision: string;
    occurrence: Readonly<{ publicSlideKey: string; occurrenceSeq: number }>;
    blackout: boolean;
    cards: readonly RealtimeCard[];
  }>;

export type RealtimeConnection =
  | "CONNECTED"
  | "PARTITIONED"
  | "RECONCILING"
  | "RECONCILE_REQUIRED";

export type RealtimeStageState = RealtimeIdentity &
  Readonly<{
    connection: RealtimeConnection;
    publicPlaybackRevision: string;
    publicCardRevision: string;
    occurrence: Readonly<{ publicSlideKey: string; occurrenceSeq: number }>;
    blackout: boolean;
    cards: Readonly<Record<string, RealtimeCard>>;
    visibleCardIds: readonly string[];
    appliedCommandIds: readonly string[];
    controllerEpoch: string | null;
  }>;

export type RealtimeHideReason =
  | "EXPLICIT_ERROR"
  | "TOMBSTONE"
  | "STALE_EVENT"
  | "EPOCH_CHANGED"
  | "LEASE_EXPIRED"
  | "PARTITION"
  | "STALE_SNAPSHOT"
  | "RECONCILE_REQUIRED";

export type RealtimeEffect =
  | Readonly<{ type: "HIDE_CARD"; projectionId: string; reason: RealtimeHideReason }>
  | Readonly<{ type: "HIDE_DYNAMIC_CARDS"; reason: RealtimeHideReason }>
  | Readonly<{ type: "REQUEST_PINNED_SNAPSHOT" }>;

export type RealtimeTransition =
  | Readonly<{ type: "PARTITION"; reason: "NETWORK_ERROR" | "SERVER_ERROR"; nowMs?: number }>
  | Readonly<{ type: "RECONNECT" }>
  | Readonly<{ type: "CLOCK"; nowMs: number }>
  | Readonly<{ type: "EXPLICIT_HIDE"; reason: "EXPLICIT_ERROR" | "TOMBSTONE" | "STALE_EVENT"; projectionId?: string }>
  | Readonly<{ type: "EPOCH_CHANGED"; presentationSessionEpoch: string; displayBindingEpoch: string }>
  | Readonly<{ type: "CONTROLLER_EPOCH_CHANGED"; controllerEpoch: string }>
  | Readonly<{ type: "CARD_UPSERT"; card: RealtimeCard; nowMs: number }>
  | Readonly<{ type: "CARD_TOMBSTONE"; projectionId: string }>
  | Readonly<{
      type: "ABSOLUTE_PLAYBACK";
      commandId: string;
      presentationSessionEpoch: string;
      displayBindingEpoch: string;
      publicPlaybackRevision: string;
      occurrence: Readonly<{ publicSlideKey: string; occurrenceSeq: number }>;
      blackout: boolean;
    }>
  | Readonly<{ type: "RELATIVE_REPLAY"; commandId: string; offset: -1 | 1 }>
  | Readonly<{ type: "SNAPSHOT"; snapshot: RealtimeSnapshot; verifiedStateHash: string }>;

export type RealtimeTransitionOutcome =
  | "APPLIED"
  | "DUPLICATE"
  | "STALE_EPOCH"
  | "STALE_EVENT"
  | "INVALID_LEASE"
  | "REJECTED_RELATIVE_REPLAY"
  | "RECONCILE_REQUIRED";

export type RealtimeTransitionResult = Readonly<{
  state: RealtimeStageState;
  outcome: RealtimeTransitionOutcome;
  effects: readonly RealtimeEffect[];
}>;

function revision(value: string, prefix: string): number {
  if (!value.startsWith(prefix)) return -1;
  const parsed = Number(value.slice(prefix.length));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : -1;
}

function sameIdentity(left: RealtimeIdentity, right: RealtimeIdentity): boolean {
  return (
    left.presentationSessionId === right.presentationSessionId &&
    left.presentationSessionEpoch === right.presentationSessionEpoch &&
    left.displayBindingEpoch === right.displayBindingEpoch &&
    left.deckVersion === right.deckVersion &&
    left.manifestHash === right.manifestHash
  );
}

function canPersistOffline(card: RealtimeCard, nowMs: number): boolean {
  const offline = card.offlinePackage;
  return (
    card.mode === "CURATED" &&
    offline?.offlineDisplayAllowed === true &&
    offline.signatureVerified &&
    nowMs < offline.localExpiresAtMs
  );
}

function hideCards(
  state: RealtimeStageState,
  predicate: (card: RealtimeCard) => boolean,
  reason: RealtimeHideReason,
): RealtimeTransitionResult {
  const hidden = state.visibleCardIds.filter((id) => {
    const card = state.cards[id];
    return card !== undefined && predicate(card);
  });
  if (hidden.length === 0) return { state, outcome: "DUPLICATE", effects: [] };
  return {
    state: {
      ...state,
      visibleCardIds: state.visibleCardIds.filter((id) => !hidden.includes(id)),
    },
    outcome: "APPLIED",
    effects: hidden.map((projectionId) => ({ type: "HIDE_CARD", projectionId, reason })),
  };
}

export function createRealtimeStageState(
  identity: RealtimeIdentity,
  occurrence: Readonly<{ publicSlideKey: string; occurrenceSeq: number }>,
): RealtimeStageState {
  return {
    ...identity,
    connection: "CONNECTED",
    publicPlaybackRevision: "pbr_0",
    publicCardRevision: "pcr_0",
    occurrence,
    blackout: false,
    cards: {},
    visibleCardIds: [],
    appliedCommandIds: [],
    controllerEpoch: null,
  };
}

export function applyRealtimeTransition(
  state: RealtimeStageState,
  transition: RealtimeTransition,
): RealtimeTransitionResult {
  if (transition.type === "RELATIVE_REPLAY") {
    return { state, outcome: "REJECTED_RELATIVE_REPLAY", effects: [] };
  }
  if (transition.type === "CONTROLLER_EPOCH_CHANGED") {
    return {
      state: { ...state, controllerEpoch: transition.controllerEpoch },
      outcome: state.controllerEpoch === transition.controllerEpoch ? "DUPLICATE" : "APPLIED",
      effects: [],
    };
  }
  if (transition.type === "RECONNECT") {
    return {
      state: { ...state, connection: "RECONCILING" },
      outcome: "APPLIED",
      effects: [{ type: "REQUEST_PINNED_SNAPSHOT" }],
    };
  }
  if (transition.type === "PARTITION") {
    const nowMs = transition.nowMs ?? Number.POSITIVE_INFINITY;
    const visibleCardIds = state.visibleCardIds.filter((id) => {
      const card = state.cards[id];
      return card !== undefined && canPersistOffline(card, nowMs);
    });
    const hidden = state.visibleCardIds.filter((id) => !visibleCardIds.includes(id));
    return {
      state: { ...state, connection: "PARTITIONED", visibleCardIds },
      outcome: "APPLIED",
      effects: hidden.map((projectionId) => ({ type: "HIDE_CARD", projectionId, reason: "PARTITION" })),
    };
  }
  if (transition.type === "CLOCK") {
    return hideCards(
      state,
      (card) =>
        (card.mode === "LIVE" && card.leaseExpiresAtMs !== null && transition.nowMs >= card.leaseExpiresAtMs) ||
        (state.connection !== "CONNECTED" &&
          card.mode === "CURATED" &&
          !canPersistOffline(card, transition.nowMs)),
      "LEASE_EXPIRED",
    );
  }
  if (transition.type === "EXPLICIT_HIDE") {
    return hideCards(
      state,
      (card) => transition.projectionId === undefined || card.projectionId === transition.projectionId,
      transition.reason,
    );
  }
  if (transition.type === "CARD_TOMBSTONE") {
    return hideCards(state, (card) => card.projectionId === transition.projectionId, "TOMBSTONE");
  }
  if (transition.type === "EPOCH_CHANGED") {
    const changed =
      transition.presentationSessionEpoch !== state.presentationSessionEpoch ||
      transition.displayBindingEpoch !== state.displayBindingEpoch;
    if (!changed) return { state, outcome: "DUPLICATE", effects: [] };
    return {
      state: { ...state, connection: "RECONCILE_REQUIRED", visibleCardIds: [] },
      outcome: "RECONCILE_REQUIRED",
      effects: [{ type: "HIDE_DYNAMIC_CARDS", reason: "EPOCH_CHANGED" }],
    };
  }
  if (transition.type === "CARD_UPSERT") {
    const cardRevision = revision(transition.card.publicCardRevision, "pcr_");
    if (cardRevision <= revision(state.publicCardRevision, "pcr_")) {
      return { state, outcome: "STALE_EVENT", effects: [] };
    }
    if (
      transition.card.mode === "LIVE" &&
      (transition.card.leaseExpiresAtMs === null ||
        transition.card.leaseExpiresAtMs <= transition.nowMs ||
        transition.card.leaseExpiresAtMs - transition.nowMs > LIVE_CARD_MAX_LEASE_MS)
    ) {
      return { state, outcome: "INVALID_LEASE", effects: [] };
    }
    return {
      state: {
        ...state,
        publicCardRevision: transition.card.publicCardRevision,
        cards: { ...state.cards, [transition.card.projectionId]: transition.card },
        visibleCardIds: [
          ...state.visibleCardIds.filter((id) => id !== transition.card.projectionId),
          transition.card.projectionId,
        ],
      },
      outcome: "APPLIED",
      effects: [],
    };
  }
  if (transition.type === "ABSOLUTE_PLAYBACK") {
    if (
      transition.presentationSessionEpoch !== state.presentationSessionEpoch ||
      transition.displayBindingEpoch !== state.displayBindingEpoch
    ) {
      return { state, outcome: "STALE_EPOCH", effects: [] };
    }
    if (state.appliedCommandIds.includes(transition.commandId)) {
      return { state, outcome: "DUPLICATE", effects: [] };
    }
    if (revision(transition.publicPlaybackRevision, "pbr_") !== revision(state.publicPlaybackRevision, "pbr_") + 1) {
      return { state, outcome: "STALE_EVENT", effects: [] };
    }
    return {
      state: {
        ...state,
        publicPlaybackRevision: transition.publicPlaybackRevision,
        occurrence: transition.occurrence,
        blackout: transition.blackout,
        appliedCommandIds: [...state.appliedCommandIds, transition.commandId],
      },
      outcome: "APPLIED",
      effects: [],
    };
  }

  const incoming = transition.snapshot;
  const invalid =
    incoming.role !== "PUBLIC_STAGE" ||
    incoming.stateHash !== transition.verifiedStateHash ||
    !sameIdentity(state, incoming) ||
    revision(incoming.publicPlaybackRevision, "pbr_") < revision(state.publicPlaybackRevision, "pbr_") ||
    revision(incoming.publicCardRevision, "pcr_") < revision(state.publicCardRevision, "pcr_");
  if (invalid) {
    return {
      state: { ...state, connection: "RECONCILE_REQUIRED", visibleCardIds: [] },
      outcome: "RECONCILE_REQUIRED",
      effects: [{ type: "HIDE_DYNAMIC_CARDS", reason: sameIdentity(state, incoming) ? "STALE_SNAPSHOT" : "RECONCILE_REQUIRED" }],
    };
  }
  const cards = Object.fromEntries(incoming.cards.map((card) => [card.projectionId, card]));
  return {
    state: {
      ...state,
      connection: "CONNECTED",
      publicPlaybackRevision: incoming.publicPlaybackRevision,
      publicCardRevision: incoming.publicCardRevision,
      occurrence: incoming.occurrence,
      blackout: incoming.blackout,
      cards,
      visibleCardIds: incoming.cards.map((card) => card.projectionId),
    },
    outcome: "APPLIED",
    effects: [],
  };
}
