import {
  applyRealtimeTransition,
  createRealtimeStageState,
  type RealtimeStageState,
  type RealtimeTransition,
} from "@impromptu/state";
import { Badge, Brand, Button, Panel, Shell, StatusDot } from "@impromptu/ui";
import { useEffect, useId, useMemo, useState } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import {
  createStageSessionClient,
  type DisplayJoinView,
  type StageCardEvent,
  type StageEventObserver,
  type StageSessionClient,
  type StageSnapshotView,
  type StageSubscription,
} from "./stage-client";

function publishStageEvent(name: string, detail: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function StageHeader() {
  return (
    <>
      <Brand eyebrow="Public Stage" />
      <Badge tone="accent">
        <StatusDot label="Audience-safe surface" />
        Audience screen
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
  const [join, setJoin] = useState<DisplayJoinView | null>(null);
  const [message, setMessage] = useState("Creating a short-lived display code...");

  useEffect(() => {
    let active = true;
    void client
      .createJoin(identity, deckVersion)
      .then((created) => {
        if (active) {
          setJoin(created);
          publishStageEvent("impromptu:display-join", created);
          setMessage("Waiting for an authenticated controller to approve this display.");
        }
      })
      .catch((error: unknown) => {
        if (active) setMessage(error instanceof Error ? error.message : "Display join failed.");
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
      setMessage(error instanceof Error ? error.message : "Display approval failed.");
    }
  };

  return (
    <Shell className="stage-shell" focused header={<StageHeader />}>
      <section className="stage-welcome ui-reveal" aria-labelledby={titleId}>
        <p className="ui-eyebrow">Display setup</p>
        <h1 id={titleId}>A clean screen for the room</h1>
        <p className="stage-lead">
          This public-only surface contains no presenter controls, coaching, team notes, or private
          session state.
        </p>
        <Panel className="stage-join" tone="inset">
          <div>
            <p className="ui-eyebrow">Display join code</p>
            <p className="stage-code">
              {join === null ? "----" : join.displayJoinId.slice(-8).toUpperCase()}
            </p>
          </div>
          <Button disabled={join === null} onClick={() => void claim()}>
            Continue after approval
          </Button>
        </Panel>
        <p className="stage-note" aria-live="polite">
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
          error: "Fullscreen is not available in this browser.",
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

function cardRevisionValue(revision: string): number {
  const value = Number(revision.slice(4));
  return Number.isSafeInteger(value) && value >= 0 ? value : -1;
}

function applyCardEvent(
  snapshot: StageSnapshotView | null,
  event: StageCardEvent,
): StageSnapshotView | null {
  if (
    snapshot === null ||
    cardRevisionValue(event.publicCardRevision) <= cardRevisionValue(snapshot.publicCardRevision)
  ) {
    return snapshot;
  }
  return {
    ...snapshot,
    publicCardRevision: event.publicCardRevision,
    cards:
      event.status === "PUBLISHED"
        ? [...snapshot.cards.filter((card) => card.projectionId !== event.projectionId), event]
        : snapshot.cards.filter((card) => card.projectionId !== event.projectionId),
  };
}

function DisplayPage({ client }: { readonly client: StageSessionClient }) {
  const titleId = useId();
  const fullscreen = useStageFullscreen();
  const [snapshot, setSnapshot] = useState<StageSnapshotView | null>(null);

  useEffect(() => {
    let active = true;
    let subscription: StageSubscription | null = null;
    let sseSubscription: StageSubscription | null = null;
    let latestSnapshot: StageSnapshotView | null = null;
    let realtimeState: RealtimeStageState | null = null;
    let realtimeReconnectAttempts = 0;
    const leaseTimers = new Map<string, number>();

    const transition = (event: RealtimeTransition) => {
      if (realtimeState === null) return null;
      const result = applyRealtimeTransition(realtimeState, event);
      realtimeState = result.state;
      return result;
    };

    const visibleCards = (current: StageSnapshotView, state: RealtimeStageState) => ({
      ...current,
      cards: current.cards.filter((card) => state.visibleCardIds.includes(card.projectionId)),
    });

    const scheduleLease = (card: StageSnapshotView["cards"][number]) => {
      const existing = leaseTimers.get(card.projectionId);
      if (existing !== undefined) window.clearTimeout(existing);
      if (card.mode !== "LIVE" || card.leaseExpiresAtMs === null) return;
      const timer = window.setTimeout(
        () => {
          leaseTimers.delete(card.projectionId);
          setSnapshot((current) => {
            if (current === null) return null;
            const present = current.cards.find(
              (candidate) => candidate.projectionId === card.projectionId,
            );
            if (present?.leaseExpiresAtMs !== card.leaseExpiresAtMs) return current;
            const result = transition({ type: "CLOCK", nowMs: Date.now() });
            if (result === null || result.outcome !== "APPLIED") return current;
            const next = visibleCards(current, result.state);
            latestSnapshot = next;
            publishStageEvent("impromptu:card-hidden", {
              projectionId: card.projectionId,
              reason: "LEASE_EXPIRED",
            });
            return next;
          });
        },
        Math.max(0, card.leaseExpiresAtMs - Date.now()),
      );
      leaseTimers.set(card.projectionId, timer);
    };

    const connect = async (pins?: StageSnapshotView): Promise<void> => {
      try {
        const observer: StageEventObserver = {
          onPlayback(event) {
            if (!active) return;
            if (
              realtimeState !== null &&
              (event.presentationSessionEpoch !== realtimeState.presentationSessionEpoch ||
                event.displayBindingEpoch !== realtimeState.displayBindingEpoch)
            ) {
              const epochResult = transition({
                type: "EPOCH_CHANGED",
                presentationSessionEpoch: event.presentationSessionEpoch,
                displayBindingEpoch: event.displayBindingEpoch,
              });
              setSnapshot((current) => {
                if (current === null || epochResult === null) return current;
                const next = visibleCards(current, epochResult.state);
                latestSnapshot = next;
                return next;
              });
              publishStageEvent("impromptu:card-hidden", { reason: "EPOCH_CHANGED" });
              return;
            }
            const playbackResult = transition({
              type: "ABSOLUTE_PLAYBACK",
              commandId: event.commandId,
              presentationSessionEpoch: event.presentationSessionEpoch,
              displayBindingEpoch: event.displayBindingEpoch,
              publicPlaybackRevision: event.publicPlaybackRevision,
              occurrence: event.occurrence,
              blackout: event.blackout,
            });
            if (playbackResult?.outcome === "APPLIED") {
              setSnapshot((current) => {
                if (current === null) return null;
                const next = {
                  ...current,
                  publicPlaybackRevision: event.publicPlaybackRevision,
                  occurrence: event.occurrence,
                  blackout: event.blackout,
                };
                latestSnapshot = next;
                return next;
              });
              publishStageEvent("impromptu:visible-playback", {
                commandId: event.commandId,
                occurrence: event.occurrence,
              });
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
          onCard(event) {
            if (!active) return;
            const cardResult =
              event.status === "PUBLISHED"
                ? transition({
                    type: "CARD_UPSERT",
                    nowMs: Date.now(),
                    card: {
                      projectionId: event.projectionId,
                      mode: event.mode,
                      leaseExpiresAtMs: event.leaseExpiresAtMs,
                      publicCardRevision: event.publicCardRevision,
                      ...(event.offlinePackage === undefined
                        ? {}
                        : {
                            offlinePackage: {
                              offlineDisplayAllowed: event.offlinePackage.offlineDisplayAllowed,
                              localExpiresAtMs: event.offlinePackage.localExpiresAtMs,
                              signatureVerified: event.offlinePackage.signatureVerified,
                            },
                          }),
                    },
                  })
                : transition({
                    type: "CARD_TOMBSTONE",
                    projectionId: event.projectionId,
                    publicCardRevision: event.publicCardRevision,
                  });
            setSnapshot((current) => {
              const streamed = applyCardEvent(current, event);
              if (streamed === null || cardResult === null) return streamed;
              const next = visibleCards(streamed, cardResult.state);
              latestSnapshot = next;
              return next;
            });
            if (event.status === "PUBLISHED") scheduleLease(event);
            else {
              const timer = leaseTimers.get(event.projectionId);
              if (timer !== undefined) window.clearTimeout(timer);
              leaseTimers.delete(event.projectionId);
            }
            publishStageEvent("impromptu:card-event", event);
          },
          onProtocolError(code) {
            const result = transition({ type: "EXPLICIT_HIDE", reason: "EXPLICIT_ERROR" });
            setSnapshot((current) => {
              if (current === null || result === null) return current;
              const next = visibleCards(current, result.state);
              latestSnapshot = next;
              return next;
            });
            publishStageEvent("impromptu:card-hidden", { reason: code });
          },
          onReceipt(receipt) {
            realtimeReconnectAttempts = 0;
            publishStageEvent("impromptu:playback-applied", receipt);
          },
          onClose(reason) {
            if (!active) return;
            publishStageEvent("impromptu:channel-close", { reason });
            subscription = null;
            const partitioned = transition({
              type: "PARTITION",
              reason: "NETWORK_ERROR",
              nowMs: Date.now(),
            });
            setSnapshot((current) => {
              if (current === null || partitioned === null) return current;
              const next = visibleCards(current, partitioned.state);
              latestSnapshot = next;
              return next;
            });
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
        if (realtimeState === null) {
          realtimeState = createRealtimeStageState(
            {
              presentationSessionId: next.presentationSessionId,
              presentationSessionEpoch: next.presentationSessionEpoch,
              displayBindingEpoch: next.displayBindingEpoch,
              deckVersion: next.deckVersion,
              manifestHash: next.manifestHash,
            },
            next.occurrence,
          );
        } else {
          transition({ type: "RECONNECT" });
        }
        const restored = transition({
          type: "SNAPSHOT",
          verifiedStateHash: next.stateHash,
          snapshot: {
            role: next.role,
            stateHash: next.stateHash,
            presentationSessionId: next.presentationSessionId,
            presentationSessionEpoch: next.presentationSessionEpoch,
            displayBindingEpoch: next.displayBindingEpoch,
            deckVersion: next.deckVersion,
            manifestHash: next.manifestHash,
            publicPlaybackRevision: next.publicPlaybackRevision,
            publicCardRevision: next.publicCardRevision,
            occurrence: next.occurrence,
            blackout: next.blackout,
            cards: next.cards.map((card) => ({
              projectionId: card.projectionId,
              mode: card.mode,
              leaseExpiresAtMs: card.leaseExpiresAtMs,
              publicCardRevision: card.publicCardRevision,
              ...(card.offlinePackage === undefined
                ? {}
                : {
                    offlinePackage: {
                      offlineDisplayAllowed: card.offlinePackage.offlineDisplayAllowed,
                      localExpiresAtMs: card.offlinePackage.localExpiresAtMs,
                      signatureVerified: card.offlinePackage.signatureVerified,
                    },
                  }),
            })),
          },
        });
        if (restored === null || restored.outcome === "RECONCILE_REQUIRED") {
          throw new Error("RECONCILE_REQUIRED");
        }
        const visible = visibleCards(next, restored.state);
        latestSnapshot = visible;
        setSnapshot(visible);
        publishStageEvent("impromptu:snapshot-applied", {
          stateHash: visible.stateHash,
          publicPlaybackRevision: visible.publicPlaybackRevision,
          publicCardRevision: visible.publicCardRevision,
          visibleCardIds: visible.cards.map((card) => card.projectionId),
        });
        for (const card of visible.cards) scheduleLease(card);
        if (client.subscribeRealtime !== undefined) {
          subscription = await client.subscribeRealtime(observer);
          if (!active) subscription.close();
        }
      } catch (error) {
        subscription?.close();
        subscription = null;
        if (active && error instanceof Error && error.message === "RECONCILE_REQUIRED") {
          setSnapshot((current) => (current === null ? null : { ...current, cards: [] }));
          publishStageEvent("impromptu:reconcile-required", { reason: "PIN_MISMATCH" });
        }
      }
    };
    void connect();
    return () => {
      active = false;
      subscription?.close();
      sseSubscription?.close();
      for (const timer of leaseTimers.values()) window.clearTimeout(timer);
    };
  }, [client]);

  const navigateCachedSlide = (offset: -1 | 1) => {
    setSnapshot((current) => {
      if (current === null) return null;
      const slides = [...current.deckSlides].sort((left, right) => left.ordinal - right.ordinal);
      const index = slides.findIndex(
        (slide) => slide.publicSlideKey === current.occurrence.publicSlideKey,
      );
      const target = slides[index + offset];
      return target === undefined
        ? current
        : {
            ...current,
            occurrence: {
              publicSlideKey: target.publicSlideKey,
              occurrenceSeq: current.occurrence.occurrenceSeq + 1,
            },
          };
    });
  };
  const card = snapshot?.cards[0];

  return (
    <div className="stage-display">
      <header className="stage-display__bar">
        <Brand eyebrow="Public Stage" />
        <div className="stage-display__actions">
          <Button variant="quiet" onClick={() => navigateCachedSlide(-1)}>
            Previous slide
          </Button>
          <Button variant="quiet" onClick={() => navigateCachedSlide(1)}>
            Next slide
          </Button>
          <Badge tone="success">
            <StatusDot label="Preview content visible" />
            Preview
          </Badge>
          <Button variant="quiet" onClick={() => void fullscreen.toggle()}>
            {fullscreen.active ? "Exit fullscreen" : "Enter fullscreen"}
          </Button>
        </div>
      </header>
      <main className="stage-display__content" aria-labelledby={titleId}>
        <section className="stage-claim ui-reveal">
          <p className="ui-eyebrow">Curated evidence preview</p>
          <h1 id={titleId}>Evidence, without the detour</h1>
          <p className="stage-lead">
            A single, presenter-approved card supports the current idea while the main presentation
            keeps moving.
          </p>
        </section>
        <Panel className="stage-evidence ui-reveal ui-reveal--2">
          <Badge tone="accent">Pre-approved</Badge>
          <blockquote>
            {card?.claim ??
              "Supporting material stays legible at distance, cites its origin, and never reveals the presenter's private workspace."}
          </blockquote>
          <footer>
            <span>{card?.sourceLabel ?? "Impromptu demo principle"}</span>
            <span>{card?.supportSummary ?? "Prepared for rehearsal"}</span>
          </footer>
        </Panel>
      </main>
      <p className="stage-fullscreen-message" aria-live="polite">
        {fullscreen.error ?? (fullscreen.active ? "Fullscreen is active." : "Fullscreen is ready.")}
      </p>
    </div>
  );
}

export function StageRoutes({ client }: { readonly client?: StageSessionClient }) {
  const sessionClient = useMemo(() => client ?? createStageSessionClient(), [client]);
  return (
    <Routes>
      <Route index element={<LandingPage client={sessionClient} />} />
      <Route path="/display/:displayId" element={<DisplayPage client={sessionClient} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
