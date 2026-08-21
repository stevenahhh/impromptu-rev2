import {
  type SttStreamEvent as ContractSttStreamEvent,
  createSttStreamEventValidator,
  STT_AUDIO_MIME_TYPE,
  STT_STREAM_EVENT_KINDS,
  STT_STREAM_PROTOCOL_ERROR_CODES,
  SttStreamEventSchema,
  SttStreamProtocolError,
  type SttStreamProtocolErrorCode,
  type SttStreamTranscript,
  type SttWordTimestamp,
} from "@impromptu/contracts/private";
import { z } from "zod";
import type { ModelInvocationContext, Schema, UnaryModelAdapter } from "./ports.ts";

export {
  STT_AUDIO_MIME_TYPE,
  STT_STREAM_EVENT_KINDS,
  STT_STREAM_PROTOCOL_ERROR_CODES,
  SttStreamProtocolError,
  createSttStreamEventValidator,
};
export type { SttStreamProtocolErrorCode, SttStreamTranscript, SttWordTimestamp };

export const audioEncodingSchema = z.literal(STT_AUDIO_MIME_TYPE);
export type AudioEncoding = z.infer<typeof audioEncodingSchema>;

export const sttTranscriptSchema = z
  .object({
    text: z.string(),
    language: z.string().min(2),
    durationMs: z.number().finite().nonnegative(),
  })
  .strict();
export type SttTranscript = z.infer<typeof sttTranscriptSchema>;

export const sttTranscriptionInputSchema = z
  .object({
    audio: z.instanceof(Uint8Array),
    encoding: audioEncodingSchema,
    sampleRateHz: z.number().int().positive(),
  })
  .strict();
export type SttTranscriptionInput = z.infer<typeof sttTranscriptionInputSchema>;

export const sttAudioChunkSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    audio: z.instanceof(Uint8Array),
  })
  .strict();
export type SttAudioChunk = z.infer<typeof sttAudioChunkSchema>;

export const sttStreamEventSchema = SttStreamEventSchema;
export type SttStreamEvent = ContractSttStreamEvent;

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
