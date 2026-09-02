/**
 * The finalized session report DTO contract plus its materialization from persisted state, visits
 * and exchanges. Version 2 adds the labeled 질의응답 section; version 1 rows materialize without it.
 */
import { QA_DEFENSE_REPORT_LABEL, type QaExchangeItem } from "../qa/qa-exchange-ledger.ts";
import { parseStoredAggregate } from "./final-transcript-aggregate.ts";
import type {
  SessionReportPrincipal,
  SessionReportState,
  SlideVisit,
} from "./postgres-session-report-repository.ts";

export type PreparedEvidenceReportItem = Readonly<{
  evidenceId: string;
  sourceId: string;
  sourceUrl: string | null;
  provenance: "CURATED_PREAPPROVED" | "LIVE_VERIFIED";
}>;

export type PreparedEvidenceReportSnapshot = Readonly<{
  label: "준비된 근거";
  items: readonly PreparedEvidenceReportItem[];
}>;

export type QaDefenseReportSection = Readonly<{
  label: typeof QA_DEFENSE_REPORT_LABEL;
  exchanges: readonly QaExchangeItem[];
}>;

export type SessionReport = Readonly<{
  reportVersion: 1 | 2;
  presentationSessionId: string;
  ownerAccountId: string;
  finalizedAtMs: number;
  totalDurationMs: number;
  slideVisits: readonly Readonly<{
    sequence: number;
    publicSlideKey: string;
    occurrenceSequence: number;
    enteredOffsetMs: number;
    leftOffsetMs: number;
    dwellMs: number;
    revisit: boolean;
  }>[];
  speech: Readonly<{
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
  preparedEvidence: PreparedEvidenceReportSnapshot;
  /** Additive v2 section; absent when a persisted v1 report is materialized. */
  qaDefense?: QaDefenseReportSection;
}>;

/** Persisted draft accepted by the finalizer; identical closed shape the repository stores. */
export type RecordQaExchangeDraft = QaExchangeItem;

export type ReportFinalizationResult =
  | Readonly<{ outcome: "FINALIZED"; report: SessionReport }>
  | Readonly<{ outcome: "FAILED"; error: Error }>;

export type SessionEndAccepted = Readonly<{
  status: "accepted";
  finalization: Promise<ReportFinalizationResult>;
}>;

export function clonePreparedEvidence(
  snapshot: PreparedEvidenceReportSnapshot,
): PreparedEvidenceReportSnapshot {
  if (snapshot.label !== "준비된 근거") {
    throw new RangeError("prepared evidence report label must be 준비된 근거");
  }
  return {
    label: "준비된 근거",
    items: snapshot.items.map((item) => ({ ...item })),
  };
}

export function reportFrom(
  principal: SessionReportPrincipal,
  state: SessionReportState,
  visits: readonly SlideVisit[],
  evidence: PreparedEvidenceReportSnapshot,
  exchanges: readonly QaExchangeItem[],
): SessionReport {
  if (state.finalizedAtMs === null) throw new Error("cannot materialize an unfinished report");
  if (exchanges.length > 0 && state.reportVersion === 1) {
    throw new Error("v1 reports must not carry qa defense exchanges");
  }
  const aggregate = parseStoredAggregate(state.coachingAggregate);
  const slideVisits = visits.map((visit) => ({
    sequence: visit.seq,
    publicSlideKey: visit.publicSlideKey,
    occurrenceSequence: visit.occurrenceSeq,
    enteredOffsetMs: visit.enteredOffsetMs,
    leftOffsetMs: visit.leftOffsetMs,
    dwellMs: visit.leftOffsetMs - visit.enteredOffsetMs,
    revisit: visit.occurrenceSeq > 1,
  }));
  const base = {
    reportVersion: state.reportVersion >= 2 ? (2 as const) : (1 as const),
    presentationSessionId: principal.presentationSessionId,
    ownerAccountId: principal.ownerSubject,
    finalizedAtMs: state.finalizedAtMs,
    totalDurationMs: slideVisits.reduce(
      (maximum, visit) => Math.max(maximum, visit.leftOffsetMs),
      0,
    ),
    slideVisits,
    speech: {
      derivedSummary: state.speechSummary,
      wordCount: state.wordCount,
      speakingDurationMs: state.speakingDurationMs,
      timingAggregate: aggregate.timing,
      coachingAggregate: aggregate.coaching,
    },
    preparedEvidence: clonePreparedEvidence(evidence),
  };
  return state.reportVersion >= 2
    ? {
        ...base,
        qaDefense: { label: QA_DEFENSE_REPORT_LABEL, exchanges },
      }
    : base;
}
