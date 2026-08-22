import { createCoachingState, reduceCoachingState } from "@impromptu/state/coaching";
import {
  Badge,
  Brand,
  Button,
  Panel,
  RenderedSlide,
  rebaseDeckAssetUrl,
  Shell,
} from "@impromptu/ui";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Link,
  Navigate,
  NavLink,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import {
  type AudienceScreenController,
  type AudienceScreenStatus,
  useAudienceScreen,
} from "./audience-screen";
import { CoachingDisplay } from "./coaching-display";
import { CockpitAudioCapture } from "./cockpit-audio-capture";
import { EvidenceCard } from "./evidence-card";
import { type Locale, messages } from "./i18n";
import { PresentationReport } from "./presentation-report";
import {
  AccountRegistrationError,
  type AccountRegistrationFailure,
  type AccountSessionView,
  type ActivePresentationView,
  type ConsoleDeckUploadClient,
  type ConsoleSessionClient,
  createConsoleSessionClient,
  type DisplayJoinView,
  type LiveCandidateSnapshotView,
  type PrivateEvidenceCardView,
  type SessionReportView,
} from "./session-client";

declare global {
  var CAPTURE_NOTICE: Readonly<{
    purpose: string;
    vendors: readonly string[];
    region: string;
    retention: string;
    deletion: string;
  }>;
}

globalThis.CAPTURE_NOTICE = {
  purpose: "Local speech transcription and private presenter assistance",
  vendors: ["local-whisper"],
  region: "Local device service",
  retention: "Memory queue only, up to 30 seconds",
  deletion: "Deleted when capture stops",
} as const;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function coachingEventFromServer(input: unknown, sessionOffsetMs: number): unknown {
  const envelope = record(input);
  if (envelope?.kind !== "TRANSCRIPT") return null;
  const event = record(envelope.event);
  if (event === null) return null;
  const base = {
    sessionGeneration: event.sessionGeneration,
    sequence: event.sequence,
    segmentId: event.segmentId,
  };
  const transcript = record(event.transcript);
  if (event.kind === "PARTIAL") {
    return { ...base, kind: "PARTIAL", preview: transcript?.text };
  }
  if (event.kind === "REPLACE") {
    return {
      ...base,
      kind: "REPLACE",
      replacesSequence: event.replacesSequence,
      preview: transcript?.text,
    };
  }
  if (event.kind !== "FINAL" || transcript === null || !Array.isArray(transcript.words)) {
    return null;
  }
  const durationMs = transcript.durationMs;
  if (typeof durationMs !== "number") return null;
  return {
    ...base,
    kind: "FINAL",
    finalSegmentId: event.finalSegmentId,
    finalizedAtSessionMs: sessionOffsetMs + durationMs,
    words: transcript.words.map((value) => {
      const word = record(value);
      return {
        text: word?.text,
        startSessionMs:
          typeof word?.startMs === "number" ? sessionOffsetMs + word.startMs : word?.startMs,
        endSessionMs: typeof word?.endMs === "number" ? sessionOffsetMs + word.endMs : word?.endMs,
      };
    }),
  };
}

type SignUpOutcome = "SUCCESS" | AccountRegistrationFailure;

interface AuthState {
  authenticated: boolean;
  pending: boolean;
  error: string | null;
  session: AccountSessionView | null;
  client: ConsoleDeckUploadClient;
  activePresentation: ActivePresentationView | null;
  setActivePresentation: (presentation: ActivePresentationView | null) => void;
  displayBindingEpoch: string | null;
  setDisplayBindingEpoch: (epoch: string) => void;
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
}

