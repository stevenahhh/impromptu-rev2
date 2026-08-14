import type {
  AudienceSnapshot,
  DeckVersionId,
  DisplayBindingEpoch,
  PresentationSessionEpoch,
  PresentationSessionId,
  PublicPlaybackRevision,
  PublicSlideOccurrence,
} from "@impromptu/contracts/public";
import {
  presentationSessionEpochValue,
  publicPlaybackRevision,
  publicPlaybackRevisionValue,
} from "@impromptu/contracts/public";

export type PublicPlaybackState = Readonly<{
  presentationSessionId: PresentationSessionId;
  presentationSessionEpoch: PresentationSessionEpoch;
  displayBindingEpoch: DisplayBindingEpoch;
  deckVersion: DeckVersionId;
  manifestHash: string;
  publicPlaybackRevision: PublicPlaybackRevision;
  occurrence: PublicSlideOccurrence;
  blackout: boolean;
}>;

export type PublicPlaybackEvent = PublicPlaybackState;
export type PublicPlaybackSnapshot = PublicPlaybackState;
export type InitialPublicPlaybackState = Omit<PublicPlaybackState, "publicPlaybackRevision">;

export function initialPublicPlaybackState(input: InitialPublicPlaybackState): PublicPlaybackState {
  return { ...input, publicPlaybackRevision: publicPlaybackRevision(0) };
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
  const currentRevision = publicPlaybackRevisionValue(state.publicPlaybackRevision);
  const eventRevision = publicPlaybackRevisionValue(event.publicPlaybackRevision);
  if (eventRevision === currentRevision) {
    return {
      state,
      outcome: sameVisibleState(state, event) ? "DUPLICATE" : "STALE_OR_CONFLICTING",
    };
  }
  if (eventRevision < currentRevision) {
    return { state, outcome: "STALE_OR_CONFLICTING" };
  }
  if (eventRevision !== currentRevision + 1) {
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
  if (
    presentationSessionEpochValue(snapshot.presentationSessionEpoch) <
    presentationSessionEpochValue(state.presentationSessionEpoch)
  ) {
    return { state, outcome: "STALE_SNAPSHOT" };
  }
  if (
    snapshot.presentationSessionEpoch === state.presentationSessionEpoch &&
    !sameCausalIdentity(state, snapshot)
  ) {
    return { state, outcome: "STALE_CAUSAL_ENVELOPE" };
  }
  if (snapshot.presentationSessionEpoch === state.presentationSessionEpoch) {
    const snapshotRevision = publicPlaybackRevisionValue(snapshot.publicPlaybackRevision);
    const currentRevision = publicPlaybackRevisionValue(state.publicPlaybackRevision);
    if (snapshotRevision < currentRevision) {
      return { state, outcome: "STALE_SNAPSHOT" };
    }
    if (snapshotRevision === currentRevision) {
      return {
        state,
        outcome: sameVisibleState(state, snapshot) ? "DUPLICATE" : "STALE_OR_CONFLICTING",
      };
    }
  }
  return { state: structuredClone(snapshot), outcome: "APPLIED" };
}
