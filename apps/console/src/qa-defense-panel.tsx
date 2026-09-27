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
import type {
  QaDefenseAnswer,
  QaDefenseQuestionRequest,
  SpokenQuestionTranscription,
} from "./session-client";
import { QaDefenseExpiredError, QaDefenseNotOpenError } from "./session-client";
import { type QuestionClipSeams, SpokenQuestionControl } from "./spoken-question-control";

type Phase = "IDLE" | "OPENING" | "READY" | "EXPIRED";

/**
 * Honest fallback bound for a spoken question's ask window. A transcribed clip asks about
 * what the audience just heard; that question grows stale fast, so the console enforces its
 * own five-minute ceiling whenever the wire did not carry a typed `askableUntilMs`. A real
 * server deadline always wins — the fallback exists so a clip never sits askable forever,
 * and the expiry card states exactly which deadline it renders.
 */
export const QA_CLIP_ASKABLE_MS = 5 * 60_000;
/** Client-side ceiling on an in-flight ask: the UI resolves to honest copy instead of
    hanging on a dead request. Sized above the documented 5,000 ms recommendation bound. */
export const QA_ASK_TIMEOUT_MS = 30_000;
const EXPIRY_TICK_MS = 1_000;

/** Injected clock so expiry ticks and the ask deadline run on real timers in production and
    on manual timers in tests — no wall-clock sleeping on either side. */
export interface QaConsoleClock {
  readonly now: () => number;
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
}

const realClock: QaConsoleClock = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => {
    const id = setTimeout(callback, delayMs);
    return () => clearTimeout(id);
  },
};

/** Test-only timer/clock seams for the window recheck chain; production uses globals. These
    mirror the recheck clock's own seams so one manual clock can drive both the window watch
    and the per-clip expiry/ask deadline. */
export interface QaExpiryClockSeams {
  readonly now?: () => number;
  readonly schedule?: (delayMs: number, fire: () => void) => QaRecheckTimerHandle;
  readonly cancel?: (handle: QaRecheckTimerHandle) => void;
}

type QaOrigin = QaDefenseQuestionRequest["origin"];

/**
 * One spoken question pending review. `transcript` is the wire text verbatim and immutable:
 * the presenter may edit the composer field it seeded, but the card always shows what was
 * actually heard. `askableUntilMs` is the server deadline or the console fallback bound.
 */
interface PendingClip {
  readonly clipId: string;
  readonly transcript: string;
  readonly askableUntilMs: number;
  readonly recordedAtMs: number;
  state: "PENDING" | "ASKING" | "ENDED";
}

/** A settled exchange row: the question text persisted to the ledger, verbatim. */
interface SyncedExchange {
  readonly question: string;
  readonly origin: QaOrigin;
  readonly outcome: QaDefenseAnswer;
}

type ClipDisplayState = "LIVE" | "EXPIRED" | "ASKING" | "ENDED";

function clipDisplayState(clip: PendingClip, nowMs: number): ClipDisplayState {
  if (clip.state === "ENDED") return "ENDED";
  if (clip.state === "ASKING") return "ASKING";
  return nowMs >= clip.askableUntilMs ? "EXPIRED" : "LIVE";
}

/**
 * Post-talk Q&A console. Lives on the report surface because ending the talk navigates the
 * presenter straight there (`playback-panel`'s end action) — placing it anywhere before that
 * moment would either steal a click from the live talk or strand the entry behind navigation.
 *
 * Two clocks cooperate here. The QaRecheckClock is server-authoritative for the ask window:
 * a LIVE window arms one recheck at its typed deadline and an EXPIRED/ended verdict moves
 * the whole panel terminal and aborts any in-flight ask. On top of that, each spoken clip
 * carries an `askableUntilMs` (server value or the five-minute fallback) so a stale clip is
 * marked honestly even before the server window lapses.
 *
 * Item model: a typed composer draft is asked directly; a spoken clip becomes a pending item
 * with a verbatim transcript and an expiry card, and the composer binds to it until it is
 * asked, expired, or discarded. Settled asks render as synced rows showing the persisted
 * question text, not the current draft.
 */
