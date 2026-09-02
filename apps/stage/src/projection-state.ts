import type { StageSnapshotView } from "./stage-client";

export function playbackRevisionValue(revision: string): number {
  if (!revision.startsWith("pbr_")) return -1;
  const value = Number(revision.slice(4));
  return Number.isSafeInteger(value) && value >= 0 ? value : -1;
}

/**
 * The projection gateway only records a public playback revision once this display's receipt
 * round-trips, so a snapshot fetched while a receipt is still in flight can lag the revision the
 * display already applied. Adopting that lagging snapshot would turn the next projected command
 * into a false revision gap and strand the display, so keep the applied state whenever the fetched
 * snapshot belongs to the same binding and is behind it.
 */
export function reconnectedSnapshot(
  applied: StageSnapshotView | null,
  fetched: StageSnapshotView,
): StageSnapshotView {
  if (applied === null) return fetched;
  const sameBinding =
    applied.presentationSessionId === fetched.presentationSessionId &&
    applied.presentationSessionEpoch === fetched.presentationSessionEpoch &&
    applied.displayBindingEpoch === fetched.displayBindingEpoch;
  return sameBinding &&
    playbackRevisionValue(fetched.publicPlaybackRevision) <
      playbackRevisionValue(applied.publicPlaybackRevision)
    ? applied
    : fetched;
}