export function AuthProvider({
  children,
  initialAuthenticated = false,
  client,
  initialPresentation,
  initialDisplayBindingEpoch,
  joinTimeoutMs,
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
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const value = useMemo(
    () => ({
      authenticated: session !== null,
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
          setSession(await sessionClient.signIn(username, password));
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
          setSession(null);
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
      session,
      sessionClient,
    ],
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

function LanguagePicker() {
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

function ConsoleHeader() {
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

function SignInPage() {
  const { error, locale, pending, signIn } = useAuth();
  const text = messages(locale);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  return (
    <Shell focused header={<ConsoleHeader />} skipLabel={text.skipToContent}>
      <Panel className="console-sign-in ui-reveal">
        <h1>{text.signInTitle}</h1>
        <p className="console-lead">{text.signInLead}</p>
        <label className="console-field">
          <span>{text.username}</span>
          <input
            autoComplete="username"
            data-sign-in-username
            value={username}
            onChange={(event) => setUsername(event.currentTarget.value)}
          />
        </label>
        <label className="console-field">
          <span>{text.password}</span>
          <input
            autoComplete="current-password"
            data-sign-in-password
            type="password"
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
          />
        </label>
        <Button
          data-sign-in-submit
          disabled={pending || username.length === 0 || password.length === 0}
          onClick={() => void signIn(username, password)}
        >
          {pending ? text.signingIn : text.enterWorkspace}
        </Button>
        <p className="console-caption" aria-live="polite">
          {error === null ? text.signInPrivacy : text.signInFailed}
        </p>
        <p className="console-caption">
          {text.needAccount} <Link to="/sign-up">{text.signUpLink}</Link>
        </p>
      </Panel>
    </Shell>
  );
}

const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])$/;
const MINIMUM_PASSWORD_LENGTH = 8;

function SignUpPage() {
  const { locale, pending, signUp } = useAuth();
  const text = messages(locale);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [failure, setFailure] = useState<AccountRegistrationFailure | null>(null);

  const submit = async () => {
    const normalizedUsername = username.trim().toLowerCase();
    if (!USERNAME_PATTERN.test(normalizedUsername)) {
      setFailure("USERNAME_INVALID");
      return;
    }
    if (password.length < MINIMUM_PASSWORD_LENGTH) {
      setFailure("PASSWORD_TOO_SHORT");
      return;
    }
    const outcome = await signUp(username, password);
    setFailure(outcome === "SUCCESS" ? null : outcome);
  };

  const failureMessage =
    failure === "USERNAME_TAKEN"
      ? text.signUpUsernameTaken
      : failure === "USERNAME_INVALID"
        ? text.signUpUsernameInvalid
        : failure === "PASSWORD_TOO_SHORT"
          ? text.signUpPasswordTooShort
          : failure === "UNKNOWN"
            ? text.signUpFailed
            : text.signUpPrivacy;

  return (
    <Shell focused header={<ConsoleHeader />} skipLabel={text.skipToContent}>
      <Panel className="console-sign-in ui-reveal">
        <h1>{text.signUpTitle}</h1>
        <p className="console-lead">{text.signUpLead}</p>
        <label className="console-field">
          <span>{text.username}</span>
          <input
            autoComplete="username"
            data-sign-up-username
            value={username}
            onChange={(event) => {
              setUsername(event.currentTarget.value);
              setFailure(null);
            }}
          />
          <span>{text.signUpUsernameRules}</span>
        </label>
        <label className="console-field">
          <span>{text.password}</span>
          <input
            autoComplete="new-password"
            data-sign-up-password
            type="password"
            value={password}
            onChange={(event) => {
              setPassword(event.currentTarget.value);
              setFailure(null);
            }}
          />
          <span>{text.signUpPasswordRules}</span>
        </label>
        <Button
          data-sign-up-submit
          disabled={pending || username.length === 0 || password.length === 0}
          onClick={() => void submit()}
        >
          {pending ? text.signingUp : text.createAccount}
        </Button>
        <p
          className={`console-caption${failure === null ? "" : " console-caption--error"}`}
          aria-live="polite"
          data-sign-up-error={failure ?? undefined}
        >
          {failureMessage}
        </p>
        <p className="console-caption">
          {text.haveAccount} <Link to="/sign-in">{text.signInLink}</Link>
        </p>
      </Panel>
    </Shell>
  );
}

function PrivateNavigation() {
  const { locale, signOut } = useAuth();
  const location = useLocation();
  const text = messages(locale);
  const isWorkspace = location.pathname === "/" || location.pathname === "/session";

  return (
    <div className="console-header console-app-bar">
      <Brand eyebrow={text.presenterConsole} />
      <nav aria-label={text.privateWorkspace} className="console-nav">
        {isWorkspace ? (
          <NavLink to="/live-publication">{text.evidenceApproval}</NavLink>
        ) : (
          <NavLink to="/" end>
            {text.workspace}
          </NavLink>
        )}
      </nav>
      <div className="console-header__actions">
        <LanguagePicker />
        <Button variant="quiet" onClick={() => void signOut()}>
          {text.leave}
        </Button>
      </div>
    </div>
  );
}

function PrivateLayout({ coResident }: { readonly coResident: boolean }) {
  const { locale } = useAuth();
  const text = messages(locale);
  const [coResidentState, setCoResidentState] = useState<"OFF" | "ENABLED" | "DISABLED">(
    coResident ? "ENABLED" : "OFF",
  );
  const [controllerLifecycle, setControllerLifecycle] = useState<"ACTIVE" | "BACKGROUND">("ACTIVE");

  useEffect(() => {
    const observeVisibility = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      const next =
        typeof detail === "object" && detail !== null && detail.state === "BACKGROUND"
          ? "BACKGROUND"
          : document.visibilityState === "hidden"
            ? "BACKGROUND"
            : "ACTIVE";
      setControllerLifecycle(next);
      window.dispatchEvent(
        new CustomEvent("impromptu:controller-lifecycle", { detail: { state: next } }),
      );
    };
    document.addEventListener("visibilitychange", observeVisibility);
    return () => document.removeEventListener("visibilitychange", observeVisibility);
  }, []);

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
      <Shell focused header={<Brand eyebrow={text.publicSafety} />} skipLabel={text.skipToContent}>
        <main
          className="console-co-resident-shield"
          data-co-resident-state="DISABLED"
          data-controller-lifecycle={controllerLifecycle}
        >
          <p className="ui-eyebrow">{text.audienceProtected}</p>
          <h1>{text.coResidentDisabled}</h1>
          <p>{text.moveControl}</p>
        </main>
      </Shell>
    );
  }

  return (
    <Shell header={<PrivateNavigation />} skipLabel={text.skipToContent}>
      <div
        className="console-content"
        data-co-resident-state={coResidentState}
        data-controller-lifecycle={controllerLifecycle}
      >
        {coResidentState === "ENABLED" ? (
          <aside className="console-co-resident" role="alert">
            <strong>{text.coResidentMode}</strong>
            <span>{text.coResidentLead}</span>
          </aside>
        ) : null}
        <Outlet />
      </div>
    </Shell>
  );
}

function publishApprovalLoadEvent(detail: Readonly<Record<string, unknown>>): void {
  window.dispatchEvent(new CustomEvent("impromptu:approval-load", { detail }));
}

function LivePublicationPage() {
  const titleId = useId();
  const { activePresentation, client, locale, session } = useAuth();
  const text = messages(locale);
  const presentationSessionId = activePresentation?.presentationSessionId ?? "";
  const [snapshot, setSnapshot] = useState<LiveCandidateSnapshotView | null>(null);
  const [pendingCandidateId, setPendingCandidateId] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const loadSnapshot = useCallback(async () => {
    setMessage(text.loadingSnapshot);
    try {
      const next = await client.readLiveCandidates(presentationSessionId);
      setSnapshot(next);
      publishApprovalLoadEvent({ type: "SNAPSHOT_LOADED", atMs: performance.now() });
      setMessage(
        next.livePublicEnabled
          ? locale === "ko"
            ? `검토할 실시간 제안 ${next.candidates.length}개를 불러왔습니다.`
            : `${next.candidates.length} fresh live candidate${next.candidates.length === 1 ? "" : "s"}.`
          : locale === "ko"
            ? "실시간 공개가 비활성화되어 있습니다. 확인된 제안은 비공개로 유지됩니다."
            : "Live public is fail-closed. Verified candidates remain private.",
      );
    } catch {
      setSnapshot(null);
      setMessage(text.snapshotFailed);
    }
  }, [client, locale, presentationSessionId, text]);

  useEffect(() => {
    if (activePresentation !== null) void loadSnapshot();
  }, [activePresentation, loadSnapshot]);

  const approve = async (candidate: LiveCandidateSnapshotView["candidates"][number]) => {
    if (snapshot === null || session === null) return;
    setPendingCandidateId(candidate.candidateId);
    setMessage(text.submittingApproval);
    const approvalId = crypto.randomUUID();
    publishApprovalLoadEvent({
      type: "APPROVAL_REQUESTED",
      approvalId,
      atMs: performance.now(),
    });
    let outcome = "REJECTED";
    try {
      await client.approveLiveCandidate(session.csrfToken, snapshot, candidate, approvalId);
      outcome = "PUBLISHED";
      setSnapshot(null);
      setMessage(text.published);
    } catch {
      setSnapshot(null);
      setMessage(text.liveApprovalFailed);
    } finally {
      publishApprovalLoadEvent({
        type: "APPROVAL_SETTLED",
        approvalId,
        outcome,
        atMs: performance.now(),
      });
      setPendingCandidateId(null);
    }
  };

  return (
    <section className="console-stack ui-reveal" aria-labelledby={titleId}>
      <div>
        <h1 id={titleId}>{text.liveApproval}</h1>
        <p className="console-lead">{text.liveApprovalLead}</p>
      </div>
      <Panel title={text.snapshotTitle} tone="inset">
        <p>{activePresentation === null ? text.approvalNeedsDeck : text.autoSuggestions}</p>
        <Button disabled={presentationSessionId.length === 0} onClick={() => void loadSnapshot()}>
          {activePresentation === null ? text.loadCandidates : text.refreshSuggestions}
        </Button>
        <p className="console-caption" aria-live="polite">
          {message || text.approvalInitial}
        </p>
      </Panel>
      {snapshot?.candidates.map((candidate) => (
        <Panel key={candidate.candidateId} title={candidate.claimText}>
          <p>{candidate.evidenceExcerpt}</p>
          <Button
            disabled={!snapshot.livePublicEnabled || pendingCandidateId !== null}
            onClick={() => void approve(candidate)}
          >
            {pendingCandidateId === candidate.candidateId ? text.approving : text.approveCard}
          </Button>
        </Panel>
      ))}
    </section>
  );
}

/**
 * The public Stage resolves its canonical entry for a deck through the landing
 * URL (`/?deck=<version>`, see apps/stage/src/App.tsx). The origin is the stage
 * dev server by default and can be overridden with VITE_STAGE_ORIGIN for
 * deployed rehearsal topologies.
 */
const STAGE_ORIGIN = process.env.NEXT_PUBLIC_STAGE_ORIGIN ?? "http://localhost:4174";

function stageUrl(deckVersion: string): string {
  return `${STAGE_ORIGIN}/?deck=${encodeURIComponent(deckVersion)}`;
}

function SessionUploadPanel({
  client,
  csrfToken,
}: {
  readonly client: ConsoleDeckUploadClient;
  readonly csrfToken: string;
}) {
  const { locale, setActivePresentation } = useAuth();
  const text = messages(locale);
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<"IDLE" | "UPLOADING" | "SUCCESS" | "ERROR">("IDLE");
  const [message, setMessage] = useState("");
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  // The picker label carries [data-deck-upload-submit] for the Playwright harnesses, so a
  // stray click on it after the input already has files must never re-send the same deck.
  const uploadInFlight = useRef(false);

  const uploadFile = async (selected: File) => {
    if (uploadInFlight.current) return;
    uploadInFlight.current = true;
    setFile(selected);
    setPhase("UPLOADING");
    setMessage(text.uploading);
    try {
      const next = await client.uploadDeck(csrfToken, selected);
      setActivePresentation({
        presentationSessionId: next.presentationSessionId,
        presentationSessionEpoch: next.presentationSessionEpoch,
        deckVersion: next.deckVersion,
        ...publicManifest(next.publicDeck),
        slides: publicSlides(next.publicDeck),
      });
      setPhase("SUCCESS");
    } catch {
      setPhase("ERROR");
      setMessage(text.uploadFailed);
    } finally {
      uploadInFlight.current = false;
    }
  };

  return (
    <Panel className="console-upload-panel" tone="inset">
      <section
        className={`console-dropzone${phase === "UPLOADING" ? " console-dropzone--busy" : ""}`}
        data-dragging={dragging}
        data-upload-dropzone
        aria-label={text.uploadTitle}
        onDragEnter={(event) => {
          event.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          const dropped = event.dataTransfer.files[0];
          if (dropped !== undefined) void uploadFile(dropped);
        }}
      >
        <h2>{text.uploadTitle}</h2>
        <p>{text.uploadLead}</p>
        <label className="ui-button ui-button--quiet console-file-button" data-deck-upload-submit>
          <span>{phase === "UPLOADING" ? text.uploading : text.chooseFile}</span>
          <input
            accept=".pptx,.pdf"
            data-deck-file-input
            disabled={phase === "UPLOADING"}
            type="file"
            onChange={(event) => {
              const selected = event.currentTarget.files?.[0];
              if (selected !== undefined) void uploadFile(selected);
            }}
          />
        </label>
        {file === null ? null : <p className="console-selected-file">{file.name}</p>}
      </section>
      <p
        className={`console-status-line${phase === "ERROR" ? " console-status-line--attention" : ""}`}
        aria-live="polite"
        data-upload-status={phase}
      >
        {phase === "SUCCESS"
          ? `${text.deckAccepted} ${text.presentationReady}`
          : message || text.uploadSelect}
      </p>
    </Panel>
  );
}

function publicManifest(value: unknown): Pick<ActivePresentationView, "manifestHash"> {
  if (typeof value !== "object" || value === null) return {};
  const manifestHash = (value as Record<string, unknown>).manifestHash;
  return typeof manifestHash === "string" ? { manifestHash } : {};
}

function publicSlides(value: unknown): ActivePresentationView["slides"] {
  if (typeof value !== "object" || value === null) return [];
  const slides = (value as Record<string, unknown>).slides;
  if (!Array.isArray(slides)) return [];
  return slides.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const slide = value as Record<string, unknown>;
    if (
      typeof slide.publicSlideKey !== "string" ||
      typeof slide.ordinal !== "number" ||
      typeof slide.accessibilityLabel !== "string"
    ) {
      return [];
    }
    const image = slide.image;
    const parsedImage =
      typeof image === "object" &&
      image !== null &&
      typeof (image as Record<string, unknown>).url === "string" &&
      typeof (image as Record<string, unknown>).contentHash === "string" &&
      typeof (image as Record<string, unknown>).width === "number" &&
      typeof (image as Record<string, unknown>).height === "number"
        ? {
            url: (image as Record<string, unknown>).url as string,
            contentHash: (image as Record<string, unknown>).contentHash as string,
            width: (image as Record<string, unknown>).width as number,
            height: (image as Record<string, unknown>).height as number,
          }
        : undefined;
    return [
      {
        publicSlideKey: slide.publicSlideKey,
        ordinal: slide.ordinal,
        accessibilityLabel: slide.accessibilityLabel,
        ...(parsedImage === undefined ? {} : { image: parsedImage }),
      },
    ];
  });
}

