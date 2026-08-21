import {
  SlideOccurrenceWindowSchema,
  type TimedTranscript,
  TimedTranscriptSchema,
} from "@impromptu/contracts/private";
import {
  type PublicSlideOccurrence,
  PublicSlideOccurrenceSchema,
} from "@impromptu/contracts/public";
import { z } from "zod";

export interface ClockMappingAuthority {
  readonly presentationSessionId: string;
  readonly presentationSessionEpoch: string;
  readonly mappingVersion: string;
  readonly deviceId: string;
  readonly anchorDeviceMs: number;
  readonly anchorSessionMs: number;
  readonly maxClockOffsetMs: number;
}

export interface ClockMappingPolicy {
  readonly authority: ClockMappingAuthority;
  readonly maxClockUncertaintyMs?: number;
}

type ClockFailureReason =
  | "CLOCK_OFFSET_EXCEEDED"
  | "CLOCK_REFERENCE_OUT_OF_RANGE"
  | "CLOCK_REFERENCE_UNAUTHORIZED"
  | "CLOCK_UNCERTAINTY_EXCEEDED"
  | "CLOCK_VALUE_INVALID";

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
      reason: ClockFailureReason;
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
        | ClockFailureReason
        | "MEASUREMENT_UNAVAILABLE"
        | "SLIDE_BOUNDARY_CROSSED"
        | "SLIDE_WINDOW_INVALID"
        | "TRANSCRIPT_INVALID"
        | "WORD_OUTSIDE_AUDIO_INTERVAL";
    }>;

type FusionFailureReason = Extract<TranscriptFusionResult, { outcome: "AMBIGUOUS" }>["reason"];

