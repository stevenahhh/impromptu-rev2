import { Brand } from "@impromptu/ui";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { type Locale, messages } from "./i18n";
import {
  AccountRegistrationError,
  type AccountRegistrationFailure,
  type AccountSessionView,
  type ActivePresentationView,
  type ConsoleDeckUploadClient,
  type ConsoleSessionClient,
  createConsoleSessionClient,
} from "./session-client";

type SignUpOutcome = "SUCCESS" | AccountRegistrationFailure;

interface AuthState {
  authenticated: boolean;
  /** True while a mount-time session read is in flight; private routes wait for it. */
  restoring: boolean;
  pending: boolean;
  error: string | null;
  session: AccountSessionView | null;
  client: ConsoleDeckUploadClient;
  activePresentation: ActivePresentationView | null;
  setActivePresentation: (presentation: ActivePresentationView | null) => void;
  displayBindingEpoch: string | null;
  // Null clears a binding the backend no longer honours, so every control stops claiming a
  // screen is connected and the next start press re-runs the open-and-bind path.
  setDisplayBindingEpoch: (epoch: string | null) => void;
  joinTimeoutMs: number | undefined;
  locale: Locale;
  setLocale: (locale: Locale) => void;
  signUp: (username: string, password: string) => Promise<SignUpOutcome>;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export interface AuthProviderProps {
  children: ReactNode;
  initialAuthenticated?: boolean;
  client?: ConsoleSessionClient;
  initialPresentation?: ActivePresentationView;
  initialDisplayBindingEpoch?: string;
  joinTimeoutMs?: number;
  /**
   * When true, the provider reads the server account session once on mount so a reload
   * restores the signed-in workspace. Tests default to no hydration and stay synchronous.
   */
  hydrateSession?: boolean;
}

export function AuthProvider({
  children,
  initialAuthenticated = false,
  client,
  initialPresentation,
  initialDisplayBindingEpoch,
  joinTimeoutMs,
  hydrateSession = false,
}: AuthProviderProps) {
  // The production client is already the typed deck-upload client; injected test
  // clients are narrower and never reach the upload panel.
  const sessionClient = useMemo(
    () => (client ?? createConsoleSessionClient()) as ConsoleDeckUploadClient,
    [client],
  );
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
  const [activePresentation, setActivePresentation] = useState<ActivePresentationView | null>(
    initialPresentation ?? null,
  );
  const [displayBindingEpoch, setDisplayBindingEpoch] = useState<string | null>(
    initialDisplayBindingEpoch ?? null,
  );
  const [locale, setLocale] = useState<Locale>("ko");
  const [restoring, setRestoring] = useState(hydrateSession && !initialAuthenticated);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  // One mount-time server read restores the account session across a reload. Nothing private
  // renders until it settles: RequireAuth/PublicOnly see `restoring` and wait instead of
  // bouncing a signed-in presenter through the sign-in page or vice versa.
  useEffect(() => {
    if (!hydrateSession) return;
    let cancelled = false;
    void sessionClient
      .readSession()
      .then((restored) => {
        if (cancelled || restored === null) return;
        setSession(restored);
      })
      .catch(() => {
        // A failed read means "still signed out": the presenter lands on the sign-in page,
        // never on half-restored private state.
      })
      .finally(() => {
        if (!cancelled) setRestoring(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hydrateSession, sessionClient]);
  const value = useMemo(
    () => ({
      authenticated: session !== null,
      restoring,
      pending,
      error,
      session,
      client: sessionClient,
      activePresentation,
      setActivePresentation,
      displayBindingEpoch,
      setDisplayBindingEpoch,
      joinTimeoutMs,
      locale,
      setLocale,
      async signUp(username: string, password: string): Promise<SignUpOutcome> {
        setPending(true);
        setError(null);
        try {
          await sessionClient.signUp(username, password);
          setSession(await sessionClient.signIn(username, password));
          return "SUCCESS";
        } catch (cause) {
          return cause instanceof AccountRegistrationError ? cause.reason : "UNKNOWN";
        } finally {
          setPending(false);
        }
      },
      async signIn(username: string, password: string) {
        setPending(true);
        setError(null);
        try {
          const next = await sessionClient.signIn(username, password);
          // The private workspace belongs to the arriving account: any deck, binding, or
          // preview state a previous session (or account) left behind clears before the new
          // session lands, so a re-login resumes from the server list rather than stale UI.
          if (session?.account.accountId !== next.account.accountId) {
            setActivePresentation(null);
            setDisplayBindingEpoch(null);
          }
          setSession(next);
        } catch {
          setError("SIGN_IN_FAILED");
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
          // Only after the server accepts: the deck and binding clear with the session, so a
          // half-accepted sign-out never strands private UI on screen or drops a session the
          // backend still considers live.
          setSession(null);
          setActivePresentation(null);
          setDisplayBindingEpoch(null);
        } catch {
          setError("SIGN_OUT_FAILED");
        } finally {
          setPending(false);
        }
      },
    }),
    [
      activePresentation,
      displayBindingEpoch,
      error,
      joinTimeoutMs,
      locale,
      pending,
      restoring,
      session,
      sessionClient,
    ],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth() {
  const auth = useContext(AuthContext);
  if (!auth) {
    throw new Error("AuthProvider is required");
  }
  return auth;
}

export function RequireAuth() {
  const { authenticated, restoring } = useAuth();
  const location = useLocation();

  if (restoring) return null;
  return authenticated ? (
    <Outlet />
  ) : (
    <Navigate to="/sign-in" replace state={{ from: location.pathname }} />
  );
}

export function PublicOnly() {
  const { authenticated, restoring } = useAuth();
  if (restoring) return null;
  return authenticated ? <Navigate to="/" replace /> : <Outlet />;
}

export function LanguagePicker() {
  const { locale, setLocale } = useAuth();
  return (
    <fieldset className="console-language-picker" aria-label="Language">
      <button
        type="button"
        aria-label="한국어"
        aria-pressed={locale === "ko"}
        title="한국어"
        onClick={() => setLocale("ko")}
      >
        <span aria-hidden="true">KO</span>
      </button>
      <button
        type="button"
        aria-label="English"
        aria-pressed={locale === "en"}
        title="English"
        onClick={() => setLocale("en")}
      >
        <span aria-hidden="true">EN</span>
      </button>
    </fieldset>
  );
}

export function ConsoleHeader() {
  const { locale } = useAuth();
  const text = messages(locale);
  return (
    <div className="console-header">
      <Brand eyebrow={text.presenterConsole} />
      <div className="console-header__actions">
        <LanguagePicker />
      </div>
    </div>
  );
}
