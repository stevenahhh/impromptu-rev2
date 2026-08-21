import type {
  ReportAggregateValue,
  SessionReportPrincipal,
  SessionReportRepository,
  SessionReportState,
  SlideVisit,
} from "./postgres-session-report-repository.ts";
import { SessionReportFinalizedError } from "./postgres-session-report-repository.ts";

const SUMMARY_MAX_LENGTH = 4_000;

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

export type FinalTranscriptAggregateInput = Readonly<{
  finalSegmentId: string;
  transcript: Readonly<{
    text: string;
    durationMs: number;
    words: readonly Readonly<{ text: string; startMs: number; endMs: number }>[];
  }>;
  coaching?: Readonly<{
    cueCount: number;
    currentWordsPerMinute: number | null;
    previousWordsPerMinute: number | null;
  }>;
}>;

export type SessionReport = Readonly<{
  reportVersion: 1;
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
}>;

export type ReportFinalizationResult =
  | Readonly<{ outcome: "FINALIZED"; report: SessionReport }>
  | Readonly<{ outcome: "FAILED"; error: Error }>;

export type SessionEndAccepted = Readonly<{
  status: "accepted";
  finalization: Promise<ReportFinalizationResult>;
}>;

type MutableDerivedAggregate = {
  finalSegmentIds: Set<string>;
  finalCount: number;
  measuredFinalCount: number;
  wordCount: number;
  speakingDurationMs: number;
  cueCount: number;
  latestCurrentWordsPerMinute: number | null;
  latestPreviousWordsPerMinute: number | null;
};

type ActiveVisit = Readonly<{
  principal: SessionReportPrincipal;
  presentationSessionEpoch: number;
  sequence: number;
  publicSlideKey: string;
  enteredOffsetMs: number;
  producerId: string;
}>;

type VisitTracker = {
  active: ActiveVisit | null;
  writes: Promise<void>;
  failure: unknown | null;
};

type StoredAggregate = Readonly<{
  timing: Readonly<{ finalCount: number; measuredFinalCount: number }>;
  coaching: Readonly<{
    cueCount: number;
    latestCurrentWordsPerMinute: number | null;
    latestPreviousWordsPerMinute: number | null;
  }>;
}>;

function sessionKey(principal: SessionReportPrincipal): string {
  return `${principal.tenantId}\u0000${principal.presentationSessionId}\u0000${principal.ownerSubject}`;
}

function samePrincipal(left: SessionReportPrincipal, right: SessionReportPrincipal): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.presentationSessionId === right.presentationSessionId &&
    left.ownerSubject === right.ownerSubject
  );
}

function nonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
}

function finiteRate(value: number | null, field: string): void {
  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    throw new RangeError(`${field} must be null or a non-negative finite number`);
  }
}

function emptyAggregate(): MutableDerivedAggregate {
  return {
    finalSegmentIds: new Set(),
    finalCount: 0,
    measuredFinalCount: 0,
    wordCount: 0,
    speakingDurationMs: 0,
    cueCount: 0,
    latestCurrentWordsPerMinute: null,
    latestPreviousWordsPerMinute: null,
  };
}

function storedAggregate(aggregate: MutableDerivedAggregate): StoredAggregate {
  return {
    timing: {
      finalCount: aggregate.finalCount,
      measuredFinalCount: aggregate.measuredFinalCount,
    },
    coaching: {
      cueCount: aggregate.cueCount,
      latestCurrentWordsPerMinute: aggregate.latestCurrentWordsPerMinute,
      latestPreviousWordsPerMinute: aggregate.latestPreviousWordsPerMinute,
    },
  };
}