const AttributedFusionSchema = z
  .object({
    outcome: z.literal("ATTRIBUTED"),
    transcriptFinalId: z.string().min(1),
    occurrence: PublicSlideOccurrenceSchema,
    interval: z
      .object({
        mappingVersion: z.string().min(1),
        startSessionMs: z.number().finite().nonnegative(),
        endSessionMs: z.number().finite().nonnegative(),
        uncertaintyMs: z.number().finite().nonnegative(),
      })
      .strict(),
    words: z.array(
      z
        .object({
          text: z.string().min(1),
          startSessionMs: z.number().finite().nonnegative(),
          endSessionMs: z.number().finite().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();

export function mapDeviceIntervalToSession(
  untrustedTranscript: TimedTranscript,
  startDeviceMs: number,
  endDeviceMs: number,
  policy: ClockMappingPolicy,
): ClockMappingResult {
  const parsedTranscript = TimedTranscriptSchema.safeParse(untrustedTranscript);
  if (!parsedTranscript.success) return ambiguous("CLOCK_VALUE_INVALID");
  const transcript = parsedTranscript.data;
  const clock = transcript.clock;
  const authority = policy.authority;
  const maxClockUncertaintyMs = policy.maxClockUncertaintyMs ?? 50;
  if (
    ![
      startDeviceMs,
      endDeviceMs,
      maxClockUncertaintyMs,
      authority.anchorDeviceMs,
      authority.anchorSessionMs,
      authority.maxClockOffsetMs,
    ].every(Number.isFinite) ||
    maxClockUncertaintyMs < 0 ||
    authority.maxClockOffsetMs < 0
  ) {
    return ambiguous("CLOCK_VALUE_INVALID");
  }
  if (
    clock.presentationSessionId !== authority.presentationSessionId ||
    clock.presentationSessionEpoch !== authority.presentationSessionEpoch ||
    clock.mappingVersion !== authority.mappingVersion ||
    clock.deviceId !== authority.deviceId ||
    clock.anchorDeviceMs !== authority.anchorDeviceMs ||
    clock.anchorSessionMs !== authority.anchorSessionMs
  ) {
    return ambiguous("CLOCK_REFERENCE_UNAUTHORIZED");
  }
  const offsetMs = authority.anchorSessionMs - authority.anchorDeviceMs;
  if (Math.abs(offsetMs) > authority.maxClockOffsetMs) {
    return ambiguous("CLOCK_OFFSET_EXCEEDED");
  }
  if (
    startDeviceMs < clock.validFromDeviceMs ||
    endDeviceMs > clock.validUntilDeviceMs ||
    endDeviceMs < startDeviceMs
  ) {
    return ambiguous("CLOCK_REFERENCE_OUT_OF_RANGE");
  }
  if (clock.uncertaintyMs > maxClockUncertaintyMs) {
    return ambiguous("CLOCK_UNCERTAINTY_EXCEEDED");
  }
  const startSessionMs = startDeviceMs + offsetMs - clock.uncertaintyMs;
  const endSessionMs = endDeviceMs + offsetMs + clock.uncertaintyMs;
  if (!Number.isFinite(startSessionMs) || !Number.isFinite(endSessionMs) || startSessionMs < 0) {
    return ambiguous("CLOCK_VALUE_INVALID");
  }
  return {
    outcome: "MAPPED",
    mappingVersion: clock.mappingVersion,
    startSessionMs,
    endSessionMs,
    uncertaintyMs: clock.uncertaintyMs,
  };
}

export function fuseTranscriptToSlide(
  untrustedTranscript: TimedTranscript,
  untrustedWindows: readonly unknown[],
  options: Readonly<{
    clockAuthority?: ClockMappingAuthority;
    maxClockUncertaintyMs?: number;
  }> = {},
): TranscriptFusionResult {
  const parsedTranscript = TimedTranscriptSchema.safeParse(untrustedTranscript);
  if (!parsedTranscript.success) return ambiguous("TRANSCRIPT_INVALID");
  const transcript = parsedTranscript.data;
  if (options.clockAuthority === undefined) {
    return ambiguous("CLOCK_REFERENCE_UNAUTHORIZED");
  }
  const parsedWindows = untrustedWindows.map((window) =>
    SlideOccurrenceWindowSchema.safeParse(window),
  );
  if (parsedWindows.some((window) => !window.success)) {
    return ambiguous("SLIDE_WINDOW_INVALID");
  }
  const windows = parsedWindows.flatMap((window) => (window.success ? [window.data] : []));
  if (transcript.text.trim().length === 0 || transcript.words.length === 0) {
    return ambiguous("MEASUREMENT_UNAVAILABLE");
  }
  if (
    transcript.words.some(
      (word) =>
        word.startDeviceMs < transcript.audioStartDeviceMs ||
        word.endDeviceMs > transcript.audioEndDeviceMs,
    )
  ) {
    return ambiguous("WORD_OUTSIDE_AUDIO_INTERVAL");
  }
  const mapped = mapDeviceIntervalToSession(
    transcript,
    transcript.audioStartDeviceMs,
    transcript.audioEndDeviceMs,
    {
      authority: options.clockAuthority,
      ...(options.maxClockUncertaintyMs === undefined
        ? {}
        : { maxClockUncertaintyMs: options.maxClockUncertaintyMs }),
    },
  );
  if (mapped.outcome === "AMBIGUOUS") return mapped;

  const covering = windows.filter(
    (window) =>
      window.startSessionMs <= mapped.startSessionMs && window.endSessionMs >= mapped.endSessionMs,
  );
  if (covering.length !== 1) return ambiguous("SLIDE_BOUNDARY_CROSSED");
  const window = covering[0];
  if (window === undefined) return ambiguous("SLIDE_BOUNDARY_CROSSED");
  const offsetMs = options.clockAuthority.anchorSessionMs - options.clockAuthority.anchorDeviceMs;
  const attributed = AttributedFusionSchema.safeParse({
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
  });
  return attributed.success ? attributed.data : ambiguous("CLOCK_VALUE_INVALID");
}

function ambiguous<Reason extends FusionFailureReason>(reason: Reason) {
  return { outcome: "AMBIGUOUS" as const, reason };
}