function PresentationWorkspacePage() {
  const titleId = useId();
  const {
    activePresentation,
    client,
    joinTimeoutMs,
    locale,
    session,
    setActivePresentation,
    setDisplayBindingEpoch,
  } = useAuth();
  const text = messages(locale);
  const [activeIndex, setActiveIndex] = useState(0);
  // Pairing lives here because the primary action and the connection options are two views of
  // the same handshake: the presenter should never have to drive them separately.
  const audience = useAudienceScreen({
    stageOrigin: new URL(STAGE_ORIGIN).origin,
    stageUrl: activePresentation === null ? "" : stageUrl(activePresentation.deckVersion),
    deckVersion: activePresentation?.deckVersion ?? "",
    async approveJoin(join) {
      if (session === null || activePresentation === null || client.approveDisplay === undefined) {
        throw new Error("audience approval is unavailable in this session");
      }
      return await client.approveDisplay(session.csrfToken, activePresentation, join);
    },
    onBound: setDisplayBindingEpoch,
    ...(joinTimeoutMs === undefined ? {} : { joinTimeoutMs }),
  });
  const [coachingState, setCoachingState] = useState(createCoachingState);
  const [wordTimingCapable, setWordTimingCapable] = useState(false);
  const coachingSessionOffsetMs = useRef(0);
  const coachingIdentity =
    activePresentation === null
      ? ""
      : `${activePresentation.presentationSessionId}:${activePresentation.presentationSessionEpoch}`;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousPresentation = useRef(activePresentation);

  useEffect(() => {
    if (previousPresentation.current === null && activePresentation !== null) {
      headingRef.current?.focus();
    }
    previousPresentation.current = activePresentation;
  }, [activePresentation]);

  useEffect(() => {
    if (coachingIdentity.length === 0) return;
    coachingSessionOffsetMs.current = 0;
    setWordTimingCapable(false);
    setCoachingState(createCoachingState());
  }, [coachingIdentity]);

  const onCoachingOptInChange = useCallback((enabled: boolean) => {
    setCoachingState((state) => reduceCoachingState(state, { kind: "OPT_IN", enabled }).state);
  }, []);

  const onCoachingMuteChange = useCallback((muted: boolean) => {
    setCoachingState((state) => reduceCoachingState(state, { kind: "MUTE", muted }).state);
  }, []);

  const onAudioServerEvent = useCallback((input: unknown) => {
    const envelope = record(input);
    if (typeof envelope?.wordTimingCapable === "boolean") {
      setWordTimingCapable(envelope.wordTimingCapable);
    } else if (envelope?.kind === "TERMINAL") {
      setWordTimingCapable(false);
    }
    setCoachingState((state) => {
      const event = coachingEventFromServer(input, coachingSessionOffsetMs.current);
      const reduced = reduceCoachingState(state, event);
      const eventRecord = record(event);
      const finalizedAtSessionMs = eventRecord?.finalizedAtSessionMs;
      if (
        reduced.outcome === "APPLIED" &&
        eventRecord?.kind === "FINAL" &&
        typeof finalizedAtSessionMs === "number"
      ) {
        coachingSessionOffsetMs.current = finalizedAtSessionMs;
      }
      return reduced.state;
    });
  }, []);

  return (
    <section
      className={`console-workspace${activePresentation === null ? "" : " console-workspace--presenting"}`}
      aria-labelledby={titleId}
    >
      <header className="console-workspace__intro">
        <h1 ref={headingRef} id={titleId} tabIndex={-1}>
          {activePresentation === null ? text.startTitle : text.readyTitle}
        </h1>
        <p className="console-lead">
          {activePresentation === null ? text.startLead : text.readyLead}
        </p>
        {activePresentation === null ? null : (
          <Button data-new-deck variant="quiet" onClick={() => setActivePresentation(null)}>
            {text.newDeck}
          </Button>
        )}
      </header>
      {session === null ? null : activePresentation === null ? (
        <SessionUploadPanel client={client} csrfToken={session.csrfToken} />
      ) : (
        <div className="console-cockpit">
          <div className="console-cockpit__center">
            <SlidePreview index={activeIndex} />
            <PlaybackPanel audience={audience} index={activeIndex} onIndexChange={setActiveIndex} />
          </div>
          <div className="console-cockpit__side">
            <CockpitAudioCapture
              key={`${activePresentation.presentationSessionId}:${activePresentation.presentationSessionEpoch}`}
              csrfToken={session.csrfToken}
              presentationSessionId={activePresentation.presentationSessionId}
              presentationSessionEpoch={activePresentation.presentationSessionEpoch}
              actorId={session.account.actorId}
              notice={CAPTURE_NOTICE}
              onServerEvent={onAudioServerEvent}
            />
            <CoachingDisplay
              state={coachingState}
              wordTimingCapable={wordTimingCapable}
              onOptInChange={onCoachingOptInChange}
              onMuteChange={onCoachingMuteChange}
              text={{
                title: text.coachingTitle,
                optIn: text.coachingOptIn,
                mute: text.coachingMute,
                unavailable: text.coachingUnavailable,
                currentPace: text.coachingCurrentPace,
                previousPace: text.coachingPreviousPace,
                delta: text.coachingDelta,
                cueCount: text.coachingCueCount,
              }}
            />
            <EvidencePreparationPanel
              key={`${activePresentation.presentationSessionId}:${activePresentation.deckVersion}:${activePresentation.manifestHash ?? ""}`}
            />
            <SlideWorkspace activeIndex={activeIndex} onSelect={setActiveIndex} />
            <AudienceScreenPanel audience={audience} />
          </div>
        </div>
      )}
    </section>
  );
}

