import { Button, Panel } from "@impromptu/ui";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "./auth-session";
import type { Messages } from "./i18n";
import { messages } from "./i18n";
import { AnswerCard } from "./qa-answer-cards";
import {
  QaRecheckClock,
  type QaRecheckTimerHandle,
  type QaWindowObservation,
} from "./qa-recheck-clock";
import type { QaDefenseAnswer, QaDefenseQuestionRequest } from "./session-client";
import { QaDefenseExpiredError, QaDefenseNotOpenError } from "./session-client";
import { type QuestionClipSeams, SpokenQuestionControl } from "./spoken-question-control";

type Phase = "IDLE" | "OPENING" | "READY" | "ASKING" | "EXPIRED";

/** Test-only timer/clock seams for the expiry recheck chain; production uses globals. */
export interface QaExpiryClockSeams {
  readonly now?: () => number;
  readonly schedule?: (delayMs: number, fire: () => void) => QaRecheckTimerHandle;
  readonly cancel?: (handle: QaRecheckTimerHandle) => void;
}

/**
 * Post-talk Q&A defense. Lives on the report surface because ending the talk navigates the
 * presenter straight there (`playback-panel`'s end action) — placing it anywhere before that
 * moment would either steal a click from the live talk or strand the entry behind navigation.
 */
