import { Badge, Brand, Button, Panel, Shell, StatusDot } from "@impromptu/ui";
import { useEffect, useId, useState } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";

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

function LandingPage() {
  const titleId = useId();

  return (
    <Shell focused header={<StageHeader />}>
      <section className="stage-welcome ui-reveal" aria-labelledby={titleId}>
        <p className="ui-eyebrow">Display setup</p>
        <h1 id={titleId}>A clean screen for the room</h1>
        <p className="stage-lead">
          This public-only surface contains no presenter controls, coaching, team notes, or private
          session state.
        </p>
        <Panel className="stage-join" tone="inset">
          <div>
            <p className="ui-eyebrow">Preview display code</p>
            <p className="stage-code">
              <span aria-hidden="true">7K4Q</span>
              <span className="ui-sr-only">Display code 7 K 4 Q</span>
            </p>
          </div>
          <Link className="ui-button ui-button--primary" to="/display/rehearsal">
            Open display preview
          </Link>
        </Panel>
        <p className="stage-note">
          A future controller may approve this display code. It grants no access by itself.
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

function DisplayPage() {
  const titleId = useId();
  const fullscreen = useStageFullscreen();

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
            Supporting material stays legible at distance, cites its origin, and never reveals the
            presenter&apos;s private workspace.
          </blockquote>
          <footer>
            <span>Impromptu demo principle</span>
            <span>Prepared for rehearsal</span>
          </footer>
        </Panel>
      </main>
      <p className="stage-fullscreen-message" aria-live="polite">
        {fullscreen.error ?? (fullscreen.active ? "Fullscreen is active." : "Fullscreen is ready.")}
      </p>
    </div>
  );
}

export function StageRoutes() {
  return (
    <Routes>
      <Route index element={<LandingPage />} />
      <Route path="/display/:displayId" element={<DisplayPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