function orderedSlides(presentation: ActivePresentationView): ActivePresentationView["slides"] {
  return [...presentation.slides].sort((left, right) => left.ordinal - right.ordinal);
}

function SlideWorkspace({
  activeIndex,
  onSelect,
}: {
  readonly activeIndex: number;
  readonly onSelect: (index: number) => void;
}) {
  const { activePresentation, locale } = useAuth();
  if (activePresentation === null) return null;
  const text = messages(locale);
  const slides = orderedSlides(activePresentation);
  return (
    <section className="console-slides" aria-label={text.slideRail}>
      <div className="console-slides__header">
        <h2>{text.slidesCount.replace("{count}", String(slides.length))}</h2>
      </div>
      <ol className="console-slide-list">
        {slides.map((slide, index) => (
          <li key={slide.publicSlideKey}>
            <button
              type="button"
              aria-current={index === activeIndex}
              data-slide-thumb={slide.publicSlideKey}
              onClick={() => onSelect(index)}
            >
              <span>{slide.ordinal}</span>
              <strong>{slide.accessibilityLabel}</strong>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

function SlidePreview({ index }: { readonly index: number }) {
  const { activePresentation, locale } = useAuth();
  if (activePresentation === null) return null;
  const text = messages(locale);
  const slides = orderedSlides(activePresentation);
  const slide = slides[index];
  return (
    <section className="console-preview" aria-label={text.slidePreview}>
      <div className="console-preview__frame" data-slide-preview>
        {slide?.image === undefined ? (
          <p className="console-preview__status" role="alert">
            {text.slideLoadFailed}
          </p>
        ) : (
          <RenderedSlide
            key={`${slide.publicSlideKey}:${slide.image.contentHash}`}
            slide={{
              imageUrl: rebaseDeckAssetUrl(slide.image.url),
              imageContentHash: slide.image.contentHash,
              accessibilityLabel: slide.accessibilityLabel,
            }}
            loadingLabel={text.slideLoading}
            errorLabel={text.slideLoadFailed}
          />
        )}
        <p className="console-preview__position">
          {index + 1} / {slides.length}
        </p>
      </div>
    </section>
  );
}

type PreparedEvidenceCard = PrivateEvidenceCardView &
  Readonly<{
    id: string;
    summary: string;
  }>;

function EvidencePreparationPanel() {
  const { activePresentation, client, locale, session } = useAuth();
  const text = messages(locale);
  const canPrepare =
    activePresentation !== null &&
    activePresentation.manifestHash !== undefined &&
    session !== null &&
    activePresentation.slides.length > 0;
  const [preparedEvidence, setPreparedEvidence] = useState<readonly PreparedEvidenceCard[]>([]);
  const [pendingCount, setPendingCount] = useState(
    canPrepare && activePresentation !== null ? activePresentation.slides.length : 0,
  );

  useEffect(() => {
    setPreparedEvidence([]);
    if (activePresentation === null || session === null) {
      setPendingCount(0);
      return;
    }
    const manifestHash = activePresentation.manifestHash;
    if (manifestHash === undefined || activePresentation.slides.length === 0) {
      setPendingCount(0);
      return;
    }

    let active = true;
    const controller = new AbortController();
    setPendingCount(activePresentation.slides.length);
    for (const slide of activePresentation.slides) {
      void (async () => {
        try {
          const result = await client.recommend(
            session.csrfToken,
            {
              query: slide.accessibilityLabel,
              deckVersion: activePresentation.deckVersion,
              manifestHash,
              maxResults: 3,
            },
            controller.signal,
          );
          if (!active || result.outcome !== "RECOMMEND") return;
          const cards = result.evidence.map((evidence) => ({
            ...evidence,
            id: `${slide.publicSlideKey}:${evidence.evidenceId}`,
            summary: result.recommendation.claim,
          }));
          setPreparedEvidence((current) => [...current, ...cards]);
        } catch {
          // Individual evidence failures stay quiet and never interrupt presentation controls.
        } finally {
          if (active) setPendingCount((current) => Math.max(0, current - 1));
        }
      })();
    }
    return () => {
      active = false;
      controller.abort();
    };
  }, [activePresentation, client, session]);

  const status = pendingCount > 0 ? "PREPARING" : preparedEvidence.length > 0 ? "READY" : "EMPTY";
  return (
    <Panel className="console-evidence-preparation" title={text.preparedEvidence} tone="inset">
      <div data-evidence-status={status}>
        {preparedEvidence.length === 0 ? null : (
          <ul className="console-evidence-list">
            {preparedEvidence.map((evidence) => (
              <li key={evidence.id}>
                <EvidenceCard
                  card={evidence}
                  text={{
                    summary: text.evidenceSummary,
                    sourceUrl: text.evidenceSourceUrl,
                    sourceDate: text.evidenceSourceDate,
                    rights: text.evidenceRights,
                    sourceUnavailable: text.sourceUnavailable,
                    dateUnavailable: text.evidenceDateUnavailable,
                    internalApproved: text.evidenceInternalApproved,
                    externalUnknown: text.evidenceExternalUnknown,
                  }}
                />
              </li>
            ))}
          </ul>
        )}
        <p className="console-evidence-caption">
          {pendingCount > 0
            ? text.evidencePreparingQuietly
            : preparedEvidence.length > 0
              ? text.evidencePrepared
              : text.evidenceEmpty}
        </p>
      </div>
    </Panel>
  );
}

function decodeDisplayJoin(value: string): DisplayJoinView | null {
  try {
    const decoded = JSON.parse(atob(value.trim())) as Record<string, unknown>;
    return typeof decoded.displayJoinId === "string" &&
      typeof decoded.displayId === "string" &&
      typeof decoded.displayFingerprint === "string" &&
      typeof decoded.deckVersion === "string" &&
      typeof decoded.expiresAtMs === "number"
      ? (decoded as unknown as DisplayJoinView)
      : null;
  } catch {
    return null;
  }
}

/**
 * The rarely-needed connection paths. A screen the Console itself opened binds through the
 * primary action, because opening it was already the presenter's gesture and its handshake is
 * matched on source as well as origin. Everything in here serves the cases that gesture cannot
 * cover: a second device, a blocked popup, or a join reported by a window this Console did not
 * open - which never binds without the explicit approval below.
 */
function AudienceScreenPanel({ audience }: { readonly audience: AudienceScreenController }) {
  const { activePresentation, displayBindingEpoch, locale } = useAuth();
  const text = messages(locale);
  const [connectionCode, setConnectionCode] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  if (activePresentation === null) return null;

  // A join this Console did not open has nowhere else to surface, so it opens the disclosure
  // rather than waiting silently behind it.
  const expanded = advancedOpen || audience.pendingJoin !== null;

  return (
    <Panel
      className="console-stage-setup"
      title={text.stageTitle}
      tone="inset"
      data-audience-screen-panel={displayBindingEpoch === null ? "PENDING" : "CONNECTED"}
    >
      {displayBindingEpoch === null ? null : <Badge tone="success">{text.audienceConnected}</Badge>}
      <details
        className="console-advanced-connect"
        open={expanded}
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
      >
        <summary>{text.advancedConnect}</summary>
        <div className="console-stage-actions">
          <Button data-stage-open onClick={() => void audience.openAndBind()}>
            {text.openStagePreview}
          </Button>
          <Button
            variant="quiet"
            onClick={() =>
              void navigator.clipboard?.writeText(stageUrl(activePresentation.deckVersion))
            }
          >
            {text.copyStage}
          </Button>
        </div>
        <div
          className="console-stage-pairing"
          data-stage-pairing={audience.pendingJoin === null ? "WAITING" : "DETECTED"}
          data-join-display-id={audience.pendingJoin?.displayId}
        >
          {audience.pendingJoin === null ? (
            <p className="console-caption">{text.stageHandshakeWaiting}</p>
          ) : (
            <>
              <p>{text.stagePairPending}</p>
              <Button
                data-display-approve
                onClick={() => void audience.approve(audience.pendingJoin)}
              >
                {text.approveHandshake}
              </Button>
            </>
          )}
        </div>
        <p className="console-caption">{text.connectLead}</p>
        <label className="console-field">
          <span>{text.connectionCode}</span>
          <input
            value={connectionCode}
            onChange={(event) => setConnectionCode(event.currentTarget.value)}
          />
        </label>
        <Button
          disabled={connectionCode.length === 0}
          onClick={() => void audience.approve(decodeDisplayJoin(connectionCode))}
        >
          {text.approveDisplay}
        </Button>
      </details>
    </Panel>
  );
}

/** Plain-language recovery copy for the pairing states a presenter can actually land on. */
function audienceRecovery(
  status: AudienceScreenStatus,
  text: ReturnType<typeof messages>,
): { readonly message: string; readonly retry: string } | null {
  switch (status) {
    case "POPUP_BLOCKED":
      return { message: text.audiencePopupBlocked, retry: text.audienceRetry };
    case "JOIN_TIMEOUT":
      return { message: text.audienceJoinTimeout, retry: text.audienceReopen };
    case "BIND_FAILED":
      return { message: text.audienceBindFailed, retry: text.audienceRetry };
    case "DISCONNECTED":
      return { message: text.audienceDisconnected, retry: text.audienceReopen };
    default:
      return null;
  }
}

function PlaybackPanel({
  audience,
  index,
  onIndexChange,
}: {
  readonly audience: AudienceScreenController;
  readonly index: number;
  readonly onIndexChange: (index: number) => void;
}) {
  const { activePresentation, client, displayBindingEpoch, locale, session } = useAuth();
  const navigate = useNavigate();
  const text = messages(locale);
  const [controlRevision, setControlRevision] = useState("cr_0");
  const [presentationStarted, setPresentationStarted] = useState(false);
  const [starting, setStarting] = useState(false);
  const [ending, setEnding] = useState(false);
  const [message, setMessage] = useState("");
  if (activePresentation === null || session === null) return null;
  const slides = [...activePresentation.slides].sort((left, right) => left.ordinal - right.ordinal);
  const recovery = audienceRecovery(audience.status, text);

  // The binding can be passed in because a screen bound during this very click has not
  // reached context state yet.
  const show = async (nextIndex: number, binding?: string): Promise<boolean> => {
    const slide = slides[nextIndex];
    const epoch = binding ?? displayBindingEpoch;
    if (slide === undefined || epoch === null || client.setSlide === undefined) return false;
    try {
      const receipt = await client.setSlide(session.csrfToken, {
        presentationSessionId: activePresentation.presentationSessionId,
        publicSlideKey: slide.publicSlideKey,
        displayBindingEpoch: epoch,
        baseRevision: controlRevision,
      });
      onIndexChange(nextIndex);
      setControlRevision(receipt.acceptedControlRevision);
      setMessage(text.slideChanged);
      return true;
    } catch {
      setMessage(text.slideFailed);
      return false;
    }
  };

  const startPresentation = async () => {
    if (slides.length === 0 || starting) return;
    setStarting(true);
    try {
      let epoch = displayBindingEpoch;
      if (epoch === null) {
        // openAndBind calls window.open as its first statement, so it has to be reached inside
        // this click for the browser to honour the popup.
        const outcome = await audience.openAndBind();
        if (outcome.kind !== "CONNECTED") return;
        epoch = outcome.displayBindingEpoch;
      }
      if (await show(0, epoch)) {
        setPresentationStarted(true);
        setMessage(text.startedMessage);
      }
    } finally {
      setStarting(false);
    }
  };

  const endPresentation = async () => {
    if (client.endPresentationAndAwaitReport === undefined) return;
    setEnding(true);
    setMessage(text.reportFinalizing);
    try {
      const report = await client.endPresentationAndAwaitReport(
        session.csrfToken,
        activePresentation.presentationSessionId,
      );
      navigate(`/reports/${encodeURIComponent(activePresentation.presentationSessionId)}`, {
        state: { report },
      });
    } catch {
      setMessage(text.reportFinalizeFailed);
      setEnding(false);
    }
  };

  return (
    <Panel className="console-present" title={text.presenterConsole} tone="inset">
      <div className="console-present__controls">
        <div
          className="console-primary-action"
          data-presentation-state={presentationStarted ? "PRESENTING" : "READY"}
        >
          <Button
            disabled={slides.length === 0 || starting}
            onClick={() => void startPresentation()}
          >
            {presentationStarted
              ? text.started
              : starting
                ? text.startingPresentation
                : text.startPresentation}
          </Button>
          <p className="console-caption">
            {displayBindingEpoch === null ? text.audienceOpensBeside : text.audienceConnected}
          </p>
          {recovery === null ? null : (
            <output className="console-status-line console-status-line--attention">
              <span>{recovery.message}</span>
              <Button variant="quiet" onClick={() => void startPresentation()}>
                {recovery.retry}
              </Button>
              {audience.status === "POPUP_BLOCKED" ? (
                <Button
                  variant="quiet"
                  onClick={() =>
                    void navigator.clipboard?.writeText(stageUrl(activePresentation.deckVersion))
                  }
                >
                  {text.copyStage}
                </Button>
              ) : null}
            </output>
          )}
        </div>
        <div className="console-playback-actions">
          <Button
            variant="quiet"
            disabled={displayBindingEpoch === null || index === 0 || ending}
            onClick={() => void show(index - 1)}
          >
            {text.previousSlide}
          </Button>
          <Button
            disabled={displayBindingEpoch === null || index >= slides.length - 1 || ending}
            onClick={() => void show(index + 1)}
          >
            {text.nextSlide}
          </Button>
          <Button
            variant="quiet"
            disabled={
              !presentationStarted || ending || client.endPresentationAndAwaitReport === undefined
            }
            onClick={() => void endPresentation()}
          >
            {ending ? text.endingPresentation : text.endPresentation}
          </Button>
        </div>
      </div>
      <p className="console-caption" aria-live="polite">
        {message || text.connectControls}
      </p>
    </Panel>
  );
}

function navigationReport(value: unknown, presentationSessionId: string): SessionReportView | null {
  const state = record(value);
  const report = record(state?.report);
  return report?.reportVersion === 1 && report.presentationSessionId === presentationSessionId
    ? (report as unknown as SessionReportView)
    : null;
}

function PresentationReportPage() {
  const { client, locale } = useAuth();
  const text = messages(locale);
  const location = useLocation();
  const { presentationSessionId = "" } = useParams();
  const fromFinalization = navigationReport(location.state, presentationSessionId);
  const [report, setReport] = useState<SessionReportView | null>(fromFinalization);
  const [status, setStatus] = useState<"LOADING" | "PENDING" | "FORBIDDEN">(
    fromFinalization === null ? "LOADING" : "PENDING",
  );

  useEffect(() => {
    if (fromFinalization !== null) return;
    if (presentationSessionId.length === 0 || client.readFinalizedReport === undefined) {
      setStatus("FORBIDDEN");
      return;
    }
    let active = true;
    void client
      .readFinalizedReport(presentationSessionId)
      .then((result) => {
        if (!active) return;
        if (result.status === "FINALIZED") setReport(result.report);
        else setStatus("PENDING");
      })
      .catch(() => {
        if (active) setStatus("FORBIDDEN");
      });
    return () => {
      active = false;
    };
  }, [client, fromFinalization, presentationSessionId]);

  if (report === null) {
    return (
      <section className="console-stack ui-reveal" data-report-status={status}>
        <h1>{text.reportTitle}</h1>
        <Panel tone="inset">
          <p className="console-caption" aria-live="polite">
            {status === "LOADING"
              ? text.reportLoading
              : status === "PENDING"
                ? text.reportPending
                : text.reportUnavailable}
          </p>
        </Panel>
      </section>
    );
  }

  return (
    <PresentationReport
      report={report}
      text={{
        title: text.reportTitle,
        lead: text.reportLead,
        finalized: text.reportFinalized,
        totalDuration: text.reportTotalDuration,
        durationUnit: text.reportDurationUnit,
        slideVisits: text.reportSlideVisits,
        slide: text.reportSlide,
        occurrence: text.reportOccurrence,
        dwell: text.reportDwell,
        revisit: text.reportRevisit,
        firstVisit: text.reportFirstVisit,
        speech: text.reportSpeech,
        speechSummary: text.reportSpeechSummary,
        wordCount: text.reportWordCount,
        speakingDuration: text.reportSpeakingDuration,
        timingAggregate: text.reportTimingAggregate,
        finalCount: text.reportFinalCount,
        measuredFinalCount: text.reportMeasuredFinalCount,
        coachingAggregate: text.reportCoachingAggregate,
        cueCount: text.reportCueCount,
        currentPace: text.reportCurrentPace,
        previousPace: text.reportPreviousPace,
        unavailable: text.coachingUnavailable,
        preparedEvidence: text.preparedEvidence,
        evidenceEmpty: text.reportEvidenceEmpty,
        evidenceItem: text.reportEvidenceItem,
        evidenceSourceUrl: text.evidenceSourceUrl,
        evidenceProvenance: text.reportEvidenceProvenance,
        sourceUnavailable: text.sourceUnavailable,
        curatedEvidence: text.reportCuratedEvidence,
        liveEvidence: text.reportLiveEvidence,
      }}
    />
  );
}

export function ConsoleRoutes({ coResident = false }: { readonly coResident?: boolean }) {
  return (
    <Routes>
      <Route element={<PublicOnly />}>
        <Route path="/sign-in" element={<SignInPage />} />
        <Route path="/sign-up" element={<SignUpPage />} />
      </Route>
      <Route element={<RequireAuth />}>
        <Route element={<PrivateLayout coResident={coResident} />}>
          <Route index element={<PresentationWorkspacePage />} />
          <Route path="/session" element={<PresentationWorkspacePage />} />
          <Route path="/live-publication" element={<LivePublicationPage />} />
          <Route path="/reports/:presentationSessionId" element={<PresentationReportPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/sign-in" replace />} />
    </Routes>
  );
}
