import { describe, expect, test } from "bun:test";
import {
  SlideOccurrenceWindowSchema,
  type TimedTranscript,
  TimedTranscriptSchema,
} from "@impromptu/contracts/private";
import { fuseTranscriptToSlide, mapDeviceIntervalToSession } from "./audio-fusion.ts";

function transcript(overrides: Partial<TimedTranscript> = {}): TimedTranscript {
  return TimedTranscriptSchema.parse({
    transcriptFinalId: "transcript_alpha",
    language: "ko-KR",
    text: "첫 번째 주장",
    audioStartDeviceMs: 1_100,
    audioEndDeviceMs: 1_500,
    clock: {
      mappingVersion: "clock-v1",
      deviceId: "device_microphone",
      anchorDeviceMs: 1_000,
      anchorSessionMs: 1_120,
      uncertaintyMs: 10,
      validFromDeviceMs: 900,
      validUntilDeviceMs: 2_000,
    },
    words: [
      { text: "첫", startDeviceMs: 1_120, endDeviceMs: 1_200 },
      { text: "주장", startDeviceMs: 1_350, endDeviceMs: 1_480 },
    ],
    ...overrides,
  });
}

const slides = [
  SlideOccurrenceWindowSchema.parse({
    occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
    startSessionMs: 1_000,
    endSessionMs: 1_700,
  }),
  SlideOccurrenceWindowSchema.parse({
    occurrence: { publicSlideKey: "slide_two", occurrenceSeq: 2 },
    startSessionMs: 1_700,
    endSessionMs: 2_400,
  }),
];
const firstSlide = slides[0];
if (firstSlide === undefined) throw new Error("slide fixture is required");

describe("cross-device clock mapping", () => {
  test("maps injected device offset and expands by bounded uncertainty", () => {
    expect(mapDeviceIntervalToSession(transcript(), 1_100, 1_500, 50)).toEqual({
      outcome: "MAPPED",
      mappingVersion: "clock-v1",
      startSessionMs: 1_210,
      endSessionMs: 1_630,
      uncertaintyMs: 10,
    });
  });

  test("abstains for excessive skew and spoofed timestamps outside the calibrated range", () => {
    expect(mapDeviceIntervalToSession(transcript(), 1_100, 1_500, 5)).toEqual({
      outcome: "AMBIGUOUS",
      reason: "CLOCK_UNCERTAINTY_EXCEEDED",
    });
    expect(mapDeviceIntervalToSession(transcript(), 899, 1_500, 50)).toEqual({
      outcome: "AMBIGUOUS",
      reason: "CLOCK_REFERENCE_OUT_OF_RANGE",
    });
  });
});

describe("slide occurrence STT fusion", () => {
  test("attributes an utterance only when one immutable occurrence covers its expanded interval", () => {
    const result = fuseTranscriptToSlide(transcript(), slides, { maxClockUncertaintyMs: 50 });
    expect(result).toEqual({
      outcome: "ATTRIBUTED",
      transcriptFinalId: "transcript_alpha",
      occurrence: firstSlide.occurrence,
      interval: {
        mappingVersion: "clock-v1",
        startSessionMs: 1_210,
        endSessionMs: 1_630,
        uncertaintyMs: 10,
      },
      words: [
        { text: "첫", startSessionMs: 1_240, endSessionMs: 1_320 },
        { text: "주장", startSessionMs: 1_470, endSessionMs: 1_600 },
      ],
    });
  });

  test("abstains deterministically for silence, boundary overlap, and late words", () => {
    expect(fuseTranscriptToSlide(transcript({ text: "", words: [] }), slides)).toEqual({
      outcome: "AMBIGUOUS",
      reason: "SILENCE",
    });
    expect(
      fuseTranscriptToSlide(
        transcript({
          audioEndDeviceMs: 1_700,
          words: [{ text: "경계", startDeviceMs: 1_650, endDeviceMs: 1_690 }],
        }),
        slides,
      ),
    ).toEqual({ outcome: "AMBIGUOUS", reason: "SLIDE_BOUNDARY_CROSSED" });
    expect(
      fuseTranscriptToSlide(
        transcript({ words: [{ text: "늦음", startDeviceMs: 1_450, endDeviceMs: 1_510 }] }),
        slides,
      ),
    ).toEqual({ outcome: "AMBIGUOUS", reason: "WORD_OUTSIDE_AUDIO_INTERVAL" });
  });
});
