import { AudienceSnapshotSchema, publicCardRevisionValue } from "@impromptu/contracts/public";
import { type PublicCardStreamState, publicCardStreamFromSnapshot } from "./public-card-stream.ts";
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
  cards: PublicCardStreamState;
  outcome: AudienceRoleRestoreOutcome;
}>;

function comparableCards(state: PublicCardStreamState): string {
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
  cards: PublicCardStreamState,
  input: unknown,
  requestedRole: unknown,
): AudienceRoleRestoreResult {
  const parsed = AudienceSnapshotSchema.safeParse(input);
  if (!parsed.success) return { playback, cards, outcome: "INVALID_SNAPSHOT" };
  const snapshot = parsed.data;
  if (requestedRole !== "PUBLIC_STAGE" || snapshot.role !== requestedRole) {
    return { playback, cards, outcome: "UNAUTHORIZED_ROLE" };
  }
  if (
    snapshot.presentationSessionId !== cards.presentationSessionId ||
    snapshot.presentationSessionEpoch !== cards.presentationSessionEpoch
  ) {
    return { playback, cards, outcome: "CONFLICTING_SNAPSHOT" };
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

  const currentCardRevision = publicCardRevisionValue(cards.publicCardRevision);
  const snapshotCardRevision = publicCardRevisionValue(snapshot.publicCardRevision);
  if (snapshotCardRevision < currentCardRevision) {
    return { playback, cards, outcome: "STALE_SNAPSHOT" };
  }
  const restoredCards = publicCardStreamFromSnapshot(cards, snapshot);
  if (
    snapshotCardRevision === currentCardRevision &&
    comparableCards(restoredCards) !== comparableCards(cards)
  ) {
    return { playback, cards, outcome: "CONFLICTING_SNAPSHOT" };
  }

  const cardsChanged = snapshotCardRevision > currentCardRevision;
  const playbackChanged = playbackResult.outcome === "APPLIED";
  return {
    playback: playbackResult.state,
    cards: cardsChanged ? restoredCards : cards,
    outcome: playbackChanged || cardsChanged ? "APPLIED" : "DUPLICATE",
  };
}
