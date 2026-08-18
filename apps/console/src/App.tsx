import { Badge, Brand, Button, Panel, Shell, StatusDot } from "@impromptu/ui";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation } from "react-router-dom";
import {
  type AccountSessionView,
  type ActivePresentationView,
  type ConsoleDeckUploadClient,
  type ConsoleSessionClient,
  createConsoleSessionClient,
  type DeckUploadView,
  type DisplayJoinView,
  type LiveCandidateSnapshotView,
} from "./session-client";
import { messages, type Locale } from "./i18n";
import {
  DEFAULT_PRESENTATION_TEMPLATES,
  type PresentationTemplate,
} from "./presentation-templates";

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
  locale: Locale;
  setLocale: (locale: Locale) => void;
  signIn: (authorizationCode: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export interface AuthProviderProps {
  children: ReactNode;
  initialAuthenticated?: boolean;
  client?: ConsoleSessionClient;
  initialPresentation?: ActivePresentationView;
  initialDisplayBindingEpoch?: string;
}

export function AuthProvider({
  children,
  initialAuthenticated = false,
  client,
  initialPresentation,
  initialDisplayBindingEpoch,
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
      locale,
      setLocale,
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
    [activePresentation, displayBindingEpoch, error, locale, pending, session, sessionClient],
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
    <div className="console-language-picker" role="group" aria-label="Language">
      <button
        type="button"
        aria-label="한국어"
        aria-pressed={locale === "ko"}
        title="한국어"
        onClick={() => setLocale("ko")}
      >
        <span aria-hidden="true">🇰🇷</span>
      </button>
      <button
        type="button"
        aria-label="English"
        aria-pressed={locale === "en"}
        title="English"
        onClick={() => setLocale("en")}
      >
        <span aria-hidden="true">🇺🇸</span>
      </button>
    </div>
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
        <Badge tone="success">
          <StatusDot label={text.localPreview} />
          {text.localPreview}
        </Badge>
      </div>
    </div>
  );
}

function SignInPage() {
  const { error, locale, pending, signIn } = useAuth();
  const text = messages(locale);
  const [authorizationCode, setAuthorizationCode] = useState("");

  return (
    <Shell focused header={<ConsoleHeader />} skipLabel={text.skipToContent}>
      <Panel className="console-sign-in ui-reveal">
        <h1>{text.signInTitle}</h1>
        <p className="console-lead">{text.signInLead}</p>
        <label className="console-field">
          <span>{text.signInCode}</span>
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
          {pending ? text.signingIn : text.enterWorkspace}
        </Button>
        <p className="console-caption" aria-live="polite">
          {error ?? text.signInPrivacy}
        </p>
      </Panel>
    </Shell>
  );
}

function PrivateNavigation() {
  const { locale, signOut } = useAuth();
  const text = messages(locale);

  return (
    <aside className="console-rail ui-reveal">
      <nav aria-label={text.privateWorkspace} className="console-nav">
        <NavLink to="/" end>
          {text.workspace}
        </NavLink>
        <NavLink to="/live-publication">{text.evidenceApproval}</NavLink>
      </nav>
      <Button variant="quiet" onClick={() => void signOut()}>
        {text.leave}
      </Button>
    </aside>
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
    <Shell header={<ConsoleHeader />} skipLabel={text.skipToContent}>
      <PrivateNavigation />
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
  const [fallbackPresentationSessionId, setFallbackPresentationSessionId] = useState("");
  const presentationSessionId =
    activePresentation?.presentationSessionId ?? fallbackPresentationSessionId;
  const [snapshot, setSnapshot] = useState<LiveCandidateSnapshotView | null>(null);
  const [pendingCandidateId, setPendingCandidateId] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const loadSnapshot = async () => {
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
    } catch (cause) {
      setSnapshot(null);
      setMessage(cause instanceof Error ? cause.message : "Snapshot failed.");
    }
  };

  useEffect(() => {
    if (activePresentation !== null) void loadSnapshot();
  }, [activePresentation]);

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
    } catch (cause) {
      setSnapshot(null);
      setMessage(
        cause instanceof Error
          ? `${cause.message}. Load a new authoritative snapshot.`
          : "Approval was rejected. Load a new authoritative snapshot.",
      );
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
        {activePresentation === null ? (
          <label className="console-field">
            <span>{text.sessionId}</span>
            <input
              value={fallbackPresentationSessionId}
              onChange={(event) => {
                setFallbackPresentationSessionId(event.currentTarget.value);
                setSnapshot(null);
              }}
            />
          </label>
        ) : (
          <p>{text.autoSuggestions}</p>
        )}
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
          <p className="console-caption">
            {candidate.occurrence.publicSlideKey} / occurrence {candidate.occurrence.occurrenceSeq}
          </p>
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
  const [view, setView] = useState<DeckUploadView | null>(null);

  const selectFile = (selected: File | null) => {
    setFile(selected);
    setView(null);
    setPhase("IDLE");
    setMessage("");
  };

  const upload = async () => {
    if (file === null) return;
    await uploadFile(file);
  };

  const uploadFile = async (selected: File) => {
    setFile(selected);
    setView(null);
    setPhase("UPLOADING");
    setMessage(text.uploading);
    try {
      const next = await client.uploadDeck(csrfToken, selected);
      setView(next);
      setActivePresentation({
        presentationSessionId: next.presentationSessionId,
        deckVersion: next.deckVersion,
        ...publicManifest(next.publicDeck),
        slides: publicSlides(next.publicDeck),
      });
      setPhase("SUCCESS");
    } catch (cause) {
      setPhase("ERROR");
      setMessage(cause instanceof Error ? cause.message : text.uploadFailed);
    }
  };

  return (
    <Panel className="console-upload-panel" tone="inset">
      <div
        className={`console-dropzone${phase === "UPLOADING" ? " console-dropzone--busy" : ""}`}
        data-upload-dropzone
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const dropped = event.dataTransfer.files[0];
          if (dropped !== undefined) void uploadFile(dropped);
        }}
      >
        <h2>{text.uploadTitle}</h2>
        <p>{text.uploadLead}</p>
        <label className="ui-button ui-button--quiet console-file-button">
          <span>{text.chooseFile}</span>
          <input
            accept=".pptx,.pdf"
            data-deck-file-input
            disabled={phase === "UPLOADING"}
            type="file"
            onChange={(event) => selectFile(event.currentTarget.files?.[0] ?? null)}
          />
        </label>
        {file === null ? null : <p className="console-selected-file">{file.name}</p>}
        <Button
          data-deck-upload-submit
          disabled={file === null || phase === "UPLOADING"}
          onClick={() => void upload()}
        >
          {phase === "UPLOADING" ? text.uploading : text.upload}
        </Button>
      </div>
      {phase === "SUCCESS" && view !== null ? (
        <div className="console-upload-ready" aria-live="polite" data-upload-status="SUCCESS">
          <p className="ui-eyebrow">{text.deckAccepted}</p>
          <p className="console-upload-heading">{text.presentationReady}</p>
          <p className="console-caption">{text.toolsReady}</p>
        </div>
      ) : (
        <p
          className={`console-caption${phase === "ERROR" ? " console-caption--error" : ""}`}
          aria-live="polite"
          data-upload-status={phase}
        >
          {message || text.uploadSelect}
        </p>
      )}
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
    return typeof slide.publicSlideKey === "string" &&
      typeof slide.ordinal === "number" &&
      typeof slide.accessibilityLabel === "string"
      ? [
          {
            publicSlideKey: slide.publicSlideKey,
            ordinal: slide.ordinal,
            accessibilityLabel: slide.accessibilityLabel,
          },
        ]
      : [];
  });
}

