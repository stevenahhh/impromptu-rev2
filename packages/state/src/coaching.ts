import {
  COACHING_ROLLING_WINDOW_MS,
  type CoachingEvent,
  CoachingEventSchema,
  type CoachingFinalEvent,
  type CoachingMeasurement,
} from "@impromptu/contracts/private";

interface FinalSegmentState {
  readonly sequence: number;
  readonly finalizedAtSessionMs: number;
  readonly words: CoachingFinalEvent["words"];
}

export type CoachingState = Readonly<{
  optedIn: boolean;
  muted: boolean;
  transientPreview: string | null;
  measurement: CoachingMeasurement;
  cueCount: number;
  activeSessionGeneration: number | null;
  latestTranscriptSequence: number;
  latestMetricSequence: number;
  measurementBlocked: boolean;
  finalSegments: Readonly<Record<string, FinalSegmentState>>;
}>;

export type CoachingReducerResult =
  | Readonly<{ outcome: "APPLIED"; state: CoachingState }>
  | Readonly<{ outcome: "REJECTED"; reason: "INVALID_EVENT"; state: CoachingState }>;

const unavailableMeasurement = (): CoachingMeasurement => ({
  outcome: "MEASUREMENT_UNAVAILABLE",
});

export function createCoachingState(): CoachingState {
  return {
    optedIn: false,
    muted: false,
    transientPreview: null,
    measurement: unavailableMeasurement(),
    cueCount: 0,
    activeSessionGeneration: null,
    latestTranscriptSequence: -1,
    latestMetricSequence: -1,
    measurementBlocked: false,
    finalSegments: {},
  };
}

function clearTranscriptState(state: CoachingState, activeSessionGeneration: number | null) {
  return {
    ...state,
    transientPreview: null,
    measurement: unavailableMeasurement(),
    cueCount: 0,
    activeSessionGeneration,
    latestTranscriptSequence: -1,
    latestMetricSequence: -1,
    measurementBlocked: false,
    finalSegments: {},
  } satisfies CoachingState;
}

function measurementFor(
  finalSegments: CoachingState["finalSegments"],
  measurementBlocked: boolean,
): CoachingMeasurement {
  if (measurementBlocked) return unavailableMeasurement();
  const segments = Object.values(finalSegments);
  let anchor: FinalSegmentState | undefined;
  for (const segment of segments) {
    if (anchor === undefined || segment.sequence > anchor.sequence) anchor = segment;
  }
  if (anchor === undefined || anchor.words.length === 0) return unavailableMeasurement();

  const currentStartMs = anchor.finalizedAtSessionMs - COACHING_ROLLING_WINDOW_MS;
  const previousStartMs = currentStartMs - COACHING_ROLLING_WINDOW_MS;
  let currentWordCount = 0;
  let previousWordCount = 0;
  for (const segment of segments) {
    for (const word of segment.words) {
      if (word.endSessionMs > currentStartMs && word.endSessionMs <= anchor.finalizedAtSessionMs) {
        currentWordCount += 1;
      } else if (word.endSessionMs > previousStartMs && word.endSessionMs <= currentStartMs) {
        previousWordCount += 1;
      }
    }
  }
  if (currentWordCount === 0 || previousWordCount === 0) return unavailableMeasurement();

  const windowsPerMinute = 60_000 / COACHING_ROLLING_WINDOW_MS;
  const currentWordsPerMinute = currentWordCount * windowsPerMinute;
  const previousWordsPerMinute = previousWordCount * windowsPerMinute;
  return {
    outcome: "AVAILABLE",
    currentWordsPerMinute,
    previousWordsPerMinute,
    deltaWordsPerMinute: currentWordsPerMinute - previousWordsPerMinute,
  };
}

