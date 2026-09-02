import { z } from "zod";
import { TimestampMsSchema } from "./common.ts";

/**
 * Wire contract for transcribing ONE bounded spoken-question clip recorded on the Q&A
 * defense surface. The browser uploads a single WebM/Opus blob; the private backend runs
 * its pinned local STT adapter and answers with either a transcript or an uppercase
 * rejection reason. Keep the outcome union byte-stable across releases.
 */

export const QUESTION_CLIP_MIME_TYPE = "audio/webm;codecs=opus" as const;
/** One audience question is short; 1 MiB of Opus comfortably exceeds any honest clip. */
export const MAX_QUESTION_CLIP_BYTES = 1_048_576 as const;
export const MAX_QUESTION_CLIP_DURATION_MS = 120_000 as const;

/**
 * Rejection reasons are part of the contract: each maps to specific Console copy so a
 * failed transcription is never silently swallowed nor fabricated around.
 */
export const SpokenQuestionTranscriptionRejectionSchema = z.enum([
  "EMPTY_AUDIO",
  "TOO_LARGE",
  "TOO_LONG",
  "UNSUPPORTED_CODEC",
  "STT_UNAVAILABLE",
  "TRANSCRIPTION_FAILED",
]);
export type SpokenQuestionTranscriptionRejection = z.infer<
  typeof SpokenQuestionTranscriptionRejectionSchema
>;

export const SpokenQuestionTranscriptionOutcomeSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("TRANSCRIBED"),
      text: z.string().trim().min(1).max(2_000),
      language: z.string().min(2),
      durationMs: TimestampMsSchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("REJECTED"),
      reason: SpokenQuestionTranscriptionRejectionSchema,
    })
    .strict(),
]);
export type SpokenQuestionTranscriptionOutcome = z.infer<
  typeof SpokenQuestionTranscriptionOutcomeSchema
>;