export function QaDefensePanel({
  presentationSessionId,
  recorderSeams,
  clock,
  clockSeams,
}: Readonly<{
  presentationSessionId: string;
  /** Test-only capture seams, forwarded untouched to the push-to-talk control. */
  recorderSeams?: QuestionClipSeams;
  /** Test seam for the per-clip expiry tick and the ask deadline. */
  clock?: QaConsoleClock;
  /** Test seam for the server-window recheck chain; production uses globals. */
  clockSeams?: QaExpiryClockSeams;
}>) {
  const { client, locale, session } = useAuth();
  const text: Messages = messages(locale);
  const [phase, setPhase] = useState<Phase>("IDLE");
  const [draft, setDraft] = useState("");
  const [clips, setClips] = useState<readonly PendingClip[]>([]);
  const [exchanges, setExchanges] = useState<readonly SyncedExchange[]>([]);
  // The latest answered exchange renders its own card; the synced rows below keep the full
  // persisted list so a fresh answer never displaces the record of earlier ones.
  const [answer, setAnswer] = useState<QaDefenseAnswer | null>(null);
  const [message, setMessage] = useState("");
  const [asking, setAsking] = useState(false);
  // Re-render trigger only — the value is never read; the tick exists so an expiry boundary
  // crossing re-renders on the clock instead of on the next unrelated interaction.
  const [, setTick] = useState(0);
  const clipSeqRef = useRef(0);
  // Which clip currently owns the composer. Async continuations read the ref, not state, so a
  // clip superseded mid-flight cannot be resurrected by a stale closure.
  const liveClipIdRef = useRef<string | null>(null);
  // ORIGIN RULE — origin records how the question ENTERED, not how it was last touched:
  // speaking sets SPOKEN and later hand-edits of the transcript stay SPOKEN (editing a
  // transcript is not retyping it), including after the clip itself settled into a row.
  // Typing only resets to TYPED when the presenter starts a fresh question from empty.
  const enteredBySpeechRef = useRef(false);
  const askingRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  // The draft a submit sent is retained verbatim so the retry control resubmits exactly what
  // was persisted — never whatever the composer happens to hold when retry fires.
  const retainedQuestionRef = useRef<{ readonly text: string; readonly origin: QaOrigin }>({
    text: "",
    origin: "TYPED",
  });
  const rejectDeadlineRef = useRef<(() => void) | null>(null);
  const cancelDeadlineRef = useRef<(() => void) | null>(null);

  // The window clock is the server authority on the ask window. windowClosed flips
  // synchronously inside applyWindow so the ask path's finally can never stomp a terminal
  // phase back to READY; askableUntil keeps the latest typed deadline for the card.
  const windowClosedRef = useRef(false);
  const askableUntilRef = useRef<number | null>(null);
  const clockRef = useRef<QaRecheckClock | null>(null);

  // Two clocks stay separate: the recheck seams' `now`/`schedule` are reserved for the
  // server-window chain so its timer registry is exactly the recheck set, while the per-clip
  // expiry tick and the ask deadline use `clock` (or real timers) and never register there.
  const tickClock: QaConsoleClock = clock ?? realClock;
  const windowNow = clockSeams?.now ?? Date.now;
  const windowSchedule =
    clockSeams?.schedule ??
    ((delayMs: number, fire: () => void): QaRecheckTimerHandle => {
      const id = setTimeout(fire, delayMs);
      return { cancel: () => clearTimeout(id) };
    });
  const windowCancel = clockSeams?.cancel ?? ((handle: QaRecheckTimerHandle) => handle.cancel());
  // The pre-send gate reads the SAME clock the recheck chain runs on — the seam in tests,
  // the wall clock in production — so an injected deadline and the gate can never disagree.
  const nowRef = useRef(windowNow);

  // applyWindow is the single exit ramp into terminal states: EXPIRED (or an ENDED-shaped
  // observation) aborts any in-flight submission and ends the window; EMPTY means the session
  // is genuinely unopened again, which is IDLE with the not-open hint. LIVE only refreshes the
  // deadline and reopens a previously closed window — the recheck chain schedules the rest.
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
    // A terminal window frees the ask slot: the in-flight request is already aborted, so the
    // phase must settle to EXPIRED instead of lingering on ASKING forever.
    askingRef.current = false;
    setAsking(false);
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
  const windowScheduleRef = useRef(windowSchedule);
  const windowCancelRef = useRef(windowCancel);
  useEffect(() => {
    void clockSeamsRef.current; // seams are captured into nowRef/windowSchedule/windowCancel
    const recheckClock = new QaRecheckClock({
      now: nowRef.current,
      schedule: windowScheduleRef.current,
      cancel: windowCancelRef.current,
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
    clockRef.current = recheckClock;
    return () => {
      clockRef.current = null;
      recheckClock.dispose();
      controllerRef.current?.abort();
      cancelDeadlineRef.current?.();
    };
    // Clock seams are mount-fixed test doubles; only the session id can retarget the chain.
  }, [presentationSessionId]);

  // The single live clip binds the composer: expired/ended clips stay visible but inert.
  const liveClip =
    clips.find((clip) => clip.clipId === liveClipIdRef.current && clip.state !== "ENDED") ?? null;
  const liveClipState = liveClip === null ? null : clipDisplayState(liveClip, tickClock.now());

  // A live clip ticks until its deadline so an expiry crossing is rendered the moment it
  // happens; expired, ended, asking and absent clips schedule nothing (terminal — no churn).
  useEffect(() => {
    if (liveClip === null || clipDisplayState(liveClip, tickClock.now()) !== "LIVE") return;
    return tickClock.schedule(() => {
      setTick((tick) => tick + 1);
    }, EXPIRY_TICK_MS);
  });

  const updateClip = (
    clipId: string,
    state: PendingClip["state"],
    onlyIfState?: PendingClip["state"],
  ) => {
    setClips((current) =>
      current.map((clip) =>
        clip.clipId === clipId && (onlyIfState === undefined || clip.state === onlyIfState)
          ? { ...clip, state }
          : clip,
      ),
    );
  };

  const endClip = (clipId: string) => {
    updateClip(clipId, "ENDED");
    // A superseded clip is not the composer's business anymore; ending it must not clear the
    // draft that belongs to its replacement.
    if (liveClipIdRef.current !== clipId) return;
    liveClipIdRef.current = null;
    setDraft("");
    enteredBySpeechRef.current = false;
  };

  const openSession = async () => {
    if (phase === "OPENING" || session === null || client.openQaDefense === undefined) return;
    setPhase("OPENING");
    try {
      const lifecycle = await client.openQaDefense(session.csrfToken, presentationSessionId);
      applyWindow(lifecycle.qaWindow);
      clockRef.current?.observe(lifecycle.qaWindow);
      if (lifecycle.qaWindow.status === "LIVE") setPhase("READY");
      else if (lifecycle.qaWindow.status === "EXPIRED") setMessage(text.qaWindowExpired);
    } catch (error) {
      setPhase("IDLE");
      setMessage(error instanceof QaDefenseNotOpenError ? text.qaNotOpen : text.qaFailed);
    }
  };

  /**
   * Asks `questionText` — the trimmed composer draft for a typed question, the reviewed
   * field text for a clip. The wire text is retained verbatim on the synced row so what is
   * rendered later is what was persisted, not whatever the input holds by then. One request
   * at a time (`askingRef`): an in-flight ask is not re-enterable and its UI is bounded by
   * QA_ASK_TIMEOUT_MS through the injected clock. A closed window or a locally lapsed
   * deadline skips the doomed POST entirely.
   */
  const ask = async (questionText: string, origin: QaOrigin, clipId: string | null) => {
    if (
      askingRef.current ||
      session === null ||
      client.submitQaDefenseQuestion === undefined ||
      questionText.trim().length === 0
    ) {
      return;
    }
    const clip =
      clipId === null || liveClipIdRef.current !== clipId
        ? null
        : (clips.find((entry) => entry.clipId === clipId) ?? null);
    if (clipId !== null && clip === null) return;
    if (clip !== null && clipDisplayState(clip, tickClock.now()) !== "LIVE") return;
    // A closed window is already terminal; a locally lapsed deadline ends it without a wire call.
    if (windowClosedRef.current) return;
    if (askableUntilRef.current !== null && nowRef.current() >= askableUntilRef.current) {
      applyWindow({ status: "EXPIRED", askableUntilMs: askableUntilRef.current });
      clockRef.current?.observe({ status: "EXPIRED", askableUntilMs: askableUntilRef.current });
      return;
    }

    askingRef.current = true;
    setAsking(true);
    setMessage("");
    const askedText = questionText.trim();
    retainedQuestionRef.current = { text: askedText, origin };
    setAnswer(null);
    const controller = new AbortController();
    controllerRef.current = controller;
    // Subscribe the deadline BEFORE the request is in flight: the bounded rejection resolves
    // the UI even when the underlying promise never settles.
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadlineRef.current = () =>
        reject(new DOMException("The ask timed out.", "TimeoutError"));
    });
    cancelDeadlineRef.current = tickClock.schedule(() => {
      controller.abort();
      rejectDeadlineRef.current?.();
    }, QA_ASK_TIMEOUT_MS);
    if (clip !== null) updateClip(clip.clipId, "ASKING");

    try {
      const outcome = await Promise.race([
        client.submitQaDefenseQuestion(
          session.csrfToken,
          { presentationSessionId, questionText: askedText, origin },
          controller.signal,
        ),
        deadline,
      ]);
      if (windowClosedRef.current) return; // The window lapsed mid-ask; the card stays hidden.
      // The exchange is durable the moment the wire answered — the synced row renders the
      // sent text verbatim, matching persisted state instead of the live draft.
      setExchanges((current) => [...current, { question: askedText, origin, outcome }]);
      setAnswer(outcome);
      // Every accepted submission carries its window's typed expiry: feed it back into the
      // chain so a later deadline never widens the watched window and an earlier one tightens
      // it (coalesced — only one pending recheck either way).
      clockRef.current?.observe({ status: "LIVE", askableUntilMs: outcome.askableUntilMs });
      if (clip !== null) {
        setClips((current) => current.filter((entry) => entry.clipId !== clip.clipId));
        if (liveClipIdRef.current === clip.clipId) liveClipIdRef.current = null;
      }
    } catch (error) {
      if (error instanceof QaDefenseExpiredError) {
        // The server rejected the ask because the window already ended: the whole panel goes
        // terminal without waiting for the next recheck tick.
        applyWindow({ status: "EXPIRED", askableUntilMs: askableUntilRef.current });
        clockRef.current?.observe({ status: "EXPIRED", askableUntilMs: askableUntilRef.current });
        setMessage(text.qaWindowExpired);
      } else if (controller.signal.aborted) {
        // Reached only via the clock deadline: unmount aborts never render copy. The clip goes
        // back to PENDING only while it is still the live one and still marked ASKING.
        if (!windowClosedRef.current) setMessage(text.qaAskTimeout);
        if (clip !== null) {
          if (liveClipIdRef.current === clip.clipId) {
            updateClip(clip.clipId, "PENDING", "ASKING");
          } else {
            endClip(clip.clipId);
          }
        }
      } else if (error instanceof QaDefenseNotOpenError) {
        // The session is closed: the clip cannot be asked anymore and ends honestly even if
        // a newer clip already superseded it in the composer.
        setMessage(text.qaNotOpen);
        if (clip !== null) endClip(clip.clipId);
      } else {
        setMessage(text.qaFailed);
        if (clip !== null) {
          // A still-live clip may be retried; one that was superseded mid-flight just ends.
          if (liveClipIdRef.current === clip.clipId) {
            updateClip(clip.clipId, "PENDING", "ASKING");
          } else {
            endClip(clip.clipId);
          }
        }
      }
    } finally {
      cancelDeadlineRef.current?.();
      cancelDeadlineRef.current = null;
      rejectDeadlineRef.current = null;
      askingRef.current = false;
      setAsking(false);
      // Terminal windows never return to READY — a closed window is an exit, not a detour.
      if (!windowClosedRef.current && phase !== "READY") setPhase("READY");
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

  const onTranscript = (
    outcome: Extract<SpokenQuestionTranscription, { outcome: "TRANSCRIBED" }>,
  ) => {
    // REPLACE, never append: a new clip supersedes a still-PENDING predecessor (ended honestly,
    // not silently dropped) while an ASKING predecessor keeps its state until the wire answers.
    // The transcript lands verbatim in the editable field for review BEFORE anything is sent —
    // nothing auto-submits.
    const nowMs = tickClock.now();
    const clipId = `clip-${++clipSeqRef.current}`;
    liveClipIdRef.current = clipId;
    setClips((current) => [
      ...current.map((clip) =>
        clip.state === "PENDING" ? { ...clip, state: "ENDED" as const } : clip,
      ),
      {
        clipId,
        transcript: outcome.text,
        recordedAtMs: nowMs,
        askableUntilMs: outcome.askableUntilMs ?? nowMs + QA_CLIP_ASKABLE_MS,
        state: "PENDING",
      },
    ]);
    enteredBySpeechRef.current = true;
    setDraft(outcome.text);
  };

  const windowOpen = phase === "READY" || phase === "ASKING";

  return (
    <Panel className="console-qa" title={text.qaTitle} tone="inset">
      <div className="console-qa__body" data-qa-phase={asking ? "ASKING" : phase}>
        <p className="console-caption">{text.qaLead}</p>
        {phase === "EXPIRED" ? (
          <output aria-live="polite" className="console-status-line console-status-line--attention">
            {text.qaWindowExpired}
          </output>
        ) : phase !== "READY" ? (
          <Button disabled={phase === "OPENING"} onClick={() => void openSession()}>
            {phase === "OPENING" ? text.qaOpening : text.qaOpen}
          </Button>
        ) : (
          <>
            {clips.map((clip) => {
              const state = clipDisplayState(clip, tickClock.now());
              const remainingSeconds = Math.max(
                0,
                Math.ceil((clip.askableUntilMs - tickClock.now()) / 1_000),
              );
              return (
                <article
                  className="console-qa__card console-qa__clip"
                  data-qa-clip-state={state}
                  key={clip.clipId}
                >
                  <p className="console-qa__meta" data-qa-clip-transcript>
                    {clip.transcript}
                  </p>
                  <p
                    className="console-qa__meta"
                    data-qa-clip-deadline={clip.askableUntilMs}
                    data-qa-clip-expiry
                  >
                    {state === "ENDED"
                      ? text.qaClipEnded
                      : state === "EXPIRED"
                        ? text.qaClipExpired
                        : state === "ASKING"
                          ? text.qaAsking
                          : text.qaClipExpiresIn.replace("{seconds}", String(remainingSeconds))}
                  </p>
                  {state === "LIVE" || state === "EXPIRED" ? (
                    <Button
                      data-qa-discard-clip
                      onClick={() => endClip(clip.clipId)}
                      variant="quiet"
                    >
                      {text.qaClipDiscard}
                    </Button>
                  ) : null}
                </article>
              );
            })}
            <label className="console-qa__question">
              <span>{text.qaQuestionLabel}</span>
              <input
                data-qa-question-input
                value={draft}
                onChange={(event) => changeDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void ask(
                      draft,
                      enteredBySpeechRef.current ? "SPOKEN" : "TYPED",
                      liveClip?.clipId ?? null,
                    );
                  }
                }}
              />
            </label>
            <div className="console-qa__actions">
              {/* One ask control for the bound item — the pending clip's question when a clip
                  is live, the typed draft otherwise. It is offered only while that item is
                  eligible: expired, empty, ended or in-flight items expose no ask action. */}
              <Button
                data-qa-submit
                disabled={
                  asking ||
                  draft.trim().length === 0 ||
                  (liveClip !== null && liveClipState !== "LIVE")
                }
                onClick={() =>
                  void ask(
                    draft,
                    enteredBySpeechRef.current ? "SPOKEN" : "TYPED",
                    liveClip?.clipId ?? null,
                  )
                }
              >
                {asking ? text.qaAsking : text.qaSubmit}
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
            {exchanges.length === 0 ? null : (
              <section className="console-qa__rows" data-qa-synced-rows>
                <h2 className="console-qa__meta">{text.qaSyncedHeading}</h2>
                {exchanges.map((exchange, index) => (
                  <div
                    data-qa-origin={exchange.origin}
                    data-qa-synced-row
                    key={`${index}-${exchange.question}`}
                  >
                    <AnswerCard
                      answer={exchange.outcome}
                      question={exchange.question}
                      text={text}
                      onRetry={() => void ask(exchange.question, exchange.origin, null)}
                    />
                  </div>
                ))}
              </section>
            )}
          </>
        )}
        {answer === null ? null : (
          <AnswerCard
            answer={answer}
            question={retainedQuestionRef.current.text}
            text={text}
            onRetry={() =>
              void ask(
                retainedQuestionRef.current.text,
                retainedQuestionRef.current.origin,
                liveClip?.clipId ?? null,
              )
            }
          />
        )}
        {message.length === 0 ? null : (
          <output aria-live="polite" className="console-status-line console-status-line--attention">
            {message}
          </output>
        )}
      </div>
    </Panel>
  );
}