function parseStoredAggregate(value: unknown): StoredAggregate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("stored session report aggregate is invalid");
  }
  const root = value as Record<string, unknown>;
  const timing = root.timing;
  const coaching = root.coaching;
  if (
    typeof timing !== "object" ||
    timing === null ||
    Array.isArray(timing) ||
    typeof coaching !== "object" ||
    coaching === null ||
    Array.isArray(coaching)
  ) {
    throw new Error("stored session report aggregate is invalid");
  }
  const timingRecord = timing as Record<string, unknown>;
  const coachingRecord = coaching as Record<string, unknown>;
  const finalCount = timingRecord.finalCount;
  const measuredFinalCount = timingRecord.measuredFinalCount;
  const cueCount = coachingRecord.cueCount;
  const current = coachingRecord.latestCurrentWordsPerMinute;
  const previous = coachingRecord.latestPreviousWordsPerMinute;
  if (
    typeof finalCount !== "number" ||
    typeof measuredFinalCount !== "number" ||
    typeof cueCount !== "number" ||
    (current !== null && typeof current !== "number") ||
    (previous !== null && typeof previous !== "number")
  ) {
    throw new Error("stored session report aggregate is invalid");
  }
  nonNegativeInteger(finalCount, "finalCount");
  nonNegativeInteger(measuredFinalCount, "measuredFinalCount");
  nonNegativeInteger(cueCount, "cueCount");
  finiteRate(current, "latestCurrentWordsPerMinute");
  finiteRate(previous, "latestPreviousWordsPerMinute");
  return {
    timing: { finalCount, measuredFinalCount },
    coaching: {
      cueCount,
      latestCurrentWordsPerMinute: current,
      latestPreviousWordsPerMinute: previous,
    },
  };
}

