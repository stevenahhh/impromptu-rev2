import { type PublishedSlideRuntime, PublishedSlideRuntimeSchema } from "@impromptu/contracts";
import { Badge, Brand, Button, Panel, rebaseDeckAssetUrl, Shell, StatusDot } from "@impromptu/ui";
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
  topologyInstructions,
  windowsDisplayMode,
} from "./windows-topology";

const STAGE_PUBLIC_API_ORIGIN = import.meta.env.STAGE_PUBLIC_API_ORIGIN ?? "";

function publishStageEvent(name: string, detail: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function displayModeLabel(mode: "extend" | "duplicate" | "single"): string {
  if (mode === "duplicate") return copy.modeDuplicate;
  if (mode === "single") return copy.modeSingle;
  return copy.modeExtend;
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

function StageHeader() {
  return (
    <>
      <Brand eyebrow={copy.brandEyebrow} />
      <Badge tone="accent">
        <StatusDot label={copy.audienceSafeLabel} />
        {copy.audienceScreen}
      </Badge>
    </>
  );
}

function LandingPage({ client }: { readonly client: StageSessionClient }) {
  const titleId = useId();
  const navigate = useNavigate();
  const identity = useMemo(
    () => ({
      displayId: `display_${crypto.randomUUID().replaceAll("-", "")}`,
      displayFingerprint: `stage-browser-${crypto.randomUUID()}`,
    }),
    [],
  );
  const deckVersion = new URL(window.location.href).searchParams.get("deck") ?? "deck_alpha";
  const mode = windowsDisplayMode(new URL(window.location.href).searchParams.get("mode"));
  const [join, setJoin] = useState<DisplayJoinView | null>(null);
  const [message, setMessage] = useState("Creating a short-lived display code...");
  const connectionCode =
    join === null
      ? ""
      : btoa(
          JSON.stringify({
            displayJoinId: join.displayJoinId,
            displayId: join.displayId,
            displayFingerprint: join.displayFingerprint,
            deckVersion: join.deckVersion,
            expiresAtMs: join.expiresAtMs,
          }),
        );

  useEffect(() => {
    let active = true;
    void client
      .createJoin(identity, deckVersion)
      .then((created) => {
        if (active) {
          setJoin(created);
          publishStageEvent("impromptu:display-join", created);
          setMessage(copy.waitingApproval);
        }
      })
      .catch((error: unknown) => {
        if (active) setMessage(error instanceof Error ? error.message : copy.joinFailed);
      });
    return () => {
      active = false;
    };
  }, [client, deckVersion, identity]);

  const claim = async () => {
    if (join === null) return;
    try {
      await client.claim(join);
      navigate(`/display/${identity.displayId}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : copy.approvalFailed);
    }
  };

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

  return (
    <Shell className="stage-shell" focused header={<StageHeader />}>
      <section className="stage-welcome ui-reveal" aria-labelledby={titleId}>
        <p className="ui-eyebrow">{copy.displaySetup}</p>
        <h1 id={titleId}>{copy.cleanScreenTitle}</h1>
        <p className="stage-lead">{copy.cleanScreenLead}</p>
        <Panel className="stage-join" tone="inset">
          <div>
            <p className="ui-eyebrow">{copy.joinCode}</p>
            <p className="stage-code">
              {join === null ? "----" : join.displayJoinId.slice(-8).toUpperCase()}
            </p>
          </div>
          <Button data-display-claim disabled={join === null} onClick={() => void claim()}>
            {copy.continueAfterApproval}
          </Button>
        </Panel>
        {join === null ? null : (
          <Panel title={copy.connectTitle}>
            <p>{copy.copyLead}</p>
            <label className="stage-connection-code">
              <span>{copy.connectionCode}</span>
              <input readOnly value={connectionCode} />
            </label>
            <Button
              variant="quiet"
              onClick={() => void navigator.clipboard.writeText(connectionCode)}
            >
              {copy.copyConnectionCode}
            </Button>
          </Panel>
        )}
        <Panel
          data-topology-instructions={mode}
          title={`${mode[0]?.toUpperCase()}${mode.slice(1)} setup`}
        >
          <ol className="stage-setup-list">
            {topologyInstructions(mode).map((instruction) => (
              <li key={instruction}>{instruction}</li>
            ))}
          </ol>
        </Panel>
        <p className="stage-note ui-sr-only" aria-live="polite">
          {message} The code grants no controller access by itself.
        </p>
      </section>
    </Shell>
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
      setState((current) => ({
        ...current,
        error: "Fullscreen was blocked. Use the browser menu.",
      }));
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
        setState((current) => ({
          ...current,
          error: copy.fullscreenUnavailable,
        }));
      }
    } catch {
      setState((current) => ({
        ...current,
        error: "Fullscreen was blocked. Use the browser menu.",
      }));
    }
  };

  return { ...state, toggle };
}

function playbackRevisionValue(revision: string): number {
  if (!revision.startsWith("pbr_")) return -1;
  const value = Number(revision.slice(4));
  return Number.isSafeInteger(value) && value >= 0 ? value : -1;
}

function DisplayPage({ client }: { readonly client: StageSessionClient }) {
  const titleId = useId();
  const fullscreen = useStageFullscreen();
  const requestedMode = windowsDisplayMode(new URL(window.location.href).searchParams.get("mode"));
  const [mode, setMode] = useState(requestedMode);
  const [screenCount, setScreenCount] = useState(1);
  const [placementMessage, setPlacementMessage] = useState(manualPlacementSummary(requestedMode));
  const detailsRef = useRef<ScreenDetailsLike | null>(null);
  const targetRef = useRef<ScreenLike | null>(null);
  const renderedSlidePlayerRef = useRef<RenderedSlidePlayerHandle>(null);
  const [snapshot, setSnapshot] = useState<StageSnapshotView | null>(null);

  useEffect(() => {
    let active = true;
    const windowManager = window as unknown as Parameters<typeof observeWindowsTopology>[0];
    const apply = (observedMode: ReturnType<typeof windowsDisplayMode>, count: number) => {
      setMode(observedMode);
      setScreenCount(Math.max(1, count));
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

    const connect = async (pins?: StageSnapshotView): Promise<void> => {
      try {
        const observer: StageEventObserver = {
          onPlayback(event) {
            if (!active) return;
            const current = latestSnapshot;
            if (current === null) return;
            if (
              event.presentationSessionEpoch !== current.presentationSessionEpoch ||
              event.displayBindingEpoch !== current.displayBindingEpoch
            ) {
              setSnapshot(null);
              latestSnapshot = null;
              publishStageEvent("impromptu:reconcile-required", { reason: "EPOCH_CHANGED" });
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
              publishStageEvent("impromptu:visible-playback", {
                commandId: event.commandId,
                occurrence: event.occurrence,
              });
            } else if (nextRevision !== currentRevision) {
              setSnapshot(null);
              latestSnapshot = null;
              publishStageEvent("impromptu:reconcile-required", { reason: "REVISION_GAP" });
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
        const next = await client.snapshot(pins);
        if (!active) return;
        latestSnapshot = next;
        setSnapshot(next);
        publishStageEvent("impromptu:stage-ready", { requestedMode, observedMode: mode });
        publishStageEvent("impromptu:snapshot-applied", {
          stateHash: next.stateHash,
          publicPlaybackRevision: next.publicPlaybackRevision,
        });
        if (client.subscribeRealtime !== undefined) {
          subscription = await client.subscribeRealtime(observer);
          if (!active) subscription.close();
        }
      } catch (error) {
        subscription?.close();
        subscription = null;
        if (active && error instanceof Error && error.message === "RECONCILE_REQUIRED") {
          setSnapshot(null);
          latestSnapshot = null;
          publishStageEvent("impromptu:reconcile-required", { reason: "PIN_MISMATCH" });
        }
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
    >
      <header className="stage-display__bar">
        <Brand eyebrow={copy.brandEyebrow} />
        <div className="stage-display__actions">
          <Badge tone={snapshot !== null ? "success" : "accent"}>
            <StatusDot label={snapshot !== null ? copy.publicReady : copy.recovering} />
            {snapshot !== null ? copy.publicOnly : copy.recovering}
          </Badge>
          <Badge tone="success">
            <StatusDot label={copy.previewVisible} />
            {copy.preview}
          </Badge>
          <Badge tone="accent">
            {displayModeLabel(mode)} / {copy.screenCount} {screenCount}개
          </Badge>
          <Button data-stage-fullscreen variant="quiet" onClick={() => void fullscreen.toggle()}>
            {fullscreen.active ? copy.exitFullscreen : copy.enterFullscreen}
          </Button>
        </div>
      </header>
      <main
        className={`stage-display__content${currentSlide === undefined ? "" : " stage-display__content--slide"}`}
        aria-labelledby={currentSlide === undefined ? titleId : undefined}
      >
        {currentSlide === undefined ? (
          <section className="stage-claim ui-reveal">
            <h1 id={titleId}>{copy.recovering}</h1>
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
              <img
                className="stage-slide"
                data-slide-fit="contain"
                src={currentSlide.imageUrl}
                alt={currentSlide.accessibilityLabel}
              />
            )}
          </section>
        )}
      </main>
      <aside
        className="stage-placement-message"
        data-manual-placement-mode={mode}
        aria-live="polite"
      >
        <Button
          data-stage-placement
          variant="quiet"
          onClick={() => publishStageEvent("impromptu:target-screen-placement-request", null)}
        >
          {copy.placeTarget}
        </Button>
        <span>{placementMessage}</span>
      </aside>
      <p className="stage-fullscreen-message" aria-live="polite">
        {fullscreen.error ?? (fullscreen.active ? copy.fullscreenActive : copy.fullscreenReady)}
      </p>
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
