import { type PublishedSlideRuntime, PublishedSlideRuntimeSchema } from "@impromptu/contracts";
import { Button, loadVerifiedSvg, rebaseDeckAssetUrl } from "@impromptu/ui";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import copy from "./locales/ko.json";
import { RenderedSlidePlayer, type RenderedSlidePlayerHandle } from "./rendered-slide-player";
import {
  createStageSessionClient,
  type DisplayJoinView,
  type StageEventObserver,
  type StageSessionClient,
  type StageSnapshotView,
  type StageSubscription,
} from "./stage-client";
import {
  emergencyPublicSlideSet,
  manualPlacementSummary,
  observeWindowsTopology,
  placeStageOnTargetScreen,
  recoverTargetScreenLoss,
  type ScreenDetailsLike,
  type ScreenLike,
  windowsDisplayMode,
} from "./windows-topology";

const STAGE_PUBLIC_API_ORIGIN = import.meta.env.STAGE_PUBLIC_API_ORIGIN ?? "";

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
 * How long the drive controls stay on screen after the last local pointer move or key press
 * before the surface returns to slide-only. Long enough to aim, short enough that a projector
 * never sits on visible chrome.
 */
export const CHROME_HIDE_IDLE_MS = 2_000;

function publishStageEvent(name: string, detail: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export function normalizeDeckAssetUrl(url: string) {
  return rebaseDeckAssetUrl(url, STAGE_PUBLIC_API_ORIGIN);
}

function renderedSlideRuntime(
  slide: StageSnapshotView["deckSlides"][number],
): PublishedSlideRuntime | null {
  if (!new URL(slide.imageUrl, window.location.href).pathname.toLowerCase().endsWith(".svg")) {
    return null;
  }
  const parsed = PublishedSlideRuntimeSchema.safeParse(slide.runtime);
  return parsed.success && parsed.data.timeline.slide_key === slide.publicSlideKey
    ? parsed.data
    : null;
}

function LandingPage({ client }: { readonly client: StageSessionClient }) {
  const navigate = useNavigate();
  const identity = useMemo(
    () => ({
      displayId: `display_${crypto.randomUUID().replaceAll("-", "")}`,
      displayFingerprint: `stage-browser-${crypto.randomUUID()}`,
    }),
    [],
  );
  const deckVersion = new URL(window.location.href).searchParams.get("deck") ?? "deck_alpha";
  // When the Console opened this window, the join is handed straight back to it and approval
  // happens over there. Without an opener (second device, blocked popup) the manual connection
  // code below remains the path.
  const consoleOrigin = useMemo(() => {
    try {
      const origin = new URL(document.referrer, window.location.href).origin;
      return origin === window.location.origin ? null : origin;
    } catch {
      return null;
    }
  }, []);
  const openedByConsole =
    consoleOrigin !== null && window.opener !== null && window.opener !== undefined;
  const [join, setJoin] = useState<DisplayJoinView | null>(null);
  const [failed, setFailed] = useState(false);
  const [message, setMessage] = useState(copy.waitingApproval);

  useEffect(() => {
    // Product decision: a Stage window the Console did not open must stay completely inert — no
    // join creation, no codes, no claim affordance — because otherwise anyone holding the bare
    // URL could put a screen into the pairing flow. Binding only ever starts console-led.
    if (!openedByConsole) return;
    let active = true;
    void client
      .createJoin(identity, deckVersion)
      .then((created) => {
        if (active) {
          setJoin(created);
          publishStageEvent("impromptu:display-join", created);
          if (openedByConsole) {
            (window.opener as Window)?.postMessage(
              { kind: "impromptu:display-join", join: created },
              consoleOrigin,
            );
          }
          setMessage(copy.waitingApproval);
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        setMessage(error instanceof Error ? error.message : copy.joinFailed);
        setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [client, consoleOrigin, deckVersion, identity, openedByConsole]);

  // The console tells the window it opened the moment approval lands, so this display claims at
  // once instead of waiting out the interval below. It is only a nudge: the claim is still what
  // the gateway authorises, and it only succeeds for a join the presenter actually approved. The
  // interval stays armed on this path too, because the console tab can be closed, reloaded, or
  // frozen by a phone before it ever gets to send this.
  useEffect(() => {
    if (join === null || consoleOrigin === null) return;
    let active = true;
    const onMessage = (event: MessageEvent) => {
      if (!active || event.origin !== consoleOrigin || event.source !== window.opener) return;
      const data = event.data as { readonly kind?: unknown; readonly displayJoinId?: unknown };
      if (
        typeof data !== "object" ||
        data === null ||
        data.kind !== "impromptu:display-bound" ||
        data.displayJoinId !== join.displayJoinId
      ) {
        return;
      }
      void client
        .claim(join)
        .then(() => {
          if (active) navigate(`/display/${identity.displayId}`);
        })
        .catch(() => {
          // Not yet claimable; the interval below keeps trying.
        });
    };
    window.addEventListener("message", onMessage);
    return () => {
      active = false;
      window.removeEventListener("message", onMessage);
    };
  }, [client, consoleOrigin, identity.displayId, join, navigate]);

  useEffect(() => {
    if (join === null) return;
    let active = true;
    const retry = globalThis.setInterval(() => {
      if (!active || Date.now() >= join.expiresAtMs) return;
      void client
        .claim(join)
        .then(() => {
          if (active) navigate(`/display/${identity.displayId}`);
        })
        .catch(() => {});
    }, 1_500);
    return () => {
      active = false;
      globalThis.clearInterval(retry);
    };
  }, [client, identity.displayId, join, navigate]);

  // A window the console opened is already facing the room, so this page's setup scaffolding is
  // something an audience should never be shown. Stay blank until the validated snapshot paints,
  // and break that silence only when the handshake actually failed — from the back of a room a
  // blank screen that is never coming back looks exactly like one that is.
  if (openedByConsole) {
    return (
      <div className="stage-display" data-audience-readiness="PAIRING" data-blackout="false">
        <main className="stage-display__content">
          {failed ? (
            <section className="stage-claim ui-reveal">
              <h1>{message}</h1>
            </section>
          ) : null}
        </main>
        <p className="stage-note ui-sr-only" aria-live="polite">
          {message}
        </p>
      </div>
    );
  }

  // Product decision: without a Console opener this window must not self-serve pairing — no join,
  // no codes, no claim button. One neutral line is all it shows.
  return (
    <main className="stage-console-only">
      <p>{copy.consoleOnlyNotice}</p>
    </main>
  );
}

interface FullscreenState {
  active: boolean;
  error: string | null;
}

function useStageFullscreen() {
  const [state, setState] = useState<FullscreenState>({ active: false, error: null });

  useEffect(() => {
    const syncFullscreen = () => {
      setState({ active: document.fullscreenElement !== null, error: null });
    };
    const reportError = () => {
      setState((current) => ({ ...current, error: copy.fullscreenBlocked }));
    };

    document.addEventListener("fullscreenchange", syncFullscreen);
    document.addEventListener("fullscreenerror", reportError);
    syncFullscreen();

    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreen);
      document.removeEventListener("fullscreenerror", reportError);
    };
  }, []);

  const toggle = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      } else {
        setState((current) => ({ ...current, error: copy.fullscreenBlocked }));
      }
    } catch {
      setState((current) => ({ ...current, error: copy.fullscreenBlocked }));
    }
  };

  return { ...state, toggle };
}

