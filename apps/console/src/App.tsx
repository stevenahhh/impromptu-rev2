import { Badge, Brand, Button, Panel, Shell, StatusDot } from "@impromptu/ui";
import { createContext, type ReactNode, useContext, useId, useMemo, useState } from "react";
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation } from "react-router-dom";

interface AuthState {
  authenticated: boolean;
  signIn: () => void;
  signOut: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export interface AuthProviderProps {
  children: ReactNode;
  initialAuthenticated?: boolean;
}

export function AuthProvider({ children, initialAuthenticated = false }: AuthProviderProps) {
  const [authenticated, setAuthenticated] = useState(initialAuthenticated);
  const value = useMemo(
    () => ({
      authenticated,
      signIn: () => setAuthenticated(true),
      signOut: () => setAuthenticated(false),
    }),
    [authenticated],
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
  const { signIn } = useAuth();

  return (
    <Shell focused header={<ConsoleHeader />}>
      <Panel className="console-sign-in ui-reveal">
        <p className="ui-eyebrow">Private origin</p>
        <h1>Private presentation control</h1>
        <p className="console-lead">
          Your setup, coaching, and team notes stay here. Nothing on this screen belongs on the
          audience display.
        </p>
        <Button onClick={signIn}>Enter private workspace</Button>
        <p className="console-caption">
          Foundation preview - no account or backend connection yet.
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
      <Button variant="quiet" onClick={signOut}>
        Leave workspace
      </Button>
    </aside>
  );
}

function PrivateLayout() {
  return (
    <Shell header={<ConsoleHeader />}>
      <PrivateNavigation />
      <div className="console-content">
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
          This browser-only foundation stops before pairing, transport, capture, or publication
          protocols.
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
      </div>
    </section>
  );
}

export function ConsoleRoutes() {
  return (
    <Routes>
      <Route element={<PublicOnly />}>
        <Route path="/sign-in" element={<SignInPage />} />
      </Route>
      <Route element={<RequireAuth />}>
        <Route element={<PrivateLayout />}>
          <Route index element={<OverviewPage />} />
          <Route path="/session" element={<SessionPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/sign-in" replace />} />
    </Routes>
  );
}
