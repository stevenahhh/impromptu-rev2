import { Button } from "@impromptu/ui";
import type { Messages } from "./i18n";
import type { QaDefenseAnswer, QaDefenseCitation } from "./session-client";

// Render-only cards for one settled Q&A outcome. Extracted from the panel so the ask flow
// and the presentation of answers stay independently readable; attributes (data-qa-answer,
// data-qa-abstained, data-qa-source) are part of the surface contract — keep them stable.

export function AnswerCard({
  answer,
  question,
  text,
  onRetry,
}: {
  readonly answer: QaDefenseAnswer;
  /** The exact asked text, retained by the panel so retries keep the same question. */
  readonly question: string;
  readonly text: Messages;
  readonly onRetry: () => void;
}) {
  if (answer.outcome === "ABSTAINED") {
    return (
      <article
        className="console-qa__card"
        data-qa-abstained={answer.retryable ? "RETRYABLE" : "TERMINAL"}
      >
        <h2 data-qa-question>{question}</h2>
        {/* Retryable means transient — copy never blames the uploaded materials. Terminal means
            the materials genuinely cannot support this question, and no retry is offered. */}
        <p>{answer.retryable ? text.qaAbstainedRetryable : text.qaAbstainedTerminal}</p>
        {answer.retryable ? (
          <Button data-qa-retry variant="quiet" onClick={onRetry}>
            {text.qaRetry}
          </Button>
        ) : null}
      </article>
    );
  }
  return (
    <article className="console-qa__card" data-qa-answer="ANSWERED">
      {/* The question leads so a stack of cards is self-identifying; sources then back it, since
          the feature's point is what grounds the answer. */}
      <h2 data-qa-question>{question}</h2>
      <ul className="console-qa__sources" aria-label={text.qaSourceHeading}>
        {answer.citations.map((source) => (
          <CitationRow key={source.evidenceId} source={source} text={text} />
        ))}
      </ul>
      <p className="console-qa__answer-text" data-qa-answer-text>
        {answer.answer}
      </p>
    </article>
  );
}

function CitationRow({
  source,
  text,
}: {
  readonly source: QaDefenseCitation;
  readonly text: Messages;
}) {
  return (
    <li className="console-qa__source" data-qa-source={source.kind}>
      {source.kind === "DECK_SLIDE" ? (
        <>
          <h3>{text.qaSourceSlide.replace("{ordinal}", String(source.slideOrdinal))}</h3>
          <p className="console-qa__meta">{source.title}</p>
        </>
      ) : null}
      {source.kind === "REFERENCE_DOCUMENT" ? (
        <>
          <h3>{source.documentTitle}</h3>
          <p className="console-qa__meta">
            {text.qaSourceReference.replace("{ordinal}", String(source.chunkOrdinal))}
          </p>
        </>
      ) : null}
      {source.kind === "EXTERNAL_SOURCE" ? (
        <>
          <h3>
            <a href={source.url} rel="noreferrer" target="_blank">
              {source.title}
            </a>
          </h3>
          <p className="console-qa__meta">{source.url}</p>
        </>
      ) : null}
      <blockquote className="console-qa__quote">
        <p>{source.quote}</p>
      </blockquote>
    </li>
  );
}
