/**
 * Derived FINAL-transcript aggregates: the only speech metrics kept in memory between live FINAL
 * segments and report materialization, plus the codec for their persisted coaching-aggregate JSON.
 */

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

export type MutableDerivedAggregate = {
  finalSegmentIds: Set<string>;
  finalCount: number;
  measuredFinalCount: number;
  wordCount: number;
  speakingDurationMs: number;
  cueCount: number;
  latestCurrentWordsPerMinute: number | null;
  latestPreviousWordsPerMinute: number | null;
};

export type StoredAggregate = Readonly<{
  timing: Readonly<{ finalCount: number; measuredFinalCount: number }>;
  coaching: Readonly<{
    cueCount: number;
    latestCurrentWordsPerMinute: number | null;
    latestPreviousWordsPerMinute: number | null;
  }>;
}>;

export function nonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
}

/** The Korean summary sentence persisted as the report's derivedSummary; bounded by CAS validation. */
export const DERIVED_SUMMARY_MAX_LENGTH = 4_000;

export function derivedSpeechSummary(finalCount: number, wordCount: number): string {
  return `${finalCount}개 최종 발화에서 ${wordCount}개 단어를 집계했습니다.`.slice(
    0,
    DERIVED_SUMMARY_MAX_LENGTH,
  );
}

/**
 * Validates one FINAL transcript plus optional coaching signal and folds its derived metrics into
 * the running aggregate. Throws RangeError on any timing or rate violation; idempotent on segment id.
 */
export function applyFinalTranscript(
  aggregate: MutableDerivedAggregate,
  input: FinalTranscriptAggregateInput,
): void {
  if (input.finalSegmentId.length === 0) throw new RangeError("finalSegmentId is required");
  nonNegativeInteger(input.transcript.durationMs, "durationMs");
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
}

function finiteRate(value: number | null, field: string): void {
  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    throw new RangeError(`${field} must be null or a non-negative finite number`);
  }
}

export function emptyAggregate(): MutableDerivedAggregate {
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

export function storedAggregate(aggregate: MutableDerivedAggregate): StoredAggregate {
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

export function parseStoredAggregate(value: unknown): StoredAggregate {
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
