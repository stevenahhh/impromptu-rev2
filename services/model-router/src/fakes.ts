import type {
  ModelAdapterDescriptor,
  ModelInvocationContext,
  Schema,
  UnaryModelAdapter,
} from "./ports.ts";
import {
  type StreamingSttAdapter,
  type SttAudioChunk,
  type SttStreamEvent,
  type SttTranscript,
  type SttTranscriptionInput,
  sttAudioChunkSchema,
  sttStreamEventSchema,
  sttTranscriptionInputSchema,
  sttTranscriptSchema,
  type UnarySttAdapter,
} from "./stt.ts";

export interface DeterministicFakeUnaryAdapterOptions<Input, Output> {
  readonly descriptor: ModelAdapterDescriptor;
  readonly inputSchema: Schema<Input>;
  readonly outputSchema: Schema<Output>;
  readonly respond: (input: Input, context: ModelInvocationContext) => Output | Promise<Output>;
}

export class DeterministicFakeUnaryAdapter<Input, Output>
  implements UnaryModelAdapter<Input, Output>
{
  readonly descriptor: ModelAdapterDescriptor;
  readonly inputSchema: Schema<Input>;
  readonly outputSchema: Schema<Output>;
  readonly #respond: DeterministicFakeUnaryAdapterOptions<Input, Output>["respond"];
  #invocationCount = 0;

  constructor(options: DeterministicFakeUnaryAdapterOptions<Input, Output>) {
    this.descriptor = options.descriptor;
    this.inputSchema = options.inputSchema;
    this.outputSchema = options.outputSchema;
    this.#respond = options.respond;
  }

  get invocationCount(): number {
    return this.#invocationCount;
  }

  async invoke(input: Input, context: ModelInvocationContext): Promise<Output> {
    this.#invocationCount += 1;
    return await this.#respond(input, context);
  }
}

export interface DeterministicFakeSttAdapterOptions {
  readonly transcript: SttTranscript;
  readonly events: readonly SttStreamEvent[];
  readonly adapterId?: string;
}

export class DeterministicFakeSttAdapter implements UnarySttAdapter, StreamingSttAdapter {
  readonly descriptor: UnarySttAdapter["descriptor"];
  readonly inputSchema = sttTranscriptionInputSchema;
  readonly outputSchema = sttTranscriptSchema;
  readonly chunkSchema = sttAudioChunkSchema;
  readonly eventSchema = sttStreamEventSchema;
  readonly #transcript: SttTranscript;
  readonly #events: readonly SttStreamEvent[];

  constructor(options: DeterministicFakeSttAdapterOptions) {
    this.descriptor = {
      adapterId: options.adapterId ?? "deterministic-fake-stt",
      capability: "stt",
      provider: "fake",
      model: "scripted-stt",
      modelVersion: "1",
    };
    this.#transcript = sttTranscriptSchema.parse(options.transcript);
    this.#events = options.events.map((event) => sttStreamEventSchema.parse(event));
  }

  async invoke(
    _input: SttTranscriptionInput,
    context: ModelInvocationContext,
  ): Promise<SttTranscript> {
    throwIfAborted(context.signal);
    return this.#transcript;
  }

  async *transcribe(
    _chunks: AsyncIterable<SttAudioChunk>,
    context: ModelInvocationContext,
  ): AsyncIterable<SttStreamEvent> {
    for (const event of this.#events) {
      throwIfAborted(context.signal);
      yield event;
    }
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Model invocation cancelled");
  }
}
