import { useEffect, useState } from "react";
import { playbackRevisionValue, reconnectedSnapshot } from "./projection-state";
import type {
  StageEventObserver,
  StageSessionClient,
  StageSnapshotView,
  StageSubscription,
} from "./stage-client";
import { publishStageEvent } from "./stage-events";
import type { WindowsDisplayMode } from "./windows-topology";

/**
 * Upper bound on automatic snapshot refetches after `impromptu:reconcile-required`. The counter
 * resets only when a contiguous playback command applies again, so a gateway that keeps serving
 * unusable states cannot turn recovery into an endless refetch loop.
 */
export const RECONCILE_RECOVERY_LIMIT = 3;

/**
 * How many times the display re-attempts a channel that will not open before it stops trying and
 * says so on screen. Attempts are already spaced by the channel's own open timeout, so this is a
 * bound on attempts rather than a delay schedule.
 */
export const CONNECT_ATTEMPT_LIMIT = 3;

/**
 * Realtime transport for the public stage: SSE + WebSocket delivery with the verified HTTP
 * receipt as the authoritative fallback, snapshot adoption on connect, and bounded event-driven
 * recovery after revision gaps or epoch changes. Owns the currently projected snapshot and the
 * terminal unavailability reason.
 */
export function useStageSubscription(
  client: StageSessionClient,
  mode: WindowsDisplayMode,
  requestedMode: WindowsDisplayMode,
): {
  readonly snapshot: StageSnapshotView | null;
  readonly unavailable: string | null;
  readonly setSnapshot: React.Dispatch<React.SetStateAction<StageSnapshotView | null>>;
} {
  const [snapshot, setSnapshot] = useState<StageSnapshotView | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let subscription: StageSubscription | null = null;
    let sseSubscription: StageSubscription | null = null;
    let latestSnapshot: StageSnapshotView | null = null;
    let realtimeReconnectAttempts = 0;
    let reconcileRecoveryAttempts = 0;
    let connectAttempts = 0;
    // Playback that arrived before this display held an authoritative snapshot to apply it to.
    let queuedPlayback: Array<Parameters<StageEventObserver["onPlayback"]>[0]> = [];
    let drainQueuedPlayback: (() => void) | null = null;

    /**
     * A revision gap means this display missed causally ordered commands, so the only safe
     * recovery is to re-fetch the authoritative snapshot instead of guessing. The refetch is
     * event-driven — fired by the reconcile transition itself, never a timer — and bounded:
     * the attempt counter resets only when a contiguous command applies again, so repeated
     * failures or unusable snapshots cannot become an infinite refetch loop.
     */
    const recoverFromReconcile = async (): Promise<void> => {
      if (!active || reconcileRecoveryAttempts >= RECONCILE_RECOVERY_LIMIT) return;
      reconcileRecoveryAttempts += 1;
      try {
        const fetched = await client.snapshot();
        if (!active) return;
        const next = reconnectedSnapshot(latestSnapshot, fetched);
        latestSnapshot = next;
        setSnapshot(next);
        publishStageEvent("impromptu:reconcile-recovered", {
          publicPlaybackRevision: next.publicPlaybackRevision,
        });
        publishStageEvent("impromptu:snapshot-applied", {
          stateHash: next.stateHash,
          publicPlaybackRevision: next.publicPlaybackRevision,
        });
        drainQueuedPlayback?.();
      } catch {
        // Stay RECOVERING; the attempt counter above bounds repeated failures.
      }
    };

    const connect = async (pins?: StageSnapshotView): Promise<void> => {
      try {
        const applyPlayback = (
          event: Parameters<StageEventObserver["onPlayback"]>[0],
          current: StageSnapshotView,
        ): void => {
          if (
            event.presentationSessionEpoch !== current.presentationSessionEpoch ||
            event.displayBindingEpoch !== current.displayBindingEpoch
          ) {
            setSnapshot(null);
            latestSnapshot = null;
            publishStageEvent("impromptu:reconcile-required", { reason: "EPOCH_CHANGED" });
            void recoverFromReconcile();
            return;
          }
          const currentRevision = playbackRevisionValue(current.publicPlaybackRevision);
          const nextRevision = playbackRevisionValue(event.publicPlaybackRevision);
          if (nextRevision === currentRevision + 1) {
            const next = {
              ...current,
              publicPlaybackRevision: event.publicPlaybackRevision,
              occurrence: event.occurrence,
              blackout: event.blackout,
            };
            latestSnapshot = next;
            setSnapshot(next);
            reconcileRecoveryAttempts = 0;
            publishStageEvent("impromptu:visible-playback", {
              commandId: event.commandId,
              occurrence: event.occurrence,
            });
          } else if (nextRevision !== currentRevision) {
            setSnapshot(null);
            latestSnapshot = null;
            publishStageEvent("impromptu:reconcile-required", { reason: "REVISION_GAP" });
            void recoverFromReconcile();
            return;
          }
          const recordOverHttp = () =>
            client
              .recordApplied(event)
              .then((receipt) => publishStageEvent("impromptu:playback-applied", receipt))
              .catch(() =>
                publishStageEvent("impromptu:channel-close", { reason: "RECEIPT_REJECTED" }),
              );
          if (subscription?.recordApplied !== undefined) {
            try {
              subscription.recordApplied(event);
            } catch {
              // The verified HTTP receipt remains authoritative when WSS closes mid-frame.
            }
          }
          void recordOverHttp();
        };
        drainQueuedPlayback = () => {
          const queued = queuedPlayback;
          queuedPlayback = [];
          for (const queuedEvent of queued) {
            const base = latestSnapshot;
            if (base !== null) applyPlayback(queuedEvent, base);
          }
        };
        const observer: StageEventObserver = {
          onPlayback(event) {
            if (!active) return;
            const current = latestSnapshot;
            if (current === null) {
              // The subscription is deliberately opened before the snapshot is fetched, so
              // playback can land in between. Discarding it here also discarded its receipt, and
              // the controller then held that command pending forever: every later receipt came
              // back OUT_OF_ORDER, the public playback revision never advanced, and the audience
              // display froze one slide later while the console still reported every command as
              // delivered. Hold it until there is a snapshot to apply it against.
              queuedPlayback.push(event);
              return;
            }
            applyPlayback(event, current);
          },
          onProtocolError(code) {
            publishStageEvent("impromptu:channel-close", { reason: code });
          },
          onReceipt(receipt) {
            realtimeReconnectAttempts = 0;
            publishStageEvent("impromptu:playback-applied", receipt);
          },
          onClose(reason) {
            if (!active) return;
            publishStageEvent("impromptu:channel-close", { reason });
            subscription = null;
            if (realtimeReconnectAttempts < 1) {
              realtimeReconnectAttempts += 1;
              void connect(latestSnapshot ?? undefined);
            }
          },
        };
        if (client.subscribeRealtime !== undefined) {
          if (sseSubscription === null) sseSubscription = await client.subscribe(observer);
        } else {
          subscription = await client.subscribe(observer);
        }
        if (!active) {
          subscription?.close();
          return;
        }
        const fetched = await client.snapshot(pins);
        if (!active) return;
        const next = reconnectedSnapshot(latestSnapshot, fetched);
        latestSnapshot = next;
        setSnapshot(next);
        connectAttempts = 0;
        setUnavailable(null);
        publishStageEvent("impromptu:stage-ready", { requestedMode, observedMode: mode });
        publishStageEvent("impromptu:snapshot-applied", {
          stateHash: next.stateHash,
          publicPlaybackRevision: next.publicPlaybackRevision,
        });
        drainQueuedPlayback();
        if (client.subscribeRealtime !== undefined) {
          subscription = await client.subscribeRealtime(observer);
          if (!active) subscription.close();
        }
      } catch (error) {
        subscription?.close();
        subscription = null;
        if (!active) return;
        if (error instanceof Error && error.message === "RECONCILE_REQUIRED") {
          setSnapshot(null);
          latestSnapshot = null;
          publishStageEvent("impromptu:reconcile-required", { reason: "PIN_MISMATCH" });
          void recoverFromReconcile();
          return;
        }
        // Every other failure used to land here and stop, which is how a display that never
        // opened its channel sat in front of a room showing a waiting screen and telling nobody.
        const reason = error instanceof Error ? error.message : "UNKNOWN";
        publishStageEvent("impromptu:stage-unavailable", { reason, attempt: connectAttempts + 1 });
        if (connectAttempts < CONNECT_ATTEMPT_LIMIT) {
          connectAttempts += 1;
          void connect(latestSnapshot ?? undefined);
          return;
        }
        setUnavailable(reason);
      }
    };
    const reconnectWhenOnline = () => {
      if (!active) return;
      subscription?.close();
      subscription = null;
      void connect(latestSnapshot ?? undefined);
    };
    window.addEventListener("online", reconnectWhenOnline);
    void connect();
    return () => {
      active = false;
      window.removeEventListener("online", reconnectWhenOnline);
      subscription?.close();
      sseSubscription?.close();
    };
  }, [client, mode, requestedMode]);

  return { snapshot, unavailable, setSnapshot };
}
