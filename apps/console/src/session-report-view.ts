// The finalized session report: its closed view type and the strict parser that
// drops any field outside the shipped contract.

import { externalSourceUrl } from "./private-transport";

export interface SessionReportView {
  readonly reportVersion: 1 | 2;
  readonly presentationSessionId: string;
  readonly ownerAccountId: string;
  readonly finalizedAtMs: number;
  readonly totalDurationMs: number;
  readonly slideVisits: readonly Readonly<{
    sequence: number;
    publicSlideKey: string;
    occurrenceSequence: number;
    enteredOffsetMs: number;
    leftOffsetMs: number;
    dwellMs: number;
    revisit: boolean;
  }>[];
  readonly speech: Readonly<{
    derivedSummary: string;
    wordCount: number;
    speakingDurationMs: number;
    timingAggregate: Readonly<{
      finalCount: number;
      measuredFinalCount: number;
    }>;
    coachingAggregate: Readonly<{
      cueCount: number;
      latestCurrentWordsPerMinute: number | null;
      latestPreviousWordsPerMinute: number | null;
    }>;
  }>;
  readonly preparedEvidence: Readonly<{
    label: "준비된 근거";
    items: readonly Readonly<{
      evidenceId: string;
      sourceId: string;
      sourceUrl: string | null;
      provenance: "CURATED_PREAPPROVED" | "LIVE_VERIFIED";
    }>[];
  }>;
}

export type SessionReportReadView =
  | Readonly<{ status: "FINALIZED"; report: SessionReportView }>
  | Readonly<{ status: "PENDING" }>;

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nullableRate(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

export function sessionReport(value: unknown): SessionReportView | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const report = value as Record<string, unknown>;
  const slideVisits = report.slideVisits;
  const speech = report.speech;
  const preparedEvidence = report.preparedEvidence;
  if (
    (report.reportVersion !== 1 && report.reportVersion !== 2) ||
    typeof report.presentationSessionId !== "string" ||
    typeof report.ownerAccountId !== "string" ||
    !nonNegativeInteger(report.finalizedAtMs) ||
    !nonNegativeInteger(report.totalDurationMs) ||
    !Array.isArray(slideVisits) ||
    typeof speech !== "object" ||
    speech === null ||
    Array.isArray(speech) ||
    typeof preparedEvidence !== "object" ||
    preparedEvidence === null ||
    Array.isArray(preparedEvidence)
  ) {
    return null;
  }
  const parsedVisits = slideVisits.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const visit = entry as Record<string, unknown>;
    return nonNegativeInteger(visit.sequence) &&
      typeof visit.publicSlideKey === "string" &&
      nonNegativeInteger(visit.occurrenceSequence) &&
      nonNegativeInteger(visit.enteredOffsetMs) &&
      nonNegativeInteger(visit.leftOffsetMs) &&
      nonNegativeInteger(visit.dwellMs) &&
      typeof visit.revisit === "boolean"
      ? [
          {
            sequence: visit.sequence,
            publicSlideKey: visit.publicSlideKey,
            occurrenceSequence: visit.occurrenceSequence,
            enteredOffsetMs: visit.enteredOffsetMs,
            leftOffsetMs: visit.leftOffsetMs,
            dwellMs: visit.dwellMs,
            revisit: visit.revisit,
          },
        ]
      : [];
  });
  if (parsedVisits.length !== slideVisits.length) return null;

  const speechRecord = speech as Record<string, unknown>;
  const timing = speechRecord.timingAggregate;
  const coaching = speechRecord.coachingAggregate;
  if (
    typeof speechRecord.derivedSummary !== "string" ||
    !nonNegativeInteger(speechRecord.wordCount) ||
    !nonNegativeInteger(speechRecord.speakingDurationMs) ||
    typeof timing !== "object" ||
    timing === null ||
    Array.isArray(timing) ||
    typeof coaching !== "object" ||
    coaching === null ||
    Array.isArray(coaching)
  ) {
    return null;
  }
  const timingRecord = timing as Record<string, unknown>;
  const coachingRecord = coaching as Record<string, unknown>;
  if (
    !nonNegativeInteger(timingRecord.finalCount) ||
    !nonNegativeInteger(timingRecord.measuredFinalCount) ||
    !nonNegativeInteger(coachingRecord.cueCount) ||
    !nullableRate(coachingRecord.latestCurrentWordsPerMinute) ||
    !nullableRate(coachingRecord.latestPreviousWordsPerMinute)
  ) {
    return null;
  }

  const evidenceRecord = preparedEvidence as Record<string, unknown>;
  if (evidenceRecord.label !== "준비된 근거" || !Array.isArray(evidenceRecord.items)) return null;
  const items = evidenceRecord.items.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    const sourceUrl = item.sourceUrl === null ? null : externalSourceUrl(item.sourceUrl);
    if (
      typeof item.evidenceId !== "string" ||
      typeof item.sourceId !== "string" ||
      (item.sourceUrl !== null && sourceUrl === null) ||
      (item.provenance !== "CURATED_PREAPPROVED" && item.provenance !== "LIVE_VERIFIED")
    ) {
      return [];
    }
    const provenance: "CURATED_PREAPPROVED" | "LIVE_VERIFIED" = item.provenance;
    return [{ evidenceId: item.evidenceId, sourceId: item.sourceId, sourceUrl, provenance }];
  });
  if (items.length !== evidenceRecord.items.length) return null;

  const view: SessionReportView = {
    reportVersion: report.reportVersion === 2 ? 2 : 1,
    presentationSessionId: report.presentationSessionId,
    ownerAccountId: report.ownerAccountId,
    finalizedAtMs: report.finalizedAtMs,
    totalDurationMs: report.totalDurationMs,
    slideVisits: parsedVisits,
    speech: {
      derivedSummary: speechRecord.derivedSummary,
      wordCount: speechRecord.wordCount,
      speakingDurationMs: speechRecord.speakingDurationMs,
      timingAggregate: {
        finalCount: timingRecord.finalCount,
        measuredFinalCount: timingRecord.measuredFinalCount,
      },
      coachingAggregate: {
        cueCount: coachingRecord.cueCount,
        latestCurrentWordsPerMinute: coachingRecord.latestCurrentWordsPerMinute,
        latestPreviousWordsPerMinute: coachingRecord.latestPreviousWordsPerMinute,
      },
    },
    preparedEvidence: { label: "준비된 근거", items },
  };
  return view;
}
