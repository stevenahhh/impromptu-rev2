import { createCoachingState, reduceCoachingState } from "@impromptu/state/coaching";
import { Button } from "@impromptu/ui";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AudienceScreenPanel } from "./audience-panel";
import { useAudienceScreen } from "./audience-screen";
import { useAuth } from "./auth-session";
import { CoachingDisplay } from "./coaching-display";
import { CockpitAudioCapture } from "./cockpit-audio-capture";
import { getDebugLogger } from "./debug-log";
import { DebugOverlay } from "./debug-overlay";
import { SessionUploadPanel } from "./deck-upload-panel";
import { EvidencePreparationPanel } from "./evidence-preparation-panel";
import { messages } from "./i18n";
import { PlaybackPanel } from "./playback-panel";
import { ReferenceDocumentPanel } from "./reference-documents-panel";
import { coachingEventFromServer, record } from "./server-payload";
import type { ActivePresentationView } from "./session-client";
import { SlidePreview } from "./slide-preview";
import { STAGE_ORIGIN, stageUrl } from "./stage-origin";

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

export function PresentationWorkspacePage() {
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
  // Newly indexed reference material changes what evidence can be grounded in, so preparation
  // has to run again instead of leaving the presenter with the pre-upload result.
  const [referenceRevision, setReferenceRevision] = useState(0);
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
  // PlaybackPanel owns the start/reopen/end transitions and pushes the one bit this page needs
  // back up through onStartedChange: before the talk the rail leads with preparation surfaces,
  // on stage it becomes evidence and readouts.
  const [presentationStarted, setPresentationStarted] = useState(false);
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
    // A new talk resets the rail to preparation weight; the cockpit unmounts between talks so
    // PlaybackPanel's own started-state restarts from false and reports that here.
    setPresentationStarted(false);
  }, [coachingIdentity]);

  const onCoachingOptInChange = useCallback((enabled: boolean) => {
    setCoachingState((state) => reduceCoachingState(state, { kind: "OPT_IN", enabled }).state);
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

  const onCoachingMuteChange = useCallback((muted: boolean) => {
    setCoachingState((state) => reduceCoachingState(state, { kind: "MUTE", muted }).state);
  }, []);

  // Takes the narrowed values explicitly: this reads session context that only exists once
  // the cockpit branch is reached, so it must never be evaluated outside it.
  const audioCaptureFor = (
    presentation: ActivePresentationView,
    csrfToken: string,
    actorId: string,
  ) => (
    <CockpitAudioCapture
      key={`${presentation.presentationSessionId}:${presentation.presentationSessionEpoch}`}
      csrfToken={csrfToken}
      presentationSessionId={presentation.presentationSessionId}
      presentationSessionEpoch={presentation.presentationSessionEpoch}
      actorId={actorId}
      notice={CAPTURE_NOTICE}
      onServerEvent={onAudioServerEvent}
      text={{
        capturing: text.captureListening,
        denied: text.captureDenied,
        unavailable: text.captureUnavailable,
      }}
    />
  );

  // With coaching off this must not cost a full panel of empty space; the opt-in check stays
  // reachable in both phases. Opting in swaps it for the full readout.
  const coachingArea = coachingState.optedIn ? (
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
  ) : (
    <label className="console-consent-check console-coaching-optout">
      <input
        type="checkbox"
        checked={coachingState.optedIn}
        onChange={(event) => onCoachingOptInChange(event.currentTarget.checked)}
      />
      {text.coachingOptIn}
    </label>
  );

  return (
    <>
      {activePresentation === null ? null : <DebugOverlay logger={getDebugLogger()} />}
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
          {activePresentation === null || presentationStarted ? null : (
            <Button data-new-deck variant="quiet" onClick={() => setActivePresentation(null)}>
              {text.newDeck}
            </Button>
          )}
        </header>
        {session === null ? null : activePresentation === null ? (
          <SessionUploadPanel client={client} csrfToken={session.csrfToken} />
        ) : (
          <div
            className="console-cockpit"
            data-cockpit-phase={presentationStarted ? "PRESENTING" : "PREPARING"}
          >
            <div className="console-cockpit__center">
              <SlidePreview index={activeIndex} />
              <PlaybackPanel
                audience={audience}
                index={activeIndex}
                onIndexChange={setActiveIndex}
                onStartedChange={setPresentationStarted}
              />
            </div>
            <div
              className="console-cockpit__side"
              data-cockpit-phase={presentationStarted ? "PRESENTING" : "PREPARING"}
            >
              {presentationStarted ? (
                <>
                  {/* On stage the rail leads with what a presenter needs mid-talk: prepared
                    evidence and the audio/coaching readout. Recovery surfaces fold behind a
                    disclosure - still reachable, never deleted, just out of the live flow. */}
                  <EvidencePreparationPanel
                    key={`${activePresentation.presentationSessionId}:${activePresentation.deckVersion}:${activePresentation.manifestHash ?? ""}:${referenceRevision}`}
                  />
                  {audioCaptureFor(activePresentation, session.csrfToken, session.account.actorId)}
                  {coachingArea}
                  <details
                    className="console-preparation-drawer"
                    data-preparation-surfaces="COLLAPSED"
                  >
                    <summary>{text.preparationWhileSpeaking}</summary>
                    <ReferenceDocumentPanel
                      onIndexed={() => setReferenceRevision((current) => current + 1)}
                    />
                    <AudienceScreenPanel audience={audience} presenting={presentationStarted} />
                  </details>
                </>
              ) : (
                // Before the talk this is the work of the phase, so both surfaces lead the rail
                // at full weight.
                <>
                  <ReferenceDocumentPanel
                    onIndexed={() => setReferenceRevision((current) => current + 1)}
                  />
                  <AudienceScreenPanel audience={audience} presenting={presentationStarted} />
                  <EvidencePreparationPanel
                    key={`${activePresentation.presentationSessionId}:${activePresentation.deckVersion}:${activePresentation.manifestHash ?? ""}:${referenceRevision}`}
                  />
                  {audioCaptureFor(activePresentation, session.csrfToken, session.account.actorId)}
                  {coachingArea}
                </>
              )}
            </div>
          </div>
        )}
      </section>
    </>
  );
}
