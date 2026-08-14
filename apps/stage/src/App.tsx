import { Badge, Brand, Button, Panel, Shell, StatusDot } from "@impromptu/ui";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import {
  createStageSessionClient,
  type DisplayJoinView,
  type StageCardEvent,
  type StageSessionClient,
  type StageSnapshotView,
  type StageSubscription,
} from "./stage-client";
import {
  emergencyPublicSlideSet,
  observeWindowsTopology,
  topologyInstructions,
  windowsDisplayMode,
} from "./windows-topology";

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
  const search = new URL(window.location.href).searchParams;
  const deckVersion = search.get("deck") ?? "deck_alpha";
  const mode = windowsDisplayMode(search.get("mode"));
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
        <Panel title={`${mode[0]?.toUpperCase()}${mode.slice(1)} setup`}>
          <ol className="stage-setup-list">
            {topologyInstructions(mode).map((instruction) => (
              <li key={instruction}>{instruction}</li>
            ))}
          </ol>
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
  const mode = windowsDisplayMode(new URL(window.location.href).searchParams.get("mode"));
  const [snapshot, setSnapshot] = useState<StageSnapshotView | null>(null);
  const [connection, setConnection] = useState<"ready" | "recovering">("recovering");
  const [screenCount, setScreenCount] = useState(1);

  const refreshSnapshot = useCallback(async () => {
    const next = await client.snapshot();
    setSnapshot((current) =>
      current !== null &&
      cardRevisionValue(current.publicCardRevision) > cardRevisionValue(next.publicCardRevision)
        ? current
        : next,
    );
    setConnection("ready");
    publishStageEvent("impromptu:stage-ready", { mode });
  }, [client, mode]);

  useEffect(() => {
    let active = true;
    let details: Awaited<ReturnType<typeof observeWindowsTopology>>["details"] = null;
    const sync = () => {
      const count = details?.screens.length ?? 1;
      setScreenCount(Math.max(1, count));
      publishStageEvent("impromptu:topology-change", { mode, screenCount: count });
    };
    const windowManager = window as unknown as Parameters<typeof observeWindowsTopology>[0];
    const extendedScreen = window.screen as Screen & { readonly isExtended?: boolean };
    void observeWindowsTopology(windowManager, extendedScreen.isExtended === true ? 2 : 1).then(
      (result) => {
        if (!active) return;
        details = result.details;
        setScreenCount(result.observation.screenCount);
        details?.addEventListener("screenschange", sync);
      },
    );
    window.addEventListener("resize", sync);
    return () => {
      active = false;
      details?.removeEventListener("screenschange", sync);
      window.removeEventListener("resize", sync);
    };
  }, [mode]);

  useEffect(() => {
    if (mode !== "single" || snapshot === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      const command = emergencyPublicSlideSet(
        event,
        snapshot.publicSlideKeys ?? [snapshot.occurrence.publicSlideKey],
        snapshot.occurrence.publicSlideKey,
      );
      if (command === null) return;
      event.preventDefault();
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
      publishStageEvent("impromptu:public-slide-set", command);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode, snapshot]);

  useEffect(() => {
    let active = true;
    let subscription: StageSubscription | null = null;
    void (async () => {
      try {
        subscription = await client.subscribe({
          onPlayback(event) {
            if (!active) return;
            setSnapshot((current) =>
              current === null ? null : { ...current, occurrence: event.occurrence },
            );
            void client
              .recordApplied(event)
              .then((receipt) => publishStageEvent("impromptu:playback-applied", receipt))
              .catch(() =>
                publishStageEvent("impromptu:channel-close", { reason: "RECEIPT_REJECTED" }),
              );
          },
          onCard(event) {
            if (active) {
              setSnapshot((current) => applyCardEvent(current, event));
              publishStageEvent("impromptu:card-event", event);
            }
          },
          onClose(reason) {
            if (!active) return;
            setConnection("recovering");
            publishStageEvent("impromptu:channel-close", { reason });
          },
          onOpen() {
            if (active) void refreshSnapshot();
          },
        });
        if (!active) {
          subscription.close();
          return;
        }
        await refreshSnapshot();
      } catch {
        setConnection("recovering");
        subscription?.close();
      }
    })();
    const refresh = () => {
      if (active) void refreshSnapshot();
    };
    window.addEventListener("online", refresh);
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active = false;
      window.removeEventListener("online", refresh);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", refresh);
      subscription?.close();
    };
  }, [client, refreshSnapshot]);

  const card = snapshot?.cards[0];

  return (
    <div className="stage-display">
      <header className="stage-display__bar">
        <Brand eyebrow="Public Stage" />
        <div className="stage-display__actions">
          <Badge tone={connection === "ready" ? "success" : "accent"}>
            <StatusDot label={connection === "ready" ? "Public Stage ready" : "Recovering Stage"} />
            {connection === "ready" ? "Public only" : "Recovering"}
          </Badge>
          <Badge tone="accent">
            {mode} / {screenCount} screen{screenCount === 1 ? "" : "s"}
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
        {fullscreen.error ??
          (fullscreen.active
            ? "Fullscreen is active."
            : "Fullscreen exited. Restore it locally when the audience surface is ready.")}
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