function clonePreparedEvidence(
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

function reportFrom(
  principal: SessionReportPrincipal,
  state: SessionReportState,
  visits: readonly SlideVisit[],
  evidence: PreparedEvidenceReportSnapshot,
): SessionReport {
  if (state.finalizedAtMs === null) throw new Error("cannot materialize an unfinished report");
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
  return {
    reportVersion: 1,
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
}

/**
 * Keeps only derived FINAL metrics in memory. Slide writes are serialized but are not awaited by
 * the live slide-set path; report materialization starts only after session end.
 */
export class SessionReportFinalizer {
  readonly #aggregates = new Map<string, MutableDerivedAggregate>();
  readonly #visits = new Map<string, VisitTracker>();
  readonly #ends = new Map<string, Promise<ReportFinalizationResult>>();

  constructor(private readonly reports: SessionReportRepository) {}

  recordFinal(principal: SessionReportPrincipal, input: FinalTranscriptAggregateInput): void {
    if (input.finalSegmentId.length === 0) throw new RangeError("finalSegmentId is required");
    nonNegativeInteger(input.transcript.durationMs, "durationMs");
    const key = sessionKey(principal);
    const aggregate = this.#aggregates.get(key) ?? emptyAggregate();
    if (aggregate.finalSegmentIds.has(input.finalSegmentId)) return;

    let speakingDurationMs = 0;
    for (const word of input.transcript.words) {
      nonNegativeInteger(word.startMs, "word.startMs");
      nonNegativeInteger(word.endMs, "word.endMs");
      if (word.endMs < word.startMs || word.endMs > input.transcript.durationMs) {
        throw new RangeError("word timing is outside the FINAL duration");
      }
      speakingDurationMs += word.endMs - word.startMs;
    }
    if (input.coaching !== undefined) {
      nonNegativeInteger(input.coaching.cueCount, "coaching.cueCount");
      finiteRate(input.coaching.currentWordsPerMinute, "coaching.currentWordsPerMinute");
      finiteRate(input.coaching.previousWordsPerMinute, "coaching.previousWordsPerMinute");
      aggregate.cueCount += input.coaching.cueCount;
      aggregate.latestCurrentWordsPerMinute = input.coaching.currentWordsPerMinute;
      aggregate.latestPreviousWordsPerMinute = input.coaching.previousWordsPerMinute;
    }
    aggregate.finalSegmentIds.add(input.finalSegmentId);
    aggregate.finalCount += 1;
    aggregate.wordCount += input.transcript.words.length;
    aggregate.speakingDurationMs += speakingDurationMs;
    if (input.transcript.words.length > 0) aggregate.measuredFinalCount += 1;
    this.#aggregates.set(key, aggregate);
    // input and its transcript text are deliberately not retained beyond this synchronous method.
  }

  recordAcceptedSlideSet(input: {
    readonly principal: SessionReportPrincipal;
    readonly presentationSessionEpoch: number;
    readonly sequence: number;
    readonly publicSlideKey: string;
    readonly acceptedOffsetMs: number;
    readonly producerId: string;
  }): void {
    nonNegativeInteger(input.acceptedOffsetMs, "acceptedOffsetMs");
    const key = sessionKey(input.principal);
    const tracker = this.#visits.get(key) ?? {
      active: null,
      writes: Promise.resolve(),
      failure: null,
    };
    const previous = tracker.active;
    if (previous !== null) {
      if (!samePrincipal(previous.principal, input.principal)) {
        throw new Error("slide visit principal changed within a session");
      }
      tracker.writes = tracker.writes.then(async () => {
        if (tracker.failure !== null) return;
        try {
          await this.reports.appendSlideVisit({
            ...previous.principal,
            presentationSessionEpoch: previous.presentationSessionEpoch,
            seq: previous.sequence,
            publicSlideKey: previous.publicSlideKey,
            enteredOffsetMs: previous.enteredOffsetMs,
            leftOffsetMs: input.acceptedOffsetMs,
            producerId: previous.producerId,
          });
        } catch (error) {
          tracker.failure = error;
        }
      });
    }
    tracker.active = {
      principal: input.principal,
      presentationSessionEpoch: input.presentationSessionEpoch,
      sequence: input.sequence,
      publicSlideKey: input.publicSlideKey,
      enteredOffsetMs: input.acceptedOffsetMs,
      producerId: input.producerId,
    };
    this.#visits.set(key, tracker);
  }

  async endSession(input: {
    readonly principal: SessionReportPrincipal;
    readonly endedOffsetMs: number;
    readonly finalizedAtMs: number;
    readonly preparedEvidence: PreparedEvidenceReportSnapshot;
  }): Promise<SessionEndAccepted> {
    nonNegativeInteger(input.endedOffsetMs, "endedOffsetMs");
    nonNegativeInteger(input.finalizedAtMs, "finalizedAtMs");
    const key = sessionKey(input.principal);
    const existingEnd = this.#ends.get(key);
    if (existingEnd !== undefined) return { status: "accepted", finalization: existingEnd };

    const tracker = this.#visits.get(key);
    if (tracker !== undefined) {
      await tracker.writes;
      if (tracker.failure !== null) throw tracker.failure;
      if (tracker.active !== null) {
        await this.reports.appendSlideVisit({
          ...tracker.active.principal,
          presentationSessionEpoch: tracker.active.presentationSessionEpoch,
          seq: tracker.active.sequence,
          publicSlideKey: tracker.active.publicSlideKey,
          enteredOffsetMs: tracker.active.enteredOffsetMs,
          leftOffsetMs: input.endedOffsetMs,
          producerId: tracker.active.producerId,
        });
      }
    }

    const aggregate = this.#aggregates.get(key) ?? emptyAggregate();
    const current = await this.reports.readForOwner(input.principal);
    if (current?.finalizedAtMs !== null && current !== null) {
      const result = this.readFinalizedReport(input.principal, input.preparedEvidence).then(
        (report) =>
          report === null
            ? { outcome: "FAILED" as const, error: new Error("finalized report is unavailable") }
            : { outcome: "FINALIZED" as const, report },
      );
      this.#ends.set(key, result);
      return { status: "accepted", finalization: result };
    }

    const summary =
      `${aggregate.finalCount}개 최종 발화에서 ${aggregate.wordCount}개 단어를 집계했습니다.`.slice(
        0,
        SUMMARY_MAX_LENGTH,
      );
    const saved =
      current ??
      (await this.reports.compareAndSetState({
        ...input.principal,
        expectedRevision: 0,
        speechSummary: summary,
        wordCount: aggregate.wordCount,
        speakingDurationMs: aggregate.speakingDurationMs,
        coachingAggregate: storedAggregate(aggregate) as Readonly<
          Record<string, ReportAggregateValue>
        >,
        finalizedAtMs: null,
      }));
    const evidence = clonePreparedEvidence(input.preparedEvidence);
    const finalization = Promise.resolve().then(async (): Promise<ReportFinalizationResult> => {
      try {
        let finalized: SessionReportState;
        try {
          finalized = await this.reports.compareAndSetState({
            ...input.principal,
            expectedRevision: saved.revision,
            speechSummary: saved.speechSummary,
            wordCount: saved.wordCount,
            speakingDurationMs: saved.speakingDurationMs,
            coachingAggregate: parseStoredAggregate(saved.coachingAggregate) as Readonly<
              Record<string, ReportAggregateValue>
            >,
            finalizedAtMs: input.finalizedAtMs,
          });
        } catch (error) {
          if (!(error instanceof SessionReportFinalizedError)) throw error;
          const alreadyFinalized = await this.reports.readForOwner(input.principal);
          if (alreadyFinalized?.finalizedAtMs === null || alreadyFinalized === null) throw error;
          finalized = alreadyFinalized;
        }
        const visits = await this.reports.readSlideVisits(input.principal);
        return {
          outcome: "FINALIZED",
          report: reportFrom(input.principal, finalized, visits, evidence),
        };
      } catch (error) {
        return {
          outcome: "FAILED",
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    });
    this.#ends.set(key, finalization);
    void finalization.then((result) => {
      if (result.outcome === "FAILED" && this.#ends.get(key) === finalization) {
        this.#ends.delete(key);
      }
    });
    return { status: "accepted", finalization };
  }

  async readFinalizedReport(
    principal: SessionReportPrincipal,
    preparedEvidence: PreparedEvidenceReportSnapshot,
  ): Promise<SessionReport | null> {
    const state = await this.reports.readForOwner(principal);
    if (state?.finalizedAtMs === null || state === null) return null;
    const visits = await this.reports.readSlideVisits(principal);
    return reportFrom(principal, state, visits, preparedEvidence);
  }
}

/** Narrow adapter used by PreparedEvidenceCoordinator without adding report work to slide latency. */
export function createPreparedEvidenceReportObserver(
  finalizer: SessionReportFinalizer,
  onFailure: (error: unknown) => void,
): Readonly<{
  onAcceptedSlideSet(input: {
    readonly tenantId: string;
    readonly presentationSessionId: string;
    readonly ownerSubject: string;
    readonly presentationSessionEpoch: number;
    readonly sequence: number;
    readonly publicSlideKey: string;
    readonly acceptedOffsetMs: number;
    readonly producerId: string;
  }): void;
  onPresentationEnded(input: {
    readonly tenantId: string;
    readonly presentationSessionId: string;
    readonly ownerSubject: string;
    readonly endedOffsetMs: number;
    readonly finalizedAtMs: number;
    readonly preparedEvidence: PreparedEvidenceReportSnapshot;
  }): Promise<void>;
  onFailure(error: unknown): void;
}> {
  return {
    onAcceptedSlideSet(input) {
      finalizer.recordAcceptedSlideSet({
        principal: {
          tenantId: input.tenantId,
          presentationSessionId: input.presentationSessionId,
          ownerSubject: input.ownerSubject,
        },
        presentationSessionEpoch: input.presentationSessionEpoch,
        sequence: input.sequence,
        publicSlideKey: input.publicSlideKey,
        acceptedOffsetMs: input.acceptedOffsetMs,
        producerId: input.producerId,
      });
    },
    async onPresentationEnded(input) {
      await finalizer.endSession({
        principal: {
          tenantId: input.tenantId,
          presentationSessionId: input.presentationSessionId,
          ownerSubject: input.ownerSubject,
        },
        endedOffsetMs: input.endedOffsetMs,
        finalizedAtMs: input.finalizedAtMs,
        preparedEvidence: input.preparedEvidence,
      });
    },
    onFailure,
  };
}
