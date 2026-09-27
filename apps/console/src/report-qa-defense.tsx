import { Badge, Panel } from "@impromptu/ui";
import type { QaDefenseCitationReportView, QaDefenseSectionReportView } from "./qa-defense-report";

/**
 * The report page's Q&A section text. Slides/references reuse the live Q&A citation phrasing
 * ({text.qaSourceSlide}, {text.qaSourceReference}) so one wording serves both surfaces.
 */
export type ReportQaDefenseText = Readonly<{
  title: string;
  empty: string;
  unavailable: string;
  typed: string;
  spoken: string;
  askedAt: string;
  answerHeading: string;
  retryable: string;
  final: string;
}>;

export interface ReportQaDefenseProps {
  readonly section: QaDefenseSectionReportView;
  readonly text: Readonly<{
    qaSourceSlide: string;
    qaSourceReference: string;
  }> &
    ReportQaDefenseText;
}

export function ReportQaDefense({ section, text }: ReportQaDefenseProps) {
  if (section.status === "UNREADABLE") {
    // Degrade the section only: the report stays on screen with an honest notice.
    return (
      <Panel data-report-qa-defense="UNREADABLE" title={text.title} tone="inset">
        <p className="console-caption">{text.unavailable}</p>
      </Panel>
    );
  }
  return (
    <Panel data-report-qa-defense="READY" title={text.title} tone="inset">
      {section.exchanges.length === 0 ? (
        <p className="console-caption">{text.empty}</p>
      ) : (
        <ol className="console-evidence-list" data-report-qa-exchanges>
          {section.exchanges.map((exchange, index) => (
            <li key={exchange.exchangeId}>
              <article className="console-evidence-card" data-report-qa-exchange={index + 1}>
                <h3>{exchange.question}</h3>
                <Badge tone="neutral">
                  {exchange.origin === "TYPED" ? text.typed : text.spoken}
                </Badge>
                {/* UTC ISO time: deterministic for tests and unambiguous across locales. */}
                <p className="console-qa__meta">
                  {text.askedAt}{" "}
                  <time dateTime={new Date(exchange.askedAtMs).toISOString()}>
                    {new Date(exchange.askedAtMs).toISOString()}
                  </time>
                </p>
                {exchange.defense.outcome === "ANSWERED" ? (
                  <AnsweredExchange citations={exchange.defense.citations} text={text}>
                    {exchange.defense.answerText}
                  </AnsweredExchange>
                ) : (
                  <article
                    className="console-qa__card"
                    data-report-qa-abstained={exchange.defense.retryable ? "RETRYABLE" : "TERMINAL"}
                  >
                    {/* The recorded abstention reason verbatim — honesty over polish. No answer
                        body is rendered anywhere inside this card. */}
                    <p data-report-qa-abstain-reason>{exchange.defense.abstainReason}</p>
                    <Badge tone="neutral">
                      {exchange.defense.retryable ? text.retryable : text.final}
                    </Badge>
                  </article>
                )}
              </article>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

function AnsweredExchange({
  children,
  citations,
  text,
}: Readonly<{
  children: string;
  citations: readonly QaDefenseCitationReportView[];
  text: ReportQaDefenseProps["text"];
}>) {
  return (
    <article className="console-qa__card" data-report-qa-answer="ANSWERED">
      {/* Sources lead, matching the live Q&A card: what backs the answer is the point. */}
      <ul className="console-qa__sources" aria-label={text.answerHeading}>
        {citations.map((entry, index) => (
          <li
            className="console-qa__source"
            key={`${entry.kind}-${index}`}
            data-report-qa-citation={entry.kind}
          >
            {entry.kind === "DECK_SLIDE" ? (
              <h3>{text.qaSourceSlide.replace("{ordinal}", String(entry.slideOrdinal))}</h3>
            ) : null}
            {entry.kind === "REFERENCE_DOCUMENT" ? (
              <>
                <h3>{entry.documentTitle}</h3>
                <p className="console-qa__meta">
                  {text.qaSourceReference.replace("{ordinal}", String(entry.chunkOrdinal))}
                </p>
              </>
            ) : null}
            {entry.kind === "EXTERNAL_SOURCE" ? (
              <h3>
                <a href={entry.url} rel="noreferrer" target="_blank">
                  {entry.url}
                </a>
              </h3>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="console-qa__answer-text" data-report-qa-answer-text>
        {children}
      </p>
    </article>
  );
}
