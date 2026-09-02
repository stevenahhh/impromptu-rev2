// Text contract for the finalized-report surface plus its mapping from page message keys.

import type { Messages } from "./i18n";

export type PresentationReportText = Readonly<{
  title: string;
  lead: string;
  finalized: string;
  totalDuration: string;
  durationUnit: string;
  slideVisits: string;
  slide: string;
  occurrence: string;
  dwell: string;
  revisit: string;
  firstVisit: string;
  speech: string;
  speechSummary: string;
  wordCount: string;
  speakingDuration: string;
  timingAggregate: string;
  finalCount: string;
  measuredFinalCount: string;
  coachingAggregate: string;
  cueCount: string;
  currentPace: string;
  previousPace: string;
  unavailable: string;
  preparedEvidence: string;
  evidenceEmpty: string;
  evidenceItem: string;
  evidenceSourceUrl: string;
  evidenceProvenance: string;
  sourceUnavailable: string;
  curatedEvidence: string;
  liveEvidence: string;
}>;

/** Maps the page's message keys onto the report surface so callers stay declarative. */
export function presentationReportText(m: Messages): PresentationReportText {
  return {
    title: m.reportTitle,
    lead: m.reportLead,
    finalized: m.reportFinalized,
    totalDuration: m.reportTotalDuration,
    durationUnit: m.reportDurationUnit,
    slideVisits: m.reportSlideVisits,
    slide: m.reportSlide,
    occurrence: m.reportOccurrence,
    dwell: m.reportDwell,
    revisit: m.reportRevisit,
    firstVisit: m.reportFirstVisit,
    speech: m.reportSpeech,
    speechSummary: m.reportSpeechSummary,
    wordCount: m.reportWordCount,
    speakingDuration: m.reportSpeakingDuration,
    timingAggregate: m.reportTimingAggregate,
    finalCount: m.reportFinalCount,
    measuredFinalCount: m.reportMeasuredFinalCount,
    coachingAggregate: m.reportCoachingAggregate,
    cueCount: m.reportCueCount,
    currentPace: m.reportCurrentPace,
    previousPace: m.reportPreviousPace,
    unavailable: m.coachingUnavailable,
    preparedEvidence: m.preparedEvidence,
    evidenceEmpty: m.reportEvidenceEmpty,
    evidenceItem: m.reportEvidenceItem,
    evidenceSourceUrl: m.evidenceSourceUrl,
    evidenceProvenance: m.reportEvidenceProvenance,
    sourceUnavailable: m.sourceUnavailable,
    curatedEvidence: m.reportCuratedEvidence,
    liveEvidence: m.reportLiveEvidence,
  };
}
