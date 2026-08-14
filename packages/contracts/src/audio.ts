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
export type TimedTranscript = z.infer<typeof TimedTranscriptSchema>;
export type SlideOccurrenceWindow = z.infer<typeof SlideOccurrenceWindowSchema>;