/**
 * A slide with no animation timeline still has to reach the projector intact.
 *
 * An SVG shown through `<img src>` renders in a restricted mode where the browser refuses every
 * external reference, and the render pipeline externalizes slide backgrounds into separate asset
 * files that each slide references relatively — so an `<img>`-displayed slide arrives in front of
 * the audience with its background missing. Measured on a real deck: zero of two background assets
 * requested through `<img>`, both of two when the same bytes are inlined. The animated path
 * already inlines; this is the static path, which became the normal one once animation started
 * being withheld for decks whose renderer geometry disagrees with their OOXML.
 *
 * Raster slides (PDF decks render to PNG) keep the `<img>` path, which has no such restriction.
 */
function StaticSlide({ slide }: { readonly slide: StageSnapshotView["deckSlides"][number] }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const { imageUrl, imageContentHash, accessibilityLabel } = slide;
  // String-only on purpose: a resolution failure would silently degrade the slide to the raster
  // path, which is what drops its background.
  const vector = (imageUrl.split(/[?#]/)[0] ?? "").toLowerCase().endsWith(".svg");

  useEffect(() => {
    if (!vector) return;
    const controller = new AbortController();
    let active = true;
    void loadVerifiedSvg({ imageUrl, imageContentHash, accessibilityLabel }, controller.signal)
      .then((svg) => {
        svg.setAttribute("class", "stage-slide");
        svg.setAttribute("data-slide-fit", "contain");
        if (active) hostRef.current?.replaceChildren(svg);
      })
      .catch(() => {
        // The surface stays empty rather than showing a room a slide whose bytes did not verify.
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [vector, imageUrl, imageContentHash, accessibilityLabel]);

  return vector ? (
    <div className="stage-slide-host" ref={hostRef} />
  ) : (
    <img className="stage-slide" data-slide-fit="contain" src={imageUrl} alt={accessibilityLabel} />
  );
}

function playbackRevisionValue(revision: string): number {
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
function reconnectedSnapshot(
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

function DisplayPage({ client }: { readonly client: StageSessionClient }) {
  const titleId = useId();
  const fullscreen = useStageFullscreen();
  const requestedMode = windowsDisplayMode(new URL(window.location.href).searchParams.get("mode"));
  const [mode, setMode] = useState(requestedMode);
  const [placementMessage, setPlacementMessage] = useState(manualPlacementSummary(requestedMode));
  const detailsRef = useRef<ScreenDetailsLike | null>(null);
  const targetRef = useRef<ScreenLike | null>(null);
  const renderedSlidePlayerRef = useRef<RenderedSlidePlayerHandle>(null);
  const [snapshot, setSnapshot] = useState<StageSnapshotView | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  // The projector surface is bare by default; the drive controls exist only for a local user
  // gesture, so they surface on local input and sink again once the presenter stops moving.
  const [chromeVisible, setChromeVisible] = useState(false);

  useEffect(() => {
    let hideHandle: ReturnType<typeof setTimeout> | undefined;
    const reveal = () => {
      setChromeVisible(true);
      clearTimeout(hideHandle);
      hideHandle = setTimeout(() => setChromeVisible(false), CHROME_HIDE_IDLE_MS);
    };
    const inputs = ["pointermove", "pointerdown", "keydown"] as const;
    for (const type of inputs) window.addEventListener(type, reveal);
    return () => {
      clearTimeout(hideHandle);
      for (const type of inputs) window.removeEventListener(type, reveal);
    };
  }, []);

  useEffect(() => {
    let active = true;
    const windowManager = window as unknown as Parameters<typeof observeWindowsTopology>[0];
    const apply = (observedMode: ReturnType<typeof windowsDisplayMode>, count: number) => {
      setMode(observedMode);
      publishStageEvent("impromptu:topology-change", {
        requestedMode,
        observedMode,
        screenCount: count,
      });
    };
    const reportPlacement = (
      status: "TARGET_PLACED" | "TARGET_LOST_RECOVERED" | "MANUAL_FALLBACK",
    ) => {
      setPlacementMessage(
        status === "TARGET_PLACED"
          ? copy.targetPlaced
          : status === "TARGET_LOST_RECOVERED"
            ? copy.targetRecovered
            : manualPlacementSummary(requestedMode),
      );
    };
    const sync = async () => {
      const details = detailsRef.current;
      const count = details?.screens.length ?? 1;
      const target = targetRef.current;
      if (details !== null && target !== null) {
        const recovery = await recoverTargetScreenLoss(windowManager, details, target);
        if (!active) return;
        targetRef.current = recovery.target;
        reportPlacement(recovery.status);
        if (recovery.status !== "TARGET_PLACED") {
          publishStageEvent("impromptu:target-screen-recovery", {
            status: recovery.status,
            privatePixelCount: 0,
          });
        }
      }
      apply(count > 1 ? "extend" : requestedMode === "single" ? "single" : "duplicate", count);
    };
    const bindDetails = (details: ScreenDetailsLike | null) => {
      detailsRef.current?.removeEventListener("screenschange", sync);
      detailsRef.current = details;
      details?.addEventListener("screenschange", sync);
    };
    const observeOrPlaceTarget = async (shouldPlace: boolean) => {
      const extendedScreen = window.screen as Screen & { readonly isExtended?: boolean };
      const result = await observeWindowsTopology(
        windowManager,
        extendedScreen.isExtended === true ? 2 : 1,
      );
      if (!active) return;
      bindDetails(result.details);
      if (shouldPlace || result.observation.screenCount !== 1) {
        apply(requestedMode, result.observation.screenCount);
      }
      const placement =
        !shouldPlace || result.details === null
          ? { status: "MANUAL_FALLBACK" as const, target: null }
          : await placeStageOnTargetScreen(windowManager, result.details);
      if (!active) return;
      targetRef.current = placement.target;
      if (shouldPlace) {
        reportPlacement(placement.status);
        publishStageEvent("impromptu:target-screen-placement", {
          status: placement.status,
          privatePixelCount: 0,
        });
      }
    };
    const onPlacementRequest = () => void observeOrPlaceTarget(true);
    const onPlatformTopology = (event: Event) => {
      if (
        !(event instanceof CustomEvent) ||
        typeof event.detail !== "object" ||
        event.detail === null
      )
        return;
      const detail = event.detail as Record<string, unknown>;
      const observedMode = windowsDisplayMode(
        typeof detail.observedMode === "string" ? detail.observedMode : null,
      );
      const count = typeof detail.screenCount === "number" ? detail.screenCount : 1;
      if (detail.targetScreenLost === true) {
        targetRef.current = null;
        reportPlacement("MANUAL_FALLBACK");
        publishStageEvent("impromptu:target-screen-recovery", {
          status: "MANUAL_FALLBACK",
          privatePixelCount: 0,
        });
      }
      apply(observedMode, count);
    };
    void observeOrPlaceTarget(false);
    window.addEventListener("resize", sync);
    window.addEventListener("impromptu:platform-topology-change", onPlatformTopology);
    window.addEventListener("impromptu:target-screen-placement-request", onPlacementRequest);
    return () => {
      active = false;
      detailsRef.current?.removeEventListener("screenschange", sync);
      window.removeEventListener("resize", sync);
      window.removeEventListener("impromptu:platform-topology-change", onPlatformTopology);
      window.removeEventListener("impromptu:target-screen-placement-request", onPlacementRequest);
    };
  }, [requestedMode]);

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

  const navigateCachedSlide = useCallback((offset: -1 | 1) => {
    setSnapshot((current) => {
      if (current === null) return null;
      const slides = [...current.deckSlides].sort((left, right) => left.ordinal - right.ordinal);
      const index = slides.findIndex(
        (slide) => slide.publicSlideKey === current.occurrence.publicSlideKey,
      );
      const target = slides[index + offset];
      if (target === undefined) return current;
      const occurrence = {
        publicSlideKey: target.publicSlideKey,
        occurrenceSeq: current.occurrence.occurrenceSeq + 1,
      };
      publishStageEvent("impromptu:local-slide", occurrence);
      return { ...current, occurrence };
    });
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      const unmodified = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
      if (unmodified && (event.key === "ArrowRight" || event.key === "PageDown")) {
        const player = renderedSlidePlayerRef.current;
        if (player !== null && !player.exhausted) {
          event.preventDefault();
          void player.advance();
          return;
        }
      }
      if (mode === "single" && snapshot !== null) {
        const command = emergencyPublicSlideSet(
          event,
          snapshot.deckSlides.map((slide) => slide.publicSlideKey),
          snapshot.occurrence.publicSlideKey,
        );
        if (command !== null) {
          event.preventDefault();
          publishStageEvent("impromptu:public-slide-set", command);
          setSnapshot((current) =>
            current === null
              ? null
              : {
                  ...current,
                  occurrence: {
                    publicSlideKey: command.publicSlideKey,
                    occurrenceSeq: current.occurrence.occurrenceSeq + 1,
                  },
                },
          );
          return;
        }
      }
      if (unmodified && event.key === "ArrowLeft") navigateCachedSlide(-1);
      if (unmodified && event.key === "ArrowRight") navigateCachedSlide(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode, navigateCachedSlide, snapshot]);
  const projectedSlide = snapshot?.deckSlides.find(
    (slide) => slide.publicSlideKey === snapshot.occurrence.publicSlideKey,
  );
  const currentSlide =
    projectedSlide === undefined
      ? undefined
      : { ...projectedSlide, imageUrl: normalizeDeckAssetUrl(projectedSlide.imageUrl) };
  const currentSlideRuntime =
    currentSlide === undefined ? null : renderedSlideRuntime(currentSlide);

  return (
    <div
      className="stage-display"
      data-audience-readiness={snapshot === null ? "RECOVERING" : "READY"}
      data-blackout={snapshot?.blackout === true ? "true" : "false"}
      data-stage-chrome={chromeVisible ? "visible" : "hidden"}
    >
      {/* Only gesture-driven controls remain; every decorative chip and status prose is gone. */}
      <header className="stage-display__bar">
        <Button data-stage-fullscreen variant="quiet" onClick={() => void fullscreen.toggle()}>
          {fullscreen.active ? copy.exitFullscreen : copy.enterFullscreen}
        </Button>
      </header>
      <main
        className={`stage-display__content${currentSlide === undefined ? "" : " stage-display__content--slide"}`}
        aria-labelledby={currentSlide === undefined ? titleId : undefined}
      >
        {currentSlide === undefined ? (
          <section className="stage-claim ui-reveal">
            <h1 id={titleId}>
              {unavailable === null ? copy.awaitingPresentation : copy.audienceUnavailable}
            </h1>
          </section>
        ) : (
          <section
            className="stage-slide-surface ui-reveal"
            data-stage-slide-surface="uploaded"
            aria-label={currentSlide.accessibilityLabel}
          >
            {currentSlideRuntime !== null ? (
              <RenderedSlidePlayer
                key={`${currentSlide.publicSlideKey}:${snapshot?.occurrence.occurrenceSeq ?? 0}`}
                ref={renderedSlidePlayerRef}
                slide={currentSlide}
                runtime={currentSlideRuntime}
                occurrenceSeq={snapshot?.occurrence.occurrenceSeq ?? 0}
              />
            ) : (
              <StaticSlide slide={currentSlide} />
            )}
          </section>
        )}
      </main>
      <aside className="stage-placement-message" data-manual-placement-mode={mode}>
        <Button
          data-stage-placement
          variant="quiet"
          onClick={() => publishStageEvent("impromptu:target-screen-placement-request", null)}
        >
          {copy.placeTarget}
        </Button>
      </aside>
      {/* Placement outcome and fullscreen failures stay reachable for assistive tech without
          painting status prose onto the room-facing screen. */}
      <p className="ui-sr-only" aria-live="polite">
        {placementMessage}
      </p>
      {fullscreen.error === null ? null : (
        <p className="ui-sr-only" aria-live="assertive">
          {fullscreen.error}
        </p>
      )}
    </div>
  );
}

export function StageRoutes({ client }: { readonly client?: StageSessionClient }) {
  const sessionClient = useMemo(
    () => client ?? createStageSessionClient(STAGE_PUBLIC_API_ORIGIN),
    [client],
  );
  return (
    <Routes>
      <Route index element={<LandingPage client={sessionClient} />} />
      <Route path="/display/:displayId" element={<DisplayPage client={sessionClient} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
