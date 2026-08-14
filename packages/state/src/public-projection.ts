import type { AudienceSnapshot, PublicSlideOccurrence } from "@impromptu/contracts";

export type PublicPlaybackState = Readonly<{
  presentationSessionId: string;
  presentationSessionEpoch: number;
  displayBindingEpoch: number;
  deckVersion: string;
  manifestHash: string;
  publicPlaybackRevision: number;
  occurrence: PublicSlideOccurrence;
  blackout: boolean;
}>;

export type PublicPlaybackEvent = PublicPlaybackState;
export type PublicPlaybackSnapshot = PublicPlaybackState;

export type InitialPublicPlaybackState = Omit<PublicPlaybackState, "publicPlaybackRevision">;

export function initialPublicPlaybackState(input: InitialPublicPlaybackState): PublicPlaybackState {
  return { ...input, publicPlaybackRevision: 0 };
}

export type PublicPlaybackOutcome =
  | "APPLIED"
  | "DUPLICATE"
  | "GAP_REQUIRES_SNAPSHOT"
  | "STALE_OR_CONFLICTING"
  | "STALE_CAUSAL_ENVELOPE"
  | "STALE_SNAPSHOT";

export type PublicPlaybackResult = Readonly<{
  state: PublicPlaybackState;
  outcome: PublicPlaybackOutcome;
}>;

function sameCausalIdentity(state: PublicPlaybackState, incoming: PublicPlaybackState): boolean {
  return (
    state.presentationSessionId === incoming.presentationSessionId &&
    state.presentationSessionEpoch === incoming.presentationSessionEpoch &&
    state.displayBindingEpoch === incoming.displayBindingEpoch &&
    state.deckVersion === incoming.deckVersion &&
    state.manifestHash === incoming.manifestHash
  );
}

function sameVisibleState(state: PublicPlaybackState, incoming: PublicPlaybackState): boolean {
  return (
    state.occurrence.publicSlideKey === incoming.occurrence.publicSlideKey &&
    state.occurrence.occurrenceSeq === incoming.occurrence.occurrenceSeq &&
    state.blackout === incoming.blackout
  );
}

export function applyPublicPlaybackEvent(
  state: PublicPlaybackState,
  event: PublicPlaybackEvent,
): PublicPlaybackResult {
  if (!sameCausalIdentity(state, event)) {
    return { state, outcome: "STALE_CAUSAL_ENVELOPE" };
  }
  if (event.publicPlaybackRevision === state.publicPlaybackRevision) {
    return {
      state,
      outcome: sameVisibleState(state, event) ? "DUPLICATE" : "STALE_OR_CONFLICTING",
    };
  }
  if (event.publicPlaybackRevision < state.publicPlaybackRevision) {
    return { state, outcome: "STALE_OR_CONFLICTING" };
  }
  if (event.publicPlaybackRevision !== state.publicPlaybackRevision + 1) {
    return { state, outcome: "GAP_REQUIRES_SNAPSHOT" };
  }
  return { state: structuredClone(event), outcome: "APPLIED" };
}

export function applyAudiencePlaybackSnapshot(
  state: PublicPlaybackState,
  snapshot: AudienceSnapshot,
): PublicPlaybackResult {
  return applyPublicPlaybackSnapshot(state, {
    presentationSessionId: snapshot.presentationSessionId,
    presentationSessionEpoch: snapshot.presentationSessionEpoch,
    displayBindingEpoch: snapshot.displayBindingEpoch,
    deckVersion: snapshot.deck.deckVersion,
    manifestHash: snapshot.deck.manifestHash,
    publicPlaybackRevision: snapshot.publicPlaybackRevision,
    occurrence: snapshot.occurrence,
    blackout: snapshot.blackout,
  });
}

export function applyPublicPlaybackSnapshot(
  state: PublicPlaybackState,
  snapshot: PublicPlaybackSnapshot,
): PublicPlaybackResult {
  if (snapshot.presentationSessionId !== state.presentationSessionId) {
    return { state, outcome: "STALE_CAUSAL_ENVELOPE" };
  }
  if (snapshot.presentationSessionEpoch < state.presentationSessionEpoch) {
    return { state, outcome: "STALE_SNAPSHOT" };
  }
  if (
    snapshot.presentationSessionEpoch === state.presentationSessionEpoch &&
    !sameCausalIdentity(state, snapshot)
  ) {
    return { state, outcome: "STALE_CAUSAL_ENVELOPE" };
  }
  if (
    snapshot.presentationSessionEpoch === state.presentationSessionEpoch &&
    snapshot.publicPlaybackRevision < state.publicPlaybackRevision
  ) {
    return { state, outcome: "STALE_SNAPSHOT" };
  }
  return { state: structuredClone(snapshot), outcome: "APPLIED" };
}
