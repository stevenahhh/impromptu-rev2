import type { SlideOccurrenceWindow, TimedTranscript } from "@impromptu/contracts/private";
import type { PublicSlideOccurrence } from "@impromptu/contracts/public";

export type ClockMappingResult =
  | Readonly<{
      outcome: "MAPPED";
      mappingVersion: string;
      startSessionMs: number;
      endSessionMs: number;
      uncertaintyMs: number;
    }>
  | Readonly<{
      outcome: "AMBIGUOUS";
      reason: "CLOCK_REFERENCE_OUT_OF_RANGE" | "CLOCK_UNCERTAINTY_EXCEEDED";
    }>;

export type TranscriptFusionResult =
  | Readonly<{
      outcome: "ATTRIBUTED";
      transcriptFinalId: string;
      occurrence: PublicSlideOccurrence;
      interval: Omit<Extract<ClockMappingResult, { outcome: "MAPPED" }>, "outcome">;
      words: readonly Readonly<{
        text: string;
        startSessionMs: number;
        endSessionMs: number;
      }>[];
    }>
  | Readonly<{
      outcome: "AMBIGUOUS";
      reason:
        | "CLOCK_REFERENCE_OUT_OF_RANGE"
        | "CLOCK_UNCERTAINTY_EXCEEDED"
        | "SILENCE"
        | "SLIDE_BOUNDARY_CROSSED"
        | "WORD_OUTSIDE_AUDIO_INTERVAL";
    }>;

export function mapDeviceIntervalToSession(
  transcript: TimedTranscript,
  startDeviceMs: number,
  endDeviceMs: number,
  maxClockUncertaintyMs = 50,
): ClockMappingResult {
  const clock = transcript.clock;
  if (
    startDeviceMs < clock.validFromDeviceMs ||
    endDeviceMs > clock.validUntilDeviceMs ||
    endDeviceMs < startDeviceMs
  ) {
    return { outcome: "AMBIGUOUS", reason: "CLOCK_REFERENCE_OUT_OF_RANGE" };
  }
  if (clock.uncertaintyMs > maxClockUncertaintyMs) {
    return { outcome: "AMBIGUOUS", reason: "CLOCK_UNCERTAINTY_EXCEEDED" };
  }
  const offsetMs = clock.anchorSessionMs - clock.anchorDeviceMs;
  return {
    outcome: "MAPPED",
    mappingVersion: clock.mappingVersion,
    startSessionMs: startDeviceMs + offsetMs - clock.uncertaintyMs,
    endSessionMs: endDeviceMs + offsetMs + clock.uncertaintyMs,
    uncertaintyMs: clock.uncertaintyMs,
  };
}

export function fuseTranscriptToSlide(
  transcript: TimedTranscript,
  windows: readonly SlideOccurrenceWindow[],
  options: Readonly<{ maxClockUncertaintyMs?: number }> = {},
): TranscriptFusionResult {
  if (transcript.text.trim().length === 0 || transcript.words.length === 0) {
    return { outcome: "AMBIGUOUS", reason: "SILENCE" };
  }
  if (
    transcript.words.some(
      (word) =>
        word.startDeviceMs < transcript.audioStartDeviceMs ||
        word.endDeviceMs > transcript.audioEndDeviceMs,
    )
  ) {
    return { outcome: "AMBIGUOUS", reason: "WORD_OUTSIDE_AUDIO_INTERVAL" };
  }
  const mapped = mapDeviceIntervalToSession(
    transcript,
    transcript.audioStartDeviceMs,
    transcript.audioEndDeviceMs,
    options.maxClockUncertaintyMs,
  );
  if (mapped.outcome === "AMBIGUOUS") return mapped;

  const covering = windows.filter(
    (window) =>
      window.startSessionMs <= mapped.startSessionMs && window.endSessionMs >= mapped.endSessionMs,
  );
  if (covering.length !== 1) {
    return { outcome: "AMBIGUOUS", reason: "SLIDE_BOUNDARY_CROSSED" };
  }
  const window = covering[0];
  if (window === undefined) {
    return { outcome: "AMBIGUOUS", reason: "SLIDE_BOUNDARY_CROSSED" };
  }
  const offsetMs = transcript.clock.anchorSessionMs - transcript.clock.anchorDeviceMs;
  return {
    outcome: "ATTRIBUTED",
    transcriptFinalId: transcript.transcriptFinalId,
    occurrence: window.occurrence,
    interval: {
      mappingVersion: mapped.mappingVersion,
      startSessionMs: mapped.startSessionMs,
      endSessionMs: mapped.endSessionMs,
      uncertaintyMs: mapped.uncertaintyMs,
    },
    words: transcript.words.map((word) => ({
      text: word.text,
      startSessionMs: word.startDeviceMs + offsetMs,
      endSessionMs: word.endDeviceMs + offsetMs,
    })),
  };
}
