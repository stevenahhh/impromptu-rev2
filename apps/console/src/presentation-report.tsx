import { Badge, Panel } from "@impromptu/ui";
import type { PresentationReportText } from "./presentation-report-text";
import { ReportQaDefense } from "./report-qa-defense";
import type { SessionReportView } from "./session-client";

export interface PresentationReportProps {
  readonly report: SessionReportView;
  readonly text: PresentationReportText;
  /** Deck slides keyed by publicSlideKey; the host derives it from the in-session deck. */
  readonly slides?: ReadonlyMap<string, PresentationSlideEntry> | undefined;
}

export interface PresentationSlideEntry {
  readonly ordinal: number;
  readonly label: string;
}

function duration(value: number, unit: string): string {
  return `${(value / 1_000).toFixed(1)}${unit}`;
}

/**
 * Human slide identifier for a visit: the deck label when the deck is in session, otherwise
 * the deck ordinal, otherwise the visit's occurrence order. The raw key never reaches text.
 */
function slideTitle(
  visit: SessionReportView["slideVisits"][number],
  slides: ReadonlyMap<string, PresentationSlideEntry> | undefined,
  slideWord: string,
): string {
  const slide = slides?.get(visit.publicSlideKey);
  if (slide !== undefined && slide.label.trim().length > 0) return slide.label;
  return `${slideWord} ${slide !== undefined ? slide.ordinal : visit.sequence}`;
}

function pace(value: number | null, unavailable: string): string {
  return value === null ? unavailable : `${value} WPM`;
}

export function PresentationReport({ report, text, slides }: PresentationReportProps) {
  return (
    <article className="console-stack ui-reveal" data-presentation-report="ready">
      <header>
        <p className="ui-eyebrow">{text.finalized}</p>
        <h1>{text.title}</h1>
        <p className="console-lead">{text.lead}</p>
      </header>

      <Panel title={text.totalDuration} tone="inset">
        <strong data-report-total-duration-ms={report.totalDurationMs}>
          {duration(report.totalDurationMs, text.durationUnit)}
        </strong>
      </Panel>

      <Panel title={text.slideVisits} tone="inset">
        <ol className="console-evidence-list" data-report-slide-visits>
          {report.slideVisits.map((visit) => (
            <li key={visit.sequence}>
              <article
                className="console-evidence-card"
                data-report-slide-visit={visit.sequence}
                data-report-slide-key={visit.publicSlideKey}
                data-report-occurrence={visit.occurrenceSequence}
                data-report-dwell-ms={visit.dwellMs}
              >
                <h3 data-report-slide-title>{slideTitle(visit, slides, text.slide)}</h3>
                <Badge tone="neutral">
                  {text.occurrence} {visit.occurrenceSequence}
                </Badge>
                <dl>
                  <div>
                    <dt>{text.dwell}</dt>
                    <dd>{duration(visit.dwellMs, text.durationUnit)}</dd>
                  </div>
                  <div>
                    <dt>{text.revisit}</dt>
                    <dd>{visit.revisit ? text.revisit : text.firstVisit}</dd>
                  </div>
                </dl>
              </article>
            </li>
          ))}
        </ol>
      </Panel>

      <Panel title={text.speech} tone="inset">
        <dl className="console-evidence-card">
          <div>
            <dt>{text.speechSummary}</dt>
            <dd data-report-speech-summary>{report.speech.derivedSummary}</dd>
          </div>
          <div>
            <dt>{text.wordCount}</dt>
            <dd data-report-word-count={report.speech.wordCount}>{report.speech.wordCount}</dd>
          </div>
          <div>
            <dt>{text.speakingDuration}</dt>
            <dd>{duration(report.speech.speakingDurationMs, text.durationUnit)}</dd>
          </div>
        </dl>
      </Panel>

      <Panel title={text.timingAggregate} tone="inset">
        <dl className="console-evidence-card">
          <div>
            <dt>{text.finalCount}</dt>
            <dd>{report.speech.timingAggregate.finalCount}</dd>
          </div>
          <div>
            <dt>{text.measuredFinalCount}</dt>
            <dd>{report.speech.timingAggregate.measuredFinalCount}</dd>
          </div>
        </dl>
      </Panel>

      <Panel title={text.coachingAggregate} tone="inset">
        <dl className="console-evidence-card" data-report-coaching-aggregate>
          <div>
            <dt>{text.cueCount}</dt>
            <dd>{report.speech.coachingAggregate.cueCount}</dd>
          </div>
          <div>
            <dt>{text.currentPace}</dt>
            <dd>
              {pace(report.speech.coachingAggregate.latestCurrentWordsPerMinute, text.unavailable)}
            </dd>
          </div>
          <div>
            <dt>{text.previousPace}</dt>
            <dd>
              {pace(report.speech.coachingAggregate.latestPreviousWordsPerMinute, text.unavailable)}
            </dd>
          </div>
        </dl>
      </Panel>

      <Panel title={text.preparedEvidence} tone="inset">
        {report.preparedEvidence.items.length === 0 ? (
          <p className="console-caption">{text.evidenceEmpty}</p>
        ) : (
          <ul className="console-evidence-list" data-report-prepared-evidence>
            {report.preparedEvidence.items.map((item, index) => (
              <li key={item.evidenceId}>
                <article className="console-evidence-card" data-report-evidence={index + 1}>
                  <h3>
                    {text.evidenceItem} {index + 1}
                  </h3>
                  <Badge tone="neutral">
                    {item.provenance === "CURATED_PREAPPROVED"
                      ? text.curatedEvidence
                      : text.liveEvidence}
                  </Badge>
                  <dl>
                    <div>
                      <dt>{text.evidenceSourceUrl}</dt>
                      <dd>
                        {item.sourceUrl === null ? (
                          text.sourceUnavailable
                        ) : (
                          <a href={item.sourceUrl} rel="noreferrer" target="_blank">
                            {item.sourceUrl}
                          </a>
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>{text.evidenceProvenance}</dt>
                      <dd>
                        {item.provenance === "CURATED_PREAPPROVED"
                          ? text.curatedEvidence
                          : text.liveEvidence}
                      </dd>
                    </div>
                  </dl>
                </article>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* Additive v2 section: v1 reports carry no qaDefense and render nothing here. */}
      {report.qaDefense === undefined ? null : (
        <ReportQaDefense
          section={report.qaDefense}
          text={{
            title: text.reportQaTitle,
            empty: text.reportQaEmpty,
            unavailable: text.reportQaUnavailable,
            typed: text.reportQaTyped,
            spoken: text.reportQaSpoken,
            askedAt: text.reportQaAskedAt,
            answerHeading: text.reportQaAnswerHeading,
            retryable: text.reportQaRetryable,
            final: text.reportQaFinal,
            qaSourceSlide: text.qaSourceSlide,
            qaSourceReference: text.qaSourceReference,
          }}
        />
      )}
    </article>
  );
}
