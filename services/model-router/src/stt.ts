import { z } from "zod";
import type { ModelInvocationContext, Schema, UnaryModelAdapter } from "./ports.ts";

export const audioEncodingSchema = z.enum(["pcm-s16le", "webm-opus", "ogg-opus"]);
export type AudioEncoding = z.infer<typeof audioEncodingSchema>;

export const sttTranscriptSchema = z.object({
  text: z.string(),
  language: z.string().min(2),
  durationMs: z.number().finite().nonnegative(),
});
export type SttTranscript = z.infer<typeof sttTranscriptSchema>;

export const sttTranscriptionInputSchema = z.object({
  audio: z.instanceof(Uint8Array),
  encoding: audioEncodingSchema,
  sampleRateHz: z.number().int().positive(),
});
export type SttTranscriptionInput = z.infer<typeof sttTranscriptionInputSchema>;

export const sttAudioChunkSchema = z.object({
  sequence: z.number().int().nonnegative(),
  audio: z.instanceof(Uint8Array),
});
export type SttAudioChunk = z.infer<typeof sttAudioChunkSchema>;

export const sttStreamEventSchema = z.object({
  kind: z.enum(["partial", "final"]),
  sequence: z.number().int().nonnegative(),
  transcript: sttTranscriptSchema,
});
export type SttStreamEvent = z.infer<typeof sttStreamEventSchema>;

export interface UnarySttAdapter extends UnaryModelAdapter<SttTranscriptionInput, SttTranscript> {
  readonly descriptor: UnaryModelAdapter<SttTranscriptionInput, SttTranscript>["descriptor"] & {
    readonly capability: "stt";
  };
}

export interface StreamingSttAdapter {
  readonly descriptor: UnarySttAdapter["descriptor"];
  readonly chunkSchema: Schema<SttAudioChunk>;
  readonly eventSchema: Schema<SttStreamEvent>;
  transcribe(
    chunks: AsyncIterable<SttAudioChunk>,
    context: ModelInvocationContext,
  ): AsyncIterable<SttStreamEvent>;
}