function canonicalFinalSegments(
  finalSegments: CoachingState["finalSegments"],
  event: CoachingFinalEvent,
): CoachingState["finalSegments"] {
  const existing = finalSegments[event.finalSegmentId];
  if (existing !== undefined && existing.sequence > event.sequence) return finalSegments;
  return Object.fromEntries(
    Object.entries({
      ...finalSegments,
      [event.finalSegmentId]: {
        sequence: event.sequence,
        finalizedAtSessionMs: event.finalizedAtSessionMs,
        words: event.words,
      },
    }).sort(([leftId], [rightId]) => (leftId < rightId ? -1 : leftId > rightId ? 1 : 0)),
  );
}

function transcriptGeneration(event: CoachingEvent): number | null {
  return event.kind === "OPT_IN" || event.kind === "MUTE" ? null : event.sessionGeneration;
}

export function reduceCoachingState(state: CoachingState, input: unknown): CoachingReducerResult {
  const parsed = CoachingEventSchema.safeParse(input);
  if (!parsed.success) return { outcome: "REJECTED", reason: "INVALID_EVENT", state };
  const event = parsed.data;

  if (event.kind === "OPT_IN") {
    if (!event.enabled) {
      return {
        outcome: "APPLIED",
        state: clearTranscriptState({ ...state, optedIn: false }, null),
      };
    }
    return {
      outcome: "APPLIED",
      state: state.optedIn ? state : clearTranscriptState({ ...state, optedIn: true }, null),
    };
  }
  if (event.kind === "MUTE") {
    return { outcome: "APPLIED", state: { ...state, muted: event.muted } };
  }
  if (!state.optedIn) return { outcome: "APPLIED", state };

  const generation = transcriptGeneration(event);
  if (generation === null) return { outcome: "APPLIED", state };
  if (state.activeSessionGeneration !== null && generation < state.activeSessionGeneration) {
    return { outcome: "APPLIED", state };
  }
  const generationState =
    state.activeSessionGeneration === null || generation > state.activeSessionGeneration
      ? clearTranscriptState(state, generation)
      : state;

  if (event.kind === "PARTIAL" || event.kind === "REPLACE") {
    if (event.sequence <= generationState.latestTranscriptSequence) {
      return { outcome: "APPLIED", state: generationState };
    }
    return {
      outcome: "APPLIED",
      state: {
        ...generationState,
        transientPreview: event.preview,
        latestTranscriptSequence: event.sequence,
      },
    };
  }

  if (event.kind === "PROVIDER_LAG" || event.kind === "NETWORK_ABORT") {
    const isLatestTranscript = event.sequence > generationState.latestTranscriptSequence;
    const isLatestMetric = event.sequence > generationState.latestMetricSequence;
    return {
      outcome: "APPLIED",
      state: {
        ...generationState,
        transientPreview: isLatestTranscript ? null : generationState.transientPreview,
        measurement: isLatestMetric ? unavailableMeasurement() : generationState.measurement,
        latestTranscriptSequence: isLatestTranscript
          ? event.sequence
          : generationState.latestTranscriptSequence,
        latestMetricSequence: isLatestMetric
          ? event.sequence
          : generationState.latestMetricSequence,
        measurementBlocked: isLatestMetric ? true : generationState.measurementBlocked,
      },
    };
  }

  const finalSegments = canonicalFinalSegments(generationState.finalSegments, event);
  const isLatestTranscript = event.sequence > generationState.latestTranscriptSequence;
  const isLatestMetric = event.sequence > generationState.latestMetricSequence;
  const measurementBlocked = isLatestMetric
    ? event.words.length === 0
    : generationState.measurementBlocked;
  return {
    outcome: "APPLIED",
    state: {
      ...generationState,
      transientPreview: isLatestTranscript ? null : generationState.transientPreview,
      measurement: measurementFor(finalSegments, measurementBlocked),
      cueCount: Object.values(finalSegments).filter((segment) => segment.words.length > 0).length,
      latestTranscriptSequence: isLatestTranscript
        ? event.sequence
        : generationState.latestTranscriptSequence,
      latestMetricSequence: isLatestMetric ? event.sequence : generationState.latestMetricSequence,
      measurementBlocked,
      finalSegments,
    },
  };
}