export function QaDefensePanel({
  presentationSessionId,
  recorderSeams,
  clockSeams,
}: Readonly<{
  presentationSessionId: string;
  /** Test-only capture seams, forwarded untouched to the push-to-talk control. */
  recorderSeams?: QuestionClipSeams;
  /** Test-only timer seams for the ask-window recheck chain; production uses globals. */
  clockSeams?: QaExpiryClockSeams;
}>) {
  const { client, locale, session } = useAuth();
  const text: Messages = messages(locale);
  const [phase, setPhase] = useState<Phase>("IDLE");
  const [draft, setDraft] = useState("");
  const [answer, setAnswer] = useState<QaDefenseAnswer | null>(null);
  const [message, setMessage] = useState("");
  // The draft a submit sent is retained verbatim so 다시 시도 resubmits exactly what the
  // audience heard, not whatever the input happens to hold by then.
  const retainedQuestionRef = useRef<{ readonly text: string; readonly origin: QaOrigin }>({
    text: "",
    origin: "TYPED",
  });
  // ORIGIN RULE — origin records how the question ENTERED, not how it was last touched:
  // speaking sets SPOKEN and later hand-edits of the transcript stay SPOKEN (editing a
  // transcript is not retyping it). Typing only resets to TYPED when the presenter starts
  // a fresh question from an empty field.
  const enteredBySpeechRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  // The latest typed window deadline, kept in a ref so a settlement mid-tick reads what the
  // recheck already knows. windowClosedRef flips SYNCHRONOUSLY inside applyWindow so the
  // ask path's finally can never stomp a terminal phase back to READY.
  const askableUntilRef = useRef<number | null>(null);
  const windowClosedRef = useRef(false);
  const clockRef = useRef<QaRecheckClock | null>(null);
  // The pre-send gate reads the SAME clock the recheck chain runs on — the seam in tests,
  // the wall clock in production — so an injected deadline and the gate can never disagree.
  const nowRef = useRef(clockSeams?.now ?? Date.now);

  // applyWindow is the single exit ramp into terminal states: EXPIRED (or a caller-shaped
  // ENDED) aborts any in-flight submission and ends the window; EMPTY means the session is
  // genuinely unopened again, which is IDLE with the not-open hint. LIVE only refreshes the
  // deadline and reopens a previously closed window — the clock chains the rest.
  const applyWindow = (observation: QaWindowObservation): void => {
    if (observation.status === "LIVE") {
      askableUntilRef.current = observation.askableUntilMs;
      windowClosedRef.current = false;
      return;
    }
    controllerRef.current?.abort();
    controllerRef.current = null;
    windowClosedRef.current = true;
    if (observation.askableUntilMs !== null) askableUntilRef.current = observation.askableUntilMs;
    if (observation.status === "EMPTY") {
      setPhase("IDLE");
      setMessage(textRef.current.qaNotOpen);
      return;
    }
    setPhase("EXPIRED");
    setMessage("");
  };
  const applyWindowRef = useRef(applyWindow);
  applyWindowRef.current = applyWindow;
  const textRef = useRef(text);
  textRef.current = text;

  // The recheck chain is created once per mounted panel; its callbacks read the latest
  // session/client via refs so a stale closure can never ask the wrong session. The clock
  // seams are mount-fixed test doubles, deliberately not effect dependencies.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const readWindowRef = useRef(client.readQaDefenseWindow);
  readWindowRef.current = client.readQaDefenseWindow;
  const clockSeamsRef = useRef(clockSeams);
  useEffect(() => {
    const seams = clockSeamsRef.current ?? {};
    const clock = new QaRecheckClock({
      now: nowRef.current,
      schedule:
        seams.schedule ??
        ((delayMs, fire) => {
          const id = setTimeout(fire, delayMs);
          return { cancel: () => clearTimeout(id) };
        }),
      cancel: seams.cancel ?? ((handle) => handle.cancel()),
      // Default recheck: ask the server. A client without the read seam cannot verify — it
      // answers EXPIRED rather than silently trusting the last LIVE read.
      recheck: async () => {
        const current = sessionRef.current;
        const readWindow = readWindowRef.current;
        if (current === null || readWindow === undefined) {
          return { status: "EXPIRED", askableUntilMs: askableUntilRef.current };
        }
        return await readWindow(current.csrfToken, presentationSessionId);
      },
      onObservation: (observation) => applyWindowRef.current(observation),
      onFailure: () => {
        // The window can no longer be watched: abort the pending submission and leave the
        // presenter free to ask again — the server remains the authority on liveness.
        controllerRef.current?.abort();
        controllerRef.current = null;
        setMessage(textRef.current.qaWindowRecheckFailed);
      },
    });
    clockRef.current = clock;
    return () => {
      clockRef.current = null;
      clock.dispose();
      controllerRef.current?.abort();
    };
    // Clock seams are mount-fixed test doubles; only the session id can retarget the chain.
  }, [presentationSessionId]);

  const openSession = async () => {
    if (phase === "OPENING" || session === null || client.openQaDefense === undefined) return;
    setPhase("OPENING");
    try {
      const lifecycle = await client.openQaDefense(session.csrfToken, presentationSessionId);
      applyWindow(lifecycle.qaWindow);
      clockRef.current?.observe(lifecycle.qaWindow);
      if (lifecycle.qaWindow.status === "LIVE") setPhase("READY");
    } catch (error) {
      setPhase("IDLE");
      setMessage(error instanceof QaDefenseNotOpenError ? text.qaNotOpen : text.qaFailed);
    }
  };

  const ask = async (questionText: string, origin: QaOrigin) => {
    if (
      phase === "ASKING" ||
      session === null ||
      client.submitQaDefenseQuestion === undefined ||
      questionText.trim().length === 0
    ) {
      return;
    }
    // One click must be one request; an in-flight ask is not re-enterable. A closed window
    // is already terminal; a locally lapsed deadline skips the doomed POST entirely.
    if (windowClosedRef.current) return;
    if (askableUntilRef.current !== null && nowRef.current() >= askableUntilRef.current) {
      applyWindow({ status: "EXPIRED", askableUntilMs: askableUntilRef.current });
      clockRef.current?.observe({ status: "EXPIRED", askableUntilMs: askableUntilRef.current });
      return;
    }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    retainedQuestionRef.current = { text: questionText.trim(), origin };
    setAnswer(null);
    setPhase("ASKING");
    try {
      const outcome = await client.submitQaDefenseQuestion(
        session.csrfToken,
        {
          presentationSessionId,
          questionText: retainedQuestionRef.current.text,
          origin,
        },
        controller.signal,
      );
      if (windowClosedRef.current) return; // The window lapsed mid-ask; the card stays hidden.
      setAnswer(outcome);
      // Every accepted submission carries the typed expiry of its window: feed it back into
      // the chain so a later deadline than the open's never widens the watched window and an
      // earlier one tightens it (coalesced — only one pending recheck either way).
      clockRef.current?.observe({ status: "LIVE", askableUntilMs: outcome.askableUntilMs });
    } catch (error) {
      if (controller.signal.aborted) return; // The expiry path already moved the phase.
      if (error instanceof QaDefenseExpiredError) {
        applyWindow({ status: "EXPIRED", askableUntilMs: askableUntilRef.current });
        clockRef.current?.observe({ status: "EXPIRED", askableUntilMs: askableUntilRef.current });
        return;
      }
      setMessage(error instanceof QaDefenseNotOpenError ? text.qaNotOpen : text.qaFailed);
    } finally {
      // Terminal windows never return to READY — a closed window is an exit, not a detour.
      if (!windowClosedRef.current) setPhase("READY");
    }
  };

  const changeDraft = (value: string) => {
    if (draft.length === 0 && value.trim().length > 0) enteredBySpeechRef.current = false;
    setDraft(value);
  };

  const transcribeMethod = client.transcribeQuestionClip;
  const transcribeClip =
    session === null || transcribeMethod === undefined
      ? undefined
      : (audio: Blob, durationMs: number) => transcribeMethod(session.csrfToken, audio, durationMs);

  const onTranscript = (transcript: string) => {
    // REPLACE, never append: a half-typed fragment stitched to a fresh transcript produces a
    // question nobody asked deliberately, while a visible replace keeps exactly one editable
    // transcript the presenter can review before submitting. Typed text is not silently
    // destroyed — the transcript lands in the field for review BEFORE anything is sent.
    enteredBySpeechRef.current = true;
    setDraft(transcript);
  };

  return (
    <Panel className="console-qa" title={text.qaTitle} tone="inset">
      <div className="console-qa__body" data-qa-phase={phase}>
        <p className="console-caption">{text.qaLead}</p>
        {phase === "EXPIRED" ? null : phase === "READY" || phase === "ASKING" ? (
          <>
            <label className="console-qa__question">
              <span>{text.qaQuestionLabel}</span>
              <input
                data-qa-question-input
                value={draft}
                onChange={(event) => changeDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void ask(draft, enteredBySpeechRef.current ? "SPOKEN" : "TYPED");
                  }
                }}
              />
            </label>
            <div className="console-qa__actions">
              <Button
                data-qa-submit
                disabled={phase === "ASKING" || draft.trim().length === 0}
                onClick={() => void ask(draft, enteredBySpeechRef.current ? "SPOKEN" : "TYPED")}
              >
                {phase === "ASKING" ? text.qaAsking : text.qaSubmit}
              </Button>
              {transcribeClip === undefined ? null : (
                <SpokenQuestionControl
                  disabled={false}
                  onTranscript={onTranscript}
                  text={text}
                  transcribe={transcribeClip}
                  {...(recorderSeams === undefined ? {} : { seams: recorderSeams })}
                />
              )}
            </div>
          </>
        ) : (
          <Button disabled={phase === "OPENING"} onClick={() => void openSession()}>
            {phase === "OPENING" ? text.qaOpening : text.qaOpen}
          </Button>
        )}
        {answer === null ? null : (
          <AnswerCard
            answer={answer}
            question={retainedQuestionRef.current.text}
            text={text}
            onRetry={() =>
              void ask(retainedQuestionRef.current.text, retainedQuestionRef.current.origin)
            }
          />
        )}
        {phase === "EXPIRED" ? (
          <output
            aria-live="polite"
            className="console-status-line console-status-line--attention"
            data-qa-window-expired
          >
            {text.qaWindowExpired}
          </output>
        ) : null}
        {message.length === 0 ? null : (
          <output aria-live="polite" className="console-status-line console-status-line--attention">
            {message}
          </output>
        )}
      </div>
    </Panel>
  );
}

type QaOrigin = QaDefenseQuestionRequest["origin"];
