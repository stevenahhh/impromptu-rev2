import { Badge, Brand, Button, Panel, Shell, StatusDot } from "@impromptu/ui";
import { useEffect, useId, useMemo, useState } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import {
  createStageSessionClient,
  type DisplayJoinView,
  type StageSessionClient,
  type StageSnapshotView,
} from "./stage-client";

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
  const [join, setJoin] = useState<DisplayJoinView | null>(null);
  const [message, setMessage] = useState("Creating a short-lived display code...");

  useEffect(() => {
    let active = true;
    void client
      .createJoin(identity, "deck_alpha")
      .then((created) => {
        if (active) {
          setJoin(created);
          setMessage("Waiting for an authenticated controller to approve this display.");
        }
      })
      .catch((error: unknown) => {
        if (active) setMessage(error instanceof Error ? error.message : "Display join failed.");
      });
    return () => {
      active = false;
    };
  }, [client, identity]);

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

function DisplayPage({ client }: { readonly client: StageSessionClient }) {
  const titleId = useId();
  const fullscreen = useStageFullscreen();
  const [snapshot, setSnapshot] = useState<StageSnapshotView | null>(null);

  useEffect(() => {
    let active = true;
    void client
      .snapshot()
      .then((next) => {
        if (active) setSnapshot(next);
      })
      .catch(() => undefined);
    return () => {
      active = false;
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
