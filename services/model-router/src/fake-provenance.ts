import type { ModelAdapterDescriptor, ModelInvocationContext, Schema } from "./ports.ts";
import type { SttAudioChunk, SttStreamEvent } from "./stt.ts";

export interface ProvenUnaryFake {
  readonly descriptor: ModelAdapterDescriptor;
  readonly inputSchema: Schema<unknown>;
  readonly outputSchema: Schema<unknown>;
  invoke(input: unknown, context: ModelInvocationContext): Promise<unknown>;
}

export interface ProvenStreamingFake {
  readonly descriptor: ModelAdapterDescriptor & { readonly capability: "stt" };
  readonly chunkSchema: Schema<SttAudioChunk>;
  readonly eventSchema: Schema<SttStreamEvent>;
  transcribe(
    chunks: AsyncIterable<SttAudioChunk>,
    context: ModelInvocationContext,
  ): AsyncIterable<SttStreamEvent>;
}

const unaryProvenance = new WeakMap<object, ProvenUnaryFake>();
const streamingProvenance = new WeakMap<object, ProvenStreamingFake>();

export function brandUnaryFake(target: object, record: ProvenUnaryFake): void {
  unaryProvenance.set(target, Object.freeze(record));
}

export function brandStreamingFake(target: object, record: ProvenStreamingFake): void {
  streamingProvenance.set(target, Object.freeze(record));
}

export function getUnaryFake(value: unknown): ProvenUnaryFake | undefined {
  return typeof value === "object" && value !== null ? unaryProvenance.get(value) : undefined;
}

export function getStreamingFake(value: unknown): ProvenStreamingFake | undefined {
  return typeof value === "object" && value !== null ? streamingProvenance.get(value) : undefined;
}