function PresentationTemplateSelector({
  selectedId,
  templates,
  onSelect,
}: {
  readonly selectedId: string;
  readonly templates: readonly PresentationTemplate[];
  readonly onSelect: (id: string) => void;
}) {
  const { locale } = useAuth();
  const text = messages(locale);
  return (
    <section className="console-template-library" aria-labelledby="template-library-title">
      <div>
        <h2 id="template-library-title">{text.templateLibrary}</h2>
        <p>{text.templateLibraryLead}</p>
      </div>
      <div className="console-template-grid" role="radiogroup" aria-label={text.templateLibrary}>
        {templates.map((template) => (
          <button
            key={template.id}
            type="button"
            role="radio"
            aria-checked={selectedId === template.id}
            data-presentation-template={template.id}
            onClick={() => onSelect(template.id)}
          >
            <strong>{template.name[locale]}</strong>
            <span>{template.description[locale]}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function PresentationWorkspacePage({
  templates,
}: {
  readonly templates: readonly PresentationTemplate[];
}) {
  const titleId = useId();
  const {
    activePresentation,
    client,
    displayBindingEpoch,
    locale,
    session,
    setActivePresentation,
  } = useAuth();
  const text = messages(locale);
  const [selectedTemplateId, setSelectedTemplateId] = useState(
    templates[0]?.id ?? DEFAULT_PRESENTATION_TEMPLATES[0].id,
  );
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousPresentation = useRef(activePresentation);

  useEffect(() => {
    if (previousPresentation.current === null && activePresentation !== null) {
      headingRef.current?.focus();
    }
    previousPresentation.current = activePresentation;
  }, [activePresentation]);

  return (
    <section
      className="console-workspace"
      aria-labelledby={titleId}
      data-selected-template={selectedTemplateId}
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
      {activePresentation === null ? (
        <PresentationTemplateSelector
          selectedId={selectedTemplateId}
          templates={templates}
          onSelect={setSelectedTemplateId}
        />
      ) : null}
      <ol className="console-workflow-steps" aria-label="Presentation setup progress">
        <li data-step-state={activePresentation === null ? "CURRENT" : "COMPLETE"}>
          <span>1</span>
          <strong>{text.stepSlides}</strong>
        </li>
        <li
          data-step-state={
            activePresentation === null
              ? "UPCOMING"
              : displayBindingEpoch === null
                ? "CURRENT"
                : "COMPLETE"
          }
        >
          <span>2</span>
          <strong>{text.stepDisplay}</strong>
        </li>
        <li data-step-state={displayBindingEpoch === null ? "UPCOMING" : "CURRENT"}>
          <span>3</span>
          <strong>{text.stepPresent}</strong>
        </li>
      </ol>
      {session === null ? null : activePresentation === null ? (
        <SessionUploadPanel client={client} csrfToken={session.csrfToken} />
      ) : (
        <div className="console-workspace__grid">
          <SlideWorkspace />
          <div className="console-workspace__side">
            <PlaybackPanel />
            <EvidencePreparationPanel />
            <StageSetupPanel />
            <DisplayPairingPanel />
          </div>
        </div>
      )}
    </section>
  );
}

function SlideWorkspace() {
  const { activePresentation, locale } = useAuth();
  if (activePresentation === null) return null;
  const text = messages(locale);
  const slides = [...activePresentation.slides].sort((left, right) => left.ordinal - right.ordinal);
  return (
    <section className="console-slides" aria-label="Presentation slides">
      <div className="console-slides__header">
        <div>
          <h2>
            {slides.length} {text.ready}
          </h2>
        </div>
        <Badge tone="success">{text.safeRender}</Badge>
      </div>
      <ol className="console-slide-list">
        {slides.map((slide) => (
          <li key={slide.publicSlideKey}>
            <span>{slide.ordinal}</span>
            <strong>{slide.accessibilityLabel}</strong>
          </li>
        ))}
      </ol>
      <Panel title={`${text.presenterConsole} — private`} tone="inset">
        <Badge tone="accent">{text.privateBadge}</Badge>
        <p>{text.privateConsoleLead}</p>
      </Panel>
    </section>
  );
}

function EvidencePreparationPanel() {
  const { activePresentation, client, locale, session } = useAuth();
  const text = messages(locale);
  const [status, setStatus] = useState<"PREPARING" | "READY" | "FAILED">("PREPARING");
  const [preparedCount, setPreparedCount] = useState(0);

  useEffect(() => {
    if (activePresentation === null || session === null) return;
    if (activePresentation.manifestHash === undefined) return;
    let active = true;
    setStatus("PREPARING");
    void Promise.all(
      activePresentation.slides.map((slide) =>
        client.recommend(session.csrfToken, {
          query: slide.accessibilityLabel,
          deckVersion: activePresentation.deckVersion,
          manifestHash: activePresentation.manifestHash as string,
          maxResults: 3,
        }),
      ),
    )
      .then((results) => {
        if (!active) return;
        setPreparedCount(results.length);
        setStatus("READY");
      })
      .catch(() => {
        if (active) setStatus("FAILED");
      });
    return () => {
      active = false;
    };
  }, [activePresentation, client, session]);

  return (
    <Panel className="console-evidence-preparation" title={text.preparingEvidence} tone="inset">
      <div data-evidence-status={status}>
        <Badge tone={status === "READY" ? "success" : status === "FAILED" ? "warning" : "accent"}>
          {status === "READY"
            ? text.evidenceReady
            : status === "FAILED"
              ? text.slidesStillReady
              : text.aiPreparing}
        </Badge>
        <ol className="console-preparation-steps">
          <li>{text.aiReading}</li>
          <li>{text.aiFinding}</li>
          <li>{text.aiChecking}</li>
        </ol>
        <p className="console-caption" aria-live="polite">
          {status === "READY"
            ? `${preparedCount} slide evidence sets prepared.`
            : status === "FAILED"
              ? text.evidencePaused
              : text.aiStartNow}
        </p>
      </div>
    </Panel>
  );
}

function StageSetupPanel() {
  const { activePresentation, locale } = useAuth();
  if (activePresentation === null) return null;
  const text = messages(locale);
  const stageUrl = `${STAGE_ORIGIN}/?deck=${encodeURIComponent(activePresentation.deckVersion)}`;
  const openStage = () => window.open(stageUrl, "impromptu-stage", "popup");
  return (
    <Panel className="console-stage-setup" title={text.stageTitle} tone="inset">
      <div className="console-stage-actions">
        <Button data-stage-open onClick={openStage}>
          {text.openStage}
        </Button>
        <Button
          variant="quiet"
          onClick={() => void navigator.clipboard?.writeText(stageUrl)}
        >
          {text.copyStage}
        </Button>
        <Button variant="quiet" onClick={openStage}>
          {text.externalDisplay}
        </Button>
      </div>
      <p className="console-caption">{text.stagePrivacy}</p>
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

function DisplayPairingPanel() {
  const {
    activePresentation,
    client,
    displayBindingEpoch,
    locale,
    session,
    setDisplayBindingEpoch,
  } = useAuth();
  const text = messages(locale);
  const [connectionCode, setConnectionCode] = useState("");
  const [message, setMessage] = useState("Paste the connection code shown on the audience screen.");

  const approve = async () => {
    const join = decodeDisplayJoin(connectionCode);
    if (
      join === null ||
      activePresentation === null ||
      session === null ||
      client.approveDisplay === undefined
    ) {
      setMessage(text.invalidCode);
      return;
    }
    if (join.deckVersion !== activePresentation.deckVersion) {
      setMessage(text.wrongPresentation);
      return;
    }
    try {
      const binding = await client.approveDisplay(session.csrfToken, activePresentation, join);
      setDisplayBindingEpoch(binding.displayBindingEpoch);
      setMessage(text.screenApproved);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : text.approvalFailed);
    }
  };

  return (
    <Panel title={text.connectDisplay} tone="inset">
      {displayBindingEpoch === null ? (
        <>
          <p>{text.connectLead}</p>
          <label className="console-field">
            <span>{text.connectionCode}</span>
            <input
              value={connectionCode}
              onChange={(event) => setConnectionCode(event.currentTarget.value)}
            />
          </label>
          <Button disabled={connectionCode.length === 0} onClick={() => void approve()}>
            {text.approveDisplay}
          </Button>
        </>
      ) : (
        <Badge tone="success">{text.audienceConnected}</Badge>
      )}
      <p className="console-caption" aria-live="polite">
        {message === "Paste the connection code shown on the audience screen."
          ? text.connectionHint
          : message}
      </p>
    </Panel>
  );
}

function PlaybackPanel() {
  const { activePresentation, client, displayBindingEpoch, locale, session } = useAuth();
  const text = messages(locale);
  const [index, setIndex] = useState(0);
  const [controlRevision, setControlRevision] = useState("cr_0");
  const [presentationStarted, setPresentationStarted] = useState(false);
  const [message, setMessage] = useState("");
  if (activePresentation === null || session === null) return null;
  const slides = [...activePresentation.slides].sort((left, right) => left.ordinal - right.ordinal);

  const show = async (nextIndex: number) => {
    const slide = slides[nextIndex];
    if (slide === undefined || displayBindingEpoch === null || client.setSlide === undefined) return;
    try {
      const receipt = await client.setSlide(session.csrfToken, {
        presentationSessionId: activePresentation.presentationSessionId,
        publicSlideKey: slide.publicSlideKey,
        displayBindingEpoch,
        baseRevision: controlRevision,
      });
      setIndex(nextIndex);
      setControlRevision(receipt.acceptedControlRevision);
      setMessage(`Showing slide ${nextIndex + 1} of ${slides.length}.`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : text.slideFailed);
    }
  };

  const startPresentation = async () => {
    if (displayBindingEpoch === null || slides.length === 0) return;
    await show(0);
    setPresentationStarted(true);
    setMessage(text.startedMessage);
  };

  return (
    <Panel className="console-present" title={text.presenterConsole} tone="inset">
      <div data-presentation-state={presentationStarted ? "PRESENTING" : "READY"}>
        <Button
          disabled={displayBindingEpoch === null || slides.length === 0}
          onClick={() => void startPresentation()}
        >
          {presentationStarted ? text.started : text.startPresentation}
        </Button>
      </div>
      <p>{slides[index]?.accessibilityLabel ?? text.slidesPlaceholder}</p>
      <div className="console-playback-actions">
        <Button
          variant="quiet"
          disabled={displayBindingEpoch === null || index === 0}
          onClick={() => void show(index - 1)}
        >
          {text.previousSlide}
        </Button>
        <Button
          disabled={displayBindingEpoch === null || index >= slides.length - 1}
          onClick={() => void show(index + 1)}
        >
          {text.nextSlide}
        </Button>
      </div>
      <p className="console-caption" aria-live="polite">
        {message || text.connectControls}
      </p>
    </Panel>
  );
}

export function ConsoleRoutes({
  coResident = false,
  templates = DEFAULT_PRESENTATION_TEMPLATES,
}: {
  readonly coResident?: boolean;
  readonly templates?: readonly PresentationTemplate[];
}) {
  return (
    <Routes>
      <Route element={<PublicOnly />}>
        <Route path="/sign-in" element={<SignInPage />} />
      </Route>
      <Route element={<RequireAuth />}>
          <Route element={<PrivateLayout coResident={coResident} />}>
          <Route index element={<PresentationWorkspacePage templates={templates} />} />
          <Route path="/session" element={<PresentationWorkspacePage templates={templates} />} />
          <Route path="/live-publication" element={<LivePublicationPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/sign-in" replace />} />
    </Routes>
  );
}
