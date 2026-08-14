import { Badge, Brand, Button, Panel, Shell, StatusDot } from "@impromptu/ui";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { AudioConsentControl } from "./audio-capture";
import {
  type AccountSessionView,
  type ConsoleSessionClient,
  createConsoleSessionClient,
} from "./session-client";

interface AuthState {
  authenticated: boolean;
  pending: boolean;
  error: string | null;
  signIn: (authorizationCode: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export interface AuthProviderProps {
  children: ReactNode;
  initialAuthenticated?: boolean;
  client?: ConsoleSessionClient;
}

export function AuthProvider({
  children,
  initialAuthenticated = false,
  client,
}: AuthProviderProps) {
  const sessionClient = useMemo(() => client ?? createConsoleSessionClient(), [client]);
  const [session, setSession] = useState<AccountSessionView | null>(
    initialAuthenticated
      ? {
          account: { accountId: "account_preview", actorId: "actor_preview" },
          expiresAtMs: Number.MAX_SAFE_INTEGER,
          csrfToken: "preview-csrf",
        }
      : null,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = useMemo(
    () => ({
      authenticated: session !== null,
      pending,
      error,
      async signIn(authorizationCode: string) {
        setPending(true);
        setError(null);
        try {
          setSession(await sessionClient.signIn(authorizationCode));
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Sign-in failed.");
        } finally {
          setPending(false);
        }
      },
      async signOut() {
        if (session === null) return;
        setPending(true);
        setError(null);
        try {
          await sessionClient.signOut(session.csrfToken);
          setSession(null);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Sign-out failed.");
        } finally {
          setPending(false);
        }
      },
    }),
    [error, pending, session, sessionClient],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

function useAuth() {
  const auth = useContext(AuthContext);
  if (!auth) {
    throw new Error("AuthProvider is required");
  }
  return auth;
}

function RequireAuth() {
  const { authenticated } = useAuth();
  const location = useLocation();

  return authenticated ? (
    <Outlet />
  ) : (
    <Navigate to="/sign-in" replace state={{ from: location.pathname }} />
  );
}

function PublicOnly() {
  return useAuth().authenticated ? <Navigate to="/" replace /> : <Outlet />;
}

function ConsoleHeader() {
  return (
    <>
      <Brand eyebrow="Presenter Console" />
      <Badge tone="success">
        <StatusDot label="Local preview ready" />
        Local preview
      </Badge>
    </>
  );
}

function SignInPage() {
  const { signIn, pending, error } = useAuth();
  const [authorizationCode, setAuthorizationCode] = useState("");

  return (
    <Shell focused header={<ConsoleHeader />}>
      <Panel className="console-sign-in ui-reveal">
        <p className="ui-eyebrow">Private origin</p>
        <h1>Private presentation control</h1>
        <p className="console-lead">
          Your setup, coaching, and team notes stay here. Nothing on this screen belongs on the
          audience display.
        </p>
        <label className="console-field">
          <span>One-time sign-in code</span>
          <input
            autoComplete="one-time-code"
            value={authorizationCode}
            onChange={(event) => setAuthorizationCode(event.currentTarget.value)}
          />
        </label>
        <Button
          disabled={pending || authorizationCode.length === 0}
          onClick={() => void signIn(authorizationCode)}
        >
          {pending ? "Signing in..." : "Enter private workspace"}
        </Button>
        <p className="console-caption" aria-live="polite">
          {error ?? "The code is exchanged server-side and is never stored by this browser."}
        </p>
      </Panel>
    </Shell>
  );
}

function PrivateNavigation() {
  const { signOut } = useAuth();

  return (
    <aside className="console-rail ui-reveal">
      <p className="ui-eyebrow">Private workspace</p>
      <nav aria-label="Private workspace" className="console-nav">
        <NavLink to="/" end>
          Room overview
        </NavLink>
        <NavLink to="/session">Session setup</NavLink>
      </nav>
      <Button variant="quiet" onClick={() => void signOut()}>
        Leave workspace
      </Button>
    </aside>
  );
}

function PrivateLayout({ coResident }: { readonly coResident: boolean }) {
  const [coResidentState, setCoResidentState] = useState<"OFF" | "ENABLED" | "DISABLED">(
    coResident ? "ENABLED" : "OFF",
  );

  useEffect(() => {
    const observePublicSurface = (event: Event) => {
      if (
        coResidentState !== "ENABLED" ||
        !(event instanceof CustomEvent) ||
        typeof event.detail !== "object" ||
        event.detail === null
      ) {
        return;
      }
      const detail = event.detail as Record<string, unknown>;
      if (typeof detail.privatePixelCount !== "number" || detail.privatePixelCount <= 0) return;
      setCoResidentState("DISABLED");
      window.dispatchEvent(
        new CustomEvent("impromptu:co-resident-disabled", {
          detail: { reason: "PRIVATE_PIXEL_OBSERVED", privatePixelCount: detail.privatePixelCount },
        }),
      );
    };
    window.addEventListener("impromptu:public-surface-observation", observePublicSurface);
    return () =>
      window.removeEventListener("impromptu:public-surface-observation", observePublicSurface);
  }, [coResidentState]);

  if (coResidentState === "DISABLED") {
    return (
      <Shell focused header={<Brand eyebrow="Public safety interlock" />}>
        <main className="console-co-resident-shield" data-co-resident-state="DISABLED">
          <p className="ui-eyebrow">Audience surface protected</p>
          <h1>Co-resident mode disabled</h1>
          <p>Move presentation control to a separate device before continuing.</p>
        </main>
      </Shell>
    );
  }

  return (
    <Shell header={<ConsoleHeader />}>
      <PrivateNavigation />
      <div className="console-content" data-co-resident-state={coResidentState}>
        {coResidentState === "ENABLED" ? (
          <aside className="console-co-resident" role="alert">
            <strong>Co-resident convenience mode</strong>
            <span>
              Private Console is on the Stage PC. No-private-pixel protection does not apply; move
              Console to a separate device before using Duplicate.
            </span>
          </aside>
        ) : null}
        <Outlet />
      </div>
    </Shell>
  );
}

function OverviewPage() {
  const titleId = useId();

  return (
    <>
      <section className="console-hero ui-reveal ui-reveal--2" aria-labelledby={titleId}>
        <p className="ui-eyebrow">Room 01 / rehearsal</p>
        <h1 id={titleId}>Ready for the room</h1>
        <p className="console-lead">
          Prepare the private controller here, then let the public Stage enter fullscreen from its
          own screen.
        </p>
        <Link className="ui-button ui-button--primary console-action" to="/session">
          Prepare a session
        </Link>
      </section>
      <div className="console-grid ui-reveal ui-reveal--3">
        <Panel title="Display boundary">
          <Badge tone="accent">Separate public Stage</Badge>
          <p>Only audience-safe presentation material appears on the display surface.</p>
        </Panel>
        <Panel title="Topology">
          <p className="console-metric">2 modes</p>
          <p>Designed for Windows Extend and Duplicate with a separate controller device.</p>
        </Panel>
      </div>
    </>
  );
}

function SessionPage() {
  const titleId = useId();

  return (
    <section className="console-stack ui-reveal" aria-labelledby={titleId}>
      <div>
        <p className="ui-eyebrow">Setup checklist</p>
        <h1 id={titleId}>Session controls</h1>
        <p className="console-lead">
          Account authorization creates a presentation-scoped session. Pairing, playback, and
          publication remain bound to that session.
        </p>
      </div>
      <div className="console-grid">
        <Panel title="1. Choose the room" tone="inset">
          <p>
            Confirm the presentation title and target display before a future binding flow begins.
          </p>
        </Panel>
        <Panel title="2. Open public Stage" tone="inset">
          <p>
            Use a clean browser profile on the projected computer in either supported screen mode.
          </p>
        </Panel>
        <Panel title="3. Enter fullscreen there" tone="inset">
          <p>The Stage operator clicks fullscreen locally. Console never forces another window.</p>
        </Panel>
        <AudioConsentControl
          notice={{
            purpose: "Live Korean transcription and slide attribution",
            vendors: ["Session-selected transcription service"],
            region: "Configured processing region",
            retention: "Raw samples stay in memory for at most 30 seconds; no durable storage.",
            deletion: "Capture tracks and the remote stream close on stop or revoke.",
          }}
        />
      </div>
    </section>
  );
}

export function ConsoleRoutes({ coResident = false }: { readonly coResident?: boolean }) {
  return (
    <Routes>
      <Route element={<PublicOnly />}>
        <Route path="/sign-in" element={<SignInPage />} />
      </Route>
      <Route element={<RequireAuth />}>
        <Route element={<PrivateLayout coResident={coResident} />}>
          <Route index element={<OverviewPage />} />
          <Route path="/session" element={<SessionPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/sign-in" replace />} />
    </Routes>
  );
}
