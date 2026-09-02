import { Button, Panel } from "@impromptu/ui";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "./auth-session";
import type { Messages } from "./i18n";
import { messages } from "./i18n";
import { AnswerCard } from "./qa-answer-cards";
import type { QaDefenseAnswer, QaDefenseQuestionRequest } from "./session-client";
import { QaDefenseNotOpenError } from "./session-client";

type Phase = "IDLE" | "OPENING" | "READY" | "ASKING";

/**
 * Post-talk Q&A defense. Lives on the report surface because ending the talk navigates the
 * presenter straight there (`playback-panel`'s end action) — placing it anywhere before that
 * moment would either steal a click from the live talk or strand the entry behind navigation.
 */
export function QaDefensePanel({
  presentationSessionId,
}: Readonly<{
  presentationSessionId: string;
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
  useEffect(() => () => controllerRef.current?.abort(), []);

  const openSession = async () => {
    if (phase === "OPENING" || session === null || client.openQaDefense === undefined) return;
    setPhase("OPENING");
    try {
      await client.openQaDefense(session.csrfToken, presentationSessionId);
      setPhase("READY");
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
    // One click must be one request; an in-flight ask is not re-enterable.
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
      setAnswer(outcome);
    } catch (error) {
      if (!controller.signal.aborted) {
        setMessage(error instanceof QaDefenseNotOpenError ? text.qaNotOpen : text.qaFailed);
      }
    } finally {
      setPhase("READY");
    }
  };

  const changeDraft = (value: string) => {
    if (draft.length === 0 && value.trim().length > 0) enteredBySpeechRef.current = false;
    setDraft(value);
  };


  return (
    <Panel className="console-qa" title={text.qaTitle} tone="inset">
      <div className="console-qa__body" data-qa-phase={phase}>
        <p className="console-caption">{text.qaLead}</p>
        {phase === "READY" || phase === "ASKING" ? (
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
            </div>
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
          </>
        ) : (
          <Button disabled={phase === "OPENING"} onClick={() => void openSession()}>
            {phase === "OPENING" ? text.qaOpening : text.qaOpen}
          </Button>
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

type QaOrigin = QaDefenseQuestionRequest["origin"];
