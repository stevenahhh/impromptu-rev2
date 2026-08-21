import { z } from "zod";
import { PublicSlideOccurrenceSchema, TimestampMsSchema, VersionIdSchema } from "./common.ts";
import { ActorIdSchema } from "./control-identifiers.ts";
import {
  CaptureDeviceIdSchema,
  ConsentRecordIdSchema,
  TranscriptFinalIdSchema,
} from "./private-identifiers.ts";
import {
  PresentationSessionEpochSchema,
  PresentationSessionIdSchema,
} from "./session-identifiers.ts";

export const AudioConsentNoticeSchema = z
  .object({
    purpose: z.string().min(1),
    vendors: z.array(z.string().min(1)).min(1),
    region: z.string().min(1),
    retention: z.string().min(1),
    deletion: z.string().min(1),
  })
  .strict();

export const AudioCaptureConsentSchema = z
  .object({
    consentRecordId: ConsentRecordIdSchema,
    presentationSessionId: PresentationSessionIdSchema,
    presentationSessionEpoch: PresentationSessionEpochSchema,
    actorId: ActorIdSchema,
    captureDeviceId: CaptureDeviceIdSchema,
    notice: AudioConsentNoticeSchema,
    explicitlyAccepted: z.literal(true),
    acceptedAtMs: TimestampMsSchema,
  })
  .strict();

export const DeviceClockReferenceSchema = z
  .object({
    mappingVersion: VersionIdSchema,
    presentationSessionId: PresentationSessionIdSchema,
    presentationSessionEpoch: PresentationSessionEpochSchema,
    deviceId: CaptureDeviceIdSchema,
    anchorDeviceMs: TimestampMsSchema,
    anchorSessionMs: TimestampMsSchema,
    uncertaintyMs: z.number().finite().nonnegative(),
    validFromDeviceMs: TimestampMsSchema,
    validUntilDeviceMs: TimestampMsSchema,
  })
  .strict()
  .refine((clock) => clock.validFromDeviceMs <= clock.anchorDeviceMs, {
    message: "clock anchor must not precede its validity range",
  })
  .refine((clock) => clock.anchorDeviceMs <= clock.validUntilDeviceMs, {
    message: "clock anchor must not exceed its validity range",
  });

export const TranscriptWordSchema = z
  .object({
    text: z.string().min(1),
    startDeviceMs: TimestampMsSchema,
    endDeviceMs: TimestampMsSchema,
  })
  .strict()
  .refine((word) => word.endDeviceMs >= word.startDeviceMs, {
    message: "word end must not precede word start",
  });

export const STT_AUDIO_MIME_TYPE = "audio/webm;codecs=opus" as const;
export const STT_STREAM_EVENT_KINDS = ["PARTIAL", "REPLACE", "FINAL", "ABORT"] as const;

export const SttWordTimestampSchema = z
  .object({
    text: z.string().min(1),
    startMs: TimestampMsSchema,
    endMs: TimestampMsSchema,
  })
  .strict()
  .refine((word) => word.endMs >= word.startMs, {
    message: "word end must not precede word start",
  });

export const SttStreamTranscriptSchema = z
  .object({
    text: z.string(),
    language: z.string().min(2),
    durationMs: TimestampMsSchema,
    words: z.array(SttWordTimestampSchema),
  })
  .strict()
  .superRefine((transcript, context) => {
    let previousEndMs = 0;
    for (const [index, word] of transcript.words.entries()) {
      if (word.startMs < previousEndMs) {
        context.addIssue({
          code: "custom",
          message: "word timestamps must be monotonic",
          path: ["words", index, "startMs"],
        });
      }
      if (word.endMs > transcript.durationMs) {
        context.addIssue({
          code: "custom",
          message: "word end must not exceed transcript duration",
          path: ["words", index, "endMs"],
        });
      }
      previousEndMs = word.endMs;
    }
  });

const SttSessionGenerationSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const SttSequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const SttSegmentIdSchema = z.string().min(1).max(200);
const SttEventBaseShape = {
  sessionGeneration: SttSessionGenerationSchema,
  sequence: SttSequenceSchema,
  segmentId: SttSegmentIdSchema,
} as const;

export const SttPartialStreamEventSchema = z
  .object({
    ...SttEventBaseShape,
    kind: z.literal(STT_STREAM_EVENT_KINDS[0]),
    transcript: SttStreamTranscriptSchema,
  })
  .strict();

export const SttReplaceStreamEventSchema = z
  .object({
    ...SttEventBaseShape,
    kind: z.literal(STT_STREAM_EVENT_KINDS[1]),
    replacesSequence: SttSequenceSchema,
    transcript: SttStreamTranscriptSchema,
  })
  .strict();

export const SttFinalStreamEventSchema = z
  .object({
    ...SttEventBaseShape,
    kind: z.literal(STT_STREAM_EVENT_KINDS[2]),
    finalSegmentId: SttSegmentIdSchema,
    transcript: SttStreamTranscriptSchema,
  })
  .strict();

export const SttAbortStreamEventSchema = z
  .object({
    ...SttEventBaseShape,
    kind: z.literal(STT_STREAM_EVENT_KINDS[3]),
  })
  .strict();

