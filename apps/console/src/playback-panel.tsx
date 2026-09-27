import { Button, Panel } from "@impromptu/ui";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { audienceRecovery } from "./audience-panel";
import type { AudienceScreenController } from "./audience-screen";
import { useAuth } from "./auth-session";
import { messages } from "./i18n";
import { type PlaybackStatusKind, PlaybackStatusLine } from "./playback-status-line";
import { PlaybackCommandRejectedError } from "./session-client";
import { orderedSlides } from "./slide-preview";

export function PlaybackPanel({
  audience,
  index,
  onIndexChange,
  // Minimal lift of the talk-started phase so the workspace rail can demote preparation
  // surfaces; this panel keeps every other behavior and prop unchanged.
  onStartedChange,
}: {
  readonly audience: AudienceScreenController;
  readonly index: number;
  readonly onIndexChange: (index: number) => void;
  readonly onStartedChange?: (started: boolean) => void;
}) {
  const {
    activePresentation,
    client,
    displayBindingEpoch,
    locale,
    session,
    setDisplayBindingEpoch,
  } = useAuth();
  const navigate = useNavigate();
  const text = messages(locale);
  // The accepted control revision is the CAS base for the next command, so it must be readable
  // synchronously. Held in React state it was read from a stale render: a presenter clicking
  // through slides issues the next command before the previous receipt has re-rendered, so the
  // command went out with a superseded baseRevision and came back REVISION_MISMATCH. A failed
  // command never advances the revision either, so once that happened every later slide change
  // failed the same way and the audience display stayed frozen for the rest of the talk.
  // A resumed presentation seeds the ref with the server's current revision (the panel remounts
  // per session identity via key), so re-entry commands chain onto persisted state, not cr_0.
  const controlRevisionRef = useRef(activePresentation?.controlRevision ?? "cr_0");
  const commandQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const [presentationStarted, setPresentationStarted] = useState(false);
  useEffect(() => {
    onStartedChange?.(presentationStarted);
  }, [onStartedChange, presentationStarted]);
  const [starting, setStarting] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [ending, setEnding] = useState(false);
  // Status-line model: every producer picks NEUTRAL for a routine receipt or PROBLEM when the
  // presenter must act. Presentation itself is PlaybackStatusLine's contract.
  const [status, setStatus] = useState<{
    readonly kind: PlaybackStatusKind;
    readonly text: string;
  }>({ kind: "NEUTRAL", text: "" });
  if (activePresentation === null || session === null) return null;
  const slides = orderedSlides(activePresentation);
  const recovery = audienceRecovery(audience.status, text);

  // The binding can be passed in because a screen bound during this very click has not
  // reached context state yet.
  // Commands are serialized so a second click cannot read the revision the first one is still
  // in the middle of superseding. Clicking faster than the network stays correct; it just queues.
  const show = (nextIndex: number, binding?: string): Promise<boolean> => {
    const run = async (): Promise<boolean> => {
      const slide = slides[nextIndex];
      const epoch = binding ?? displayBindingEpoch;
      if (slide === undefined || epoch === null || client.setSlide === undefined) return false;
      try {
        const receipt = await client.setSlide(session.csrfToken, {
          presentationSessionId: activePresentation.presentationSessionId,
          publicSlideKey: slide.publicSlideKey,
          displayBindingEpoch: epoch,
          baseRevision: controlRevisionRef.current,
        });
        controlRevisionRef.current = receipt.acceptedControlRevision;
        onIndexChange(nextIndex);
        setStatus({ kind: "NEUTRAL", text: text.slideChanged });
        return true;
      } catch (cause) {
        // STALE_DISPLAY_BINDING is the only receipt reason meaning the binding this Console still
        // holds is no longer the server's current displayBindingEpoch — an audience re-bind
        // rotated it, or the backend lost it across a restart (the exact log-proven 409 loop
        // that stranded a presenter). A stale REVISION must not land here: REVISION_MISMATCH has
        // its own retry semantics via controlRevisionRef above. Recovery clears the dead epoch so
        // the surface stops claiming a screen is connected and honest copy asks the presenter to
        // press again. It deliberately does NOT auto-reopen: browsers only honour window.open
        // inside a user gesture and openAndBind must be the first statement of a click, so an
        // auto-open here would silently fail. The next press takes the normal open-and-bind path.
        if (
          cause instanceof PlaybackCommandRejectedError &&
          cause.reason === "STALE_DISPLAY_BINDING"
        ) {
          setDisplayBindingEpoch(null);
          setStatus({ kind: "PROBLEM", text: text.bindingExpired });
          return false;
        }
        setStatus({ kind: "PROBLEM", text: text.slideFailed });
        return false;
      }
    };
    const next = commandQueueRef.current.then(run, run);
    commandQueueRef.current = next.catch(() => undefined);
    return next;
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
        setStatus({ kind: "NEUTRAL", text: text.startedMessage });
      }
    } finally {
      setStarting(false);
    }
  };

  // Reopen the audience screen without touching the talk itself: no start replay and no jump
  // back to slide one. openAndBind calls window.open as its first statement, so it has to be
  // reached inside this click exactly as in startPresentation above; afterwards the freshly
  // returned binding is used because it has not reached context state yet (see show).
  const reopenAudienceScreen = async () => {
    if (slides.length === 0 || reopening) return;
    setReopening(true);
    try {
      const outcome = await audience.openAndBind();
      if (outcome.kind !== "CONNECTED") return;
      await show(index, outcome.displayBindingEpoch);
    } finally {
      setReopening(false);
    }
  };

  // While the talk runs, the recovery retry for every status is the reopen path — re-running
  // start would push slide one over a binding that may still be healthy. Before the talk, the
  // original start flow remains correct for all four statuses.
  const recoverConnection = () =>
    presentationStarted ? reopenAudienceScreen() : startPresentation();

  const endPresentation = async () => {
    if (client.endPresentationAndAwaitReport === undefined) return;
    setEnding(true);
    setStatus({ kind: "NEUTRAL", text: text.reportFinalizing });
    const reportPath = `/reports/${encodeURIComponent(activePresentation.presentationSessionId)}`;
    const stayWithFailure = () => {
      setStatus({ kind: "PROBLEM", text: text.reportFinalizeFailed });
      setEnding(false);
    };
    try {
      const report = await client.endPresentationAndAwaitReport(
        session.csrfToken,
        activePresentation.presentationSessionId,
      );
      navigate(reportPath, { state: { report } });
      return;
    } catch {
      // The live REPORT_READY signal is the fast path, not the authority: it is bounded at ten
      // seconds, and when it lapsed this left the presenter standing in front of a room on the
      // playback screen with nothing but an error line, even though the presentation had already
      // ended server-side and the report was readable the whole time.
    }

    if (client.readFinalizedReport === undefined) {
      stayWithFailure();
      return;
    }
    try {
      // Reading the report is the discriminator, rather than inspecting the failure: it answers
      // the only question that matters here, which is whether the end actually took.
      const finalized = await client.readFinalizedReport(activePresentation.presentationSessionId);
      // PENDING means the end was accepted and finalization is still running, so the report route
      // is exactly where the presenter should wait — that page re-reads on its own.
      navigate(
        reportPath,
        finalized.status === "FINALIZED" ? { state: { report: finalized.report } } : {},
      );
    } catch {
      // The report cannot be read at all, so the end never took. Staying put is correct: the
      // presentation is still live and the presenter can end it again.
      stayWithFailure();
    }
  };

  return (
    <Panel className="console-present" title={text.presenterConsole} tone="inset">
      <div className="console-present__controls" data-transport-strip>
        <div
          className="console-primary-action"
          data-presentation-state={presentationStarted ? "PRESENTING" : "READY"}
        >
          <Button
            disabled={slides.length === 0 || starting || (presentationStarted && reopening)}
            onClick={() =>
              void (presentationStarted ? reopenAudienceScreen() : startPresentation())
            }
          >
            {presentationStarted
              ? text.audienceReopen
              : starting
                ? text.startingPresentation
                : text.startPresentation}
          </Button>
          <p className="console-caption">
            {/* A refused rebind must not keep claiming a connected screen: the held epoch is
                what the server just called stale. */}
            {displayBindingEpoch === null || audience.status === "BIND_FAILED"
              ? text.audienceOpensBeside
              : text.audienceConnected}
          </p>
          {recovery === null ? null : (
            <output className="console-status-line console-status-line--attention">
              <span>{recovery.message}</span>
              <Button variant="quiet" onClick={() => void recoverConnection()}>
                {recovery.retry}
              </Button>
              {audience.status === "POPUP_BLOCKED" ? (
                <Button
                  variant="quiet"
                  onClick={() =>
                    void audience.copyInvitationLink().then((url) => {
                      if (url === null) {
                        // The blocked-popup fallback is the invitation link itself: if it
                        // cannot be minted the panel's ISSUE_FAILED copy says what is wrong.
                        setStatus({ kind: "PROBLEM", text: text.stageInviteIssueFailed });
                        return;
                      }
                      void navigator.clipboard?.writeText(url);
                    })
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
            variant="quiet"
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
      <PlaybackStatusLine idle={text.connectControls} status={status} />
      {/* Post-talk Q&A does not live here: 발표 종료 navigates straight to the report, so the
          entry sits on that destination (see QaDefensePanel) where it stays reachable without
          hunting and never crowds the live controls. */}
    </Panel>
  );
}
