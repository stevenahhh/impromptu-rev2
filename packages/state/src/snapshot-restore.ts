import { AudienceSnapshotSchema, publicCardRevisionValue } from "@impromptu/contracts/public";
import {
  type AudienceCardSnapshotState,
  restoreAudienceCardSnapshotState,
} from "./audience-card-state.ts";
import { applyAudiencePlaybackSnapshot, type PublicPlaybackState } from "./public-projection.ts";

export type AudienceRoleRestoreOutcome =
  | "APPLIED"
  | "DUPLICATE"
  | "INVALID_SNAPSHOT"
  | "UNAUTHORIZED_ROLE"
  | "STALE_SNAPSHOT"
  | "CONFLICTING_SNAPSHOT";

export type AudienceRoleRestoreResult = Readonly<{
  playback: PublicPlaybackState;
  cards: AudienceCardSnapshotState;
  outcome: AudienceRoleRestoreOutcome;
}>;

function comparableCards(state: AudienceCardSnapshotState): string {
  const cards = Object.values(state.cards).sort((left, right) =>
    left.projectionId.localeCompare(right.projectionId),
  );
  const tombstones = Object.values(state.tombstones).sort((left, right) =>
    left.projectionId.localeCompare(right.projectionId),
  );
  return JSON.stringify({
    publicCardRevision: state.publicCardRevision,
    tombstoneWatermark: state.tombstoneWatermark,
    cards,
    tombstones,
  });
}

export function restoreAudienceRoleStreams(
  playback: PublicPlaybackState,
  cards: AudienceCardSnapshotState,
  input: unknown,
  requestedRole: unknown,
): AudienceRoleRestoreResult {
  const parsedCards = restoreAudienceCardSnapshotState(cards);
  if (parsedCards.outcome !== "RESTORED") {
    return { playback, cards, outcome: "INVALID_SNAPSHOT" };
  }
  const currentCards = parsedCards.state;
  const parsed = AudienceSnapshotSchema.safeParse(input);
  if (!parsed.success) return { playback, cards: currentCards, outcome: "INVALID_SNAPSHOT" };
  const snapshot = parsed.data;
  if (requestedRole !== "PUBLIC_STAGE" || snapshot.role !== requestedRole) {
    return { playback, cards, outcome: "UNAUTHORIZED_ROLE" };
  }
  if (
    snapshot.presentationSessionId !== currentCards.presentationSessionId ||
    snapshot.presentationSessionEpoch !== currentCards.presentationSessionEpoch
  ) {
    return { playback, cards: currentCards, outcome: "CONFLICTING_SNAPSHOT" };
  }

  const playbackResult = applyAudiencePlaybackSnapshot(playback, snapshot);
  if (playbackResult.outcome === "STALE_SNAPSHOT") {
    return { playback, cards, outcome: "STALE_SNAPSHOT" };
  }
  if (
    playbackResult.outcome === "STALE_CAUSAL_ENVELOPE" ||
    playbackResult.outcome === "STALE_OR_CONFLICTING"
  ) {
    return { playback, cards, outcome: "CONFLICTING_SNAPSHOT" };
  }

  const currentCardRevision = publicCardRevisionValue(currentCards.publicCardRevision);
  const snapshotCardRevision = publicCardRevisionValue(snapshot.publicCardRevision);
  if (snapshotCardRevision < currentCardRevision) {
    return { playback, cards: currentCards, outcome: "STALE_SNAPSHOT" };
  }
  const restoredCards = restoreAudienceCardSnapshotState({
    presentationSessionId: snapshot.presentationSessionId,
    presentationSessionEpoch: snapshot.presentationSessionEpoch,
    publicCardRevision: snapshot.publicCardRevision,
    tombstoneWatermark: snapshot.tombstoneWatermark,
    cards: Object.fromEntries(snapshot.cards.map((card) => [card.projectionId, card])),
    tombstones: Object.fromEntries(
      snapshot.tombstones.map((tombstone) => [tombstone.projectionId, tombstone]),
    ),
  });
  if (restoredCards.outcome !== "RESTORED") {
    return { playback, cards, outcome: "INVALID_SNAPSHOT" };
  }
  if (
    snapshotCardRevision === currentCardRevision &&
    comparableCards(restoredCards.state) !== comparableCards(currentCards)
  ) {
    return { playback, cards: currentCards, outcome: "CONFLICTING_SNAPSHOT" };
  }

  const cardsChanged = snapshotCardRevision > currentCardRevision;
  const playbackChanged = playbackResult.outcome === "APPLIED";
  return {
    playback: playbackResult.state,
    cards: cardsChanged ? restoredCards.state : currentCards,
    outcome: playbackChanged || cardsChanged ? "APPLIED" : "DUPLICATE",
  };
}
