import { describe, expect, test } from "bun:test";
import type { CoachingEvent } from "@impromptu/contracts/private";
import { type CoachingState, createCoachingState, reduceCoachingState } from "./coaching.ts";

function apply(events: readonly CoachingEvent[]): CoachingState {
  let state = createCoachingState();
  for (const event of events) {
    const result = reduceCoachingState(state, event);
    if (result.outcome !== "APPLIED") throw new Error(result.reason);
    state = result.state;
  }
  return state;
}

const optIn = { kind: "OPT_IN", enabled: true } satisfies CoachingEvent;
const previousFinal = {
  kind: "FINAL",
  sessionGeneration: 1,
  sequence: 1,
  segmentId: "segment_previous",
  finalSegmentId: "final_previous",
  finalizedAtSessionMs: 45_000,
  words: [
    { text: "직전", startSessionMs: 34_800, endSessionMs: 35_000 },
    { text: "구간", startSessionMs: 39_800, endSessionMs: 40_000 },
  ],
} satisfies CoachingEvent;
const currentFinal = {
  kind: "FINAL",
  sessionGeneration: 1,
  sequence: 2,
  segmentId: "segment_current",
  finalSegmentId: "final_current",
  finalizedAtSessionMs: 90_000,
  words: [
    { text: "현재", startSessionMs: 64_800, endSessionMs: 65_000 },
    { text: "고정", startSessionMs: 69_800, endSessionMs: 70_000 },
    { text: "단어", startSessionMs: 79_800, endSessionMs: 80_000 },
    { text: "fixture", startSessionMs: 89_800, endSessionMs: 90_000 },
  ],
} satisfies CoachingEvent;
const replacement = {
  kind: "REPLACE",
  sessionGeneration: 1,
  sequence: 3,
  segmentId: "segment_preview",
  replacesSequence: 0,
  preview: "교체된 미리보기",
} satisfies CoachingEvent;

describe("neutral coaching reducer", () => {
  test("computes exact current and previous 30-second pace and delta", () => {
    const state = apply([optIn, previousFinal, currentFinal]);

    expect(state.measurement).toEqual({
      outcome: "AVAILABLE",
      currentWordsPerMinute: 8,
      previousWordsPerMinute: 4,
      deltaWordsPerMinute: 4,
    });
    expect(state.cueCount).toBe(2);
  });

  test("is byte-deterministic across FINAL arrival order while REPLACE stays transient", () => {
    const chronological = apply([optIn, previousFinal, currentFinal, replacement]);
    const reordered = apply([optIn, replacement, currentFinal, previousFinal]);

    expect(JSON.stringify(reordered)).toBe(JSON.stringify(chronological));
    expect(reordered.transientPreview).toBe("교체된 미리보기");
    expect(reordered.measurement).toEqual({
      outcome: "AVAILABLE",
      currentWordsPerMinute: 8,
      previousWordsPerMinute: 4,
      deltaWordsPerMinute: 4,
    });
  });

  test("uses only validated FINAL words and rejects out-of-order word timestamps", () => {
    const previewOnly = apply([
      optIn,
      {
        kind: "PARTIAL",
        sessionGeneration: 1,
        sequence: 1,
        segmentId: "segment_preview",
        preview: "metric에 포함되지 않음",
      },
      replacement,
    ]);
    expect(previewOnly.measurement).toEqual({ outcome: "MEASUREMENT_UNAVAILABLE" });
    expect(previewOnly.cueCount).toBe(0);

    const invalid = reduceCoachingState(previewOnly, {
      ...currentFinal,
      sequence: 4,
      words: [
        { text: "뒤", startSessionMs: 70_000, endSessionMs: 71_000 },
        { text: "앞", startSessionMs: 60_000, endSessionMs: 61_000 },
      ],
    });
    expect(invalid).toEqual({ outcome: "REJECTED", reason: "INVALID_EVENT", state: previewOnly });
  });

  test("maps empty words, provider lag, and network abort to one unavailable outcome", () => {
    const emptyWords = apply([
      optIn,
      {
        ...currentFinal,
        words: [],
      },
    ]);
    const providerLag = apply([
      optIn,
      {
        kind: "PROVIDER_LAG",
        sessionGeneration: 1,
        sequence: 1,
      },
    ]);
    const networkAbort = apply([
      optIn,
      {
        kind: "NETWORK_ABORT",
        sessionGeneration: 1,
        sequence: 1,
      },
    ]);

    expect(emptyWords.measurement).toEqual({ outcome: "MEASUREMENT_UNAVAILABLE" });
    expect(providerLag.measurement).toEqual(emptyWords.measurement);
    expect(networkAbort.measurement).toEqual(emptyWords.measurement);
  });

  test("clears derived state on opt-out and carries mute as pure state", () => {
    const measured = apply([optIn, previousFinal, currentFinal]);
    const muted = reduceCoachingState(measured, { kind: "MUTE", muted: true });
    if (muted.outcome !== "APPLIED") throw new Error(muted.reason);
    expect(muted.state.muted).toBe(true);
    expect(muted.state.measurement).toEqual(measured.measurement);

    const optedOut = reduceCoachingState(muted.state, { kind: "OPT_IN", enabled: false });
    if (optedOut.outcome !== "APPLIED") throw new Error(optedOut.reason);
    expect(optedOut.state).toMatchObject({
      optedIn: false,
      transientPreview: null,
      measurement: { outcome: "MEASUREMENT_UNAVAILABLE" },
      cueCount: 0,
      finalSegments: {},
    });
  });
});
