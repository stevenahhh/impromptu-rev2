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
    const leaseTimers = new Map<string, number>();

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
            const next = {
              ...current,
              cards: current.cards.filter(
                (candidate) => candidate.projectionId !== card.projectionId,
              ),
            };
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
            setSnapshot((current) => {
              if (current === null) return null;
              const next = { ...current, occurrence: event.occurrence };
              latestSnapshot = next;
              return next;
            });
            if (subscription?.recordApplied !== undefined) {
              subscription.recordApplied(event);
            } else {
              void client
                .recordApplied(event)
                .then((receipt) => publishStageEvent("impromptu:playback-applied", receipt))
                .catch(() =>
                  publishStageEvent("impromptu:channel-close", { reason: "RECEIPT_REJECTED" }),
                );
            }
          },
          onCard(event) {
            if (!active) return;
            setSnapshot((current) => {
              const next = applyCardEvent(current, event);
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
          onReceipt(receipt) {
            publishStageEvent("impromptu:playback-applied", receipt);
          },
          onClose(reason) {
            if (!active) return;
            publishStageEvent("impromptu:channel-close", { reason });
            subscription = null;
            setSnapshot((current) => {
              if (current === null) return null;
              const next = { ...current, cards: [] };
              latestSnapshot = next;
              return next;
            });
            void connect(latestSnapshot ?? undefined);
          },
        };
        if (client.subscribeRealtime !== undefined && sseSubscription === null) {
          sseSubscription = await client.subscribe(observer);
        }
        const subscribe = client.subscribeRealtime?.bind(client) ?? client.subscribe.bind(client);
        subscription = await subscribe(observer);
        if (!active) {
          subscription.close();
          return;
        }
        const next = await client.snapshot(pins);
        if (!active) return;
        latestSnapshot = next;
        setSnapshot(next);
        for (const card of next.cards) scheduleLease(card);
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

  const card = snapshot?.cards[0];

  return (
    <div className="stage-display">
      <header className="stage-display__bar">
        <Brand eyebrow="Public Stage" />
        <div className="stage-display__actions">
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