export const SttStreamEventSchema = z.discriminatedUnion("kind", [
  SttPartialStreamEventSchema,
  SttReplaceStreamEventSchema,
  SttFinalStreamEventSchema,
  SttAbortStreamEventSchema,
]);

export const STT_STREAM_PROTOCOL_ERROR_CODES = [
  "NON_MONOTONIC_SEQUENCE",
  "INVALID_REPLACE_TARGET",
  "DUPLICATE_FINAL",
  "DUPLICATE_FINAL_SEGMENT_ID",
  "POST_FINAL_EVENT",
  "POST_ABORT_EVENT",
] as const;

export type SttStreamProtocolErrorCode = (typeof STT_STREAM_PROTOCOL_ERROR_CODES)[number];

export class SttStreamProtocolError extends Error {
  readonly code: SttStreamProtocolErrorCode;

  constructor(code: SttStreamProtocolErrorCode) {
    super(code);
    this.name = "SttStreamProtocolError";
    this.code = code;
  }
}

interface SttGenerationState {
  lastSequence: number;
  aborted: boolean;
  readonly sequenceSegments: Map<number, string>;
  readonly finalizedSegments: Set<string>;
}

export function createSttStreamEventValidator(): (value: unknown) => SttStreamEvent {
  const generations = new Map<number, SttGenerationState>();
  const finalSegmentIds = new Set<string>();

  return (value: unknown): SttStreamEvent => {
    const event = SttStreamEventSchema.parse(value);
    const state = generations.get(event.sessionGeneration) ?? {
      lastSequence: -1,
      aborted: false,
      sequenceSegments: new Map<number, string>(),
      finalizedSegments: new Set<string>(),
    };

    if (state.aborted) throw new SttStreamProtocolError("POST_ABORT_EVENT");
    if (event.sequence <= state.lastSequence) {
      throw new SttStreamProtocolError("NON_MONOTONIC_SEQUENCE");
    }
    if (state.finalizedSegments.has(event.segmentId)) {
      throw new SttStreamProtocolError(
        event.kind === "FINAL" ? "DUPLICATE_FINAL" : "POST_FINAL_EVENT",
      );
    }
    if (
      event.kind === "REPLACE" &&
      state.sequenceSegments.get(event.replacesSequence) !== event.segmentId
    ) {
      throw new SttStreamProtocolError("INVALID_REPLACE_TARGET");
    }
    if (event.kind === "FINAL" && finalSegmentIds.has(event.finalSegmentId)) {
      throw new SttStreamProtocolError("DUPLICATE_FINAL_SEGMENT_ID");
    }

    state.lastSequence = event.sequence;
    state.sequenceSegments.set(event.sequence, event.segmentId);
    if (event.kind === "FINAL") {
      state.finalizedSegments.add(event.segmentId);
      finalSegmentIds.add(event.finalSegmentId);
    }
    if (event.kind === "ABORT") state.aborted = true;
    generations.set(event.sessionGeneration, state);
    return event;
  };
}

export const TimedTranscriptSchema = z
  .object({
    transcriptFinalId: TranscriptFinalIdSchema,
    language: z.string().min(2),
    text: z.string(),
    audioStartDeviceMs: TimestampMsSchema,
    audioEndDeviceMs: TimestampMsSchema,
    clock: DeviceClockReferenceSchema,
    words: z.array(TranscriptWordSchema),
  })
  .strict()
  .refine((transcript) => transcript.audioEndDeviceMs >= transcript.audioStartDeviceMs, {
    message: "audio end must not precede audio start",
  });

export const SlideOccurrenceWindowSchema = z
  .object({
    occurrence: PublicSlideOccurrenceSchema,
    startSessionMs: TimestampMsSchema,
    endSessionMs: TimestampMsSchema,
  })
  .strict()
  .refine((window) => window.endSessionMs > window.startSessionMs, {
    message: "slide occurrence window must have positive duration",
  });

export type AudioConsentNotice = z.infer<typeof AudioConsentNoticeSchema>;
export type AudioCaptureConsent = z.infer<typeof AudioCaptureConsentSchema>;
export type DeviceClockReference = z.infer<typeof DeviceClockReferenceSchema>;
export type TranscriptWord = z.infer<typeof TranscriptWordSchema>;
export type SttWordTimestamp = z.infer<typeof SttWordTimestampSchema>;
export type SttStreamTranscript = z.infer<typeof SttStreamTranscriptSchema>;
export type SttPartialStreamEvent = z.infer<typeof SttPartialStreamEventSchema>;
export type SttReplaceStreamEvent = z.infer<typeof SttReplaceStreamEventSchema>;
export type SttFinalStreamEvent = z.infer<typeof SttFinalStreamEventSchema>;
export type SttAbortStreamEvent = z.infer<typeof SttAbortStreamEventSchema>;
export type SttStreamEvent = z.infer<typeof SttStreamEventSchema>;
export type TimedTranscript = z.infer<typeof TimedTranscriptSchema>;
export type SlideOccurrenceWindow = z.infer<typeof SlideOccurrenceWindowSchema>;
