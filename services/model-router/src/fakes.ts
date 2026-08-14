import { brandStreamingFake, brandUnaryFake } from "./fake-provenance.ts";
import type {
  AdapterRequirement,
  ModelAdapterDescriptor,
  ModelInvocationContext,
  ProviderTransport,
  ProviderTransportRequest,
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

export type ScriptedUnaryStep<Output> =
  | { readonly kind: "output"; readonly output: Output }
  | { readonly kind: "pending" }
  | {
      readonly kind: "transport";
      readonly requests: readonly ProviderTransportRequest[];
      readonly output: Output;
    };

export interface ScriptedUnaryAdapterOptions<Input, Output> {
  readonly descriptor: ModelAdapterDescriptor;
  readonly inputSchema: Schema<Input>;
  readonly outputSchema: Schema<Output>;
  readonly steps: readonly ScriptedUnaryStep<Output>[];
}

export interface ScriptedUnaryAdapter<Input, Output> extends UnaryModelAdapter<Input, Output> {
  readonly invocationCount: number;
  readonly retainedTransports: readonly (ProviderTransport | undefined)[];
  waitForInvocation(count?: number): Promise<void>;
}

export function createScriptedUnaryAdapter<Input, Output>(
  options: ScriptedUnaryAdapterOptions<Input, Output>,
): ScriptedUnaryAdapter<Input, Output> {
  if (options.steps.length === 0) throw new TypeError("Scripted fake requires at least one step");
  const descriptor = cloneAndFreeze(options.descriptor);
  const steps = cloneAndFreeze(options.steps);
  const retainedTransports: Array<ProviderTransport | undefined> = [];
  const waiters = new Map<number, Array<() => void>>();
  let invocationCount = 0;

  const invoke = async (_input: Input, context: ModelInvocationContext): Promise<Output> => {
    invocationCount += 1;
    retainedTransports.push(context.transport);
    for (const resolve of waiters.get(invocationCount) ?? []) resolve();
    waiters.delete(invocationCount);
    const step = steps[Math.min(invocationCount - 1, steps.length - 1)];
    if (step === undefined || step.kind === "pending") {
      return await new Promise<Output>(() => undefined);
    }
    if (step.kind === "transport") {
      if (context.transport === undefined) throw new Error("Scripted transport is unavailable");
      for (const request of step.requests) await context.transport.request(request);
    }
    return cloneAndFreeze(step.output);
  };

  const adapter: ScriptedUnaryAdapter<Input, Output> = {
    descriptor,
    inputSchema: options.inputSchema,
    outputSchema: options.outputSchema,
    invoke,
    get invocationCount() {
      return invocationCount;
    },
    get retainedTransports() {
      return Object.freeze([...retainedTransports]);
    },
    async waitForInvocation(count = 1) {
      if (invocationCount >= count) return;
      await new Promise<void>((resolve) => {
        const waiting = waiters.get(count) ?? [];
        waiting.push(resolve);
        waiters.set(count, waiting);
      });
    },
  };
  Object.freeze(adapter);
  brandUnaryFake(adapter, {
    descriptor,
    inputSchema: options.inputSchema as Schema<unknown>,
    outputSchema: options.outputSchema as Schema<unknown>,
    invoke: async (input, context) => await invoke(input as Input, context),
  });
  return adapter;
}

export interface ScriptedSttAdapterOptions {
  readonly transcript: SttTranscript;
  readonly events: readonly unknown[];
  readonly adapterId?: string;
  readonly requirement?: AdapterRequirement;
  readonly acceptUnvalidatedEvents?: boolean;
  readonly pendingAfterEvents?: boolean;
  readonly onEvent?: (event: Readonly<SttStreamEvent>) => void;
}

export interface ScriptedSttAdapter extends UnarySttAdapter, StreamingSttAdapter {
  readonly streamReturnCount: number;
  readonly signalAbortedAtReturn: boolean;
}

export function createScriptedSttAdapter(options: ScriptedSttAdapterOptions): ScriptedSttAdapter {
  const descriptor: UnarySttAdapter["descriptor"] = cloneAndFreeze({
    adapterId: options.adapterId ?? "deterministic-fake-stt",
    capability: "stt",
    provider: "fake",
    model: "scripted-stt",
    modelVersion: "1",
    estimatedCostUnits: 1,
    ...(options.requirement === undefined ? {} : { requirement: options.requirement }),
  });
  const transcript = cloneAndFreeze(sttTranscriptSchema.parse(options.transcript));
  const eventSchema = options.acceptUnvalidatedEvents
    ? { parse: (value: unknown) => value as SttStreamEvent }
    : sttStreamEventSchema;
  const events = cloneAndFreeze(options.events.map((event) => eventSchema.parse(event)));
  let streamReturnCount = 0;
  let signalAbortedAtReturn = false;

  const invoke = async (
    _input: SttTranscriptionInput,
    context: ModelInvocationContext,
  ): Promise<SttTranscript> => {
    throwIfAborted(context.signal);
    return cloneAndFreeze(transcript);
  };
  const transcribe = async function* (
    chunks: AsyncIterable<SttAudioChunk>,
    context: ModelInvocationContext,
  ): AsyncIterable<SttStreamEvent> {
    try {
      for await (const _chunk of chunks) throwIfAborted(context.signal);
      for (const event of events) {
        throwIfAborted(context.signal);
        options.onEvent?.(event);
        yield cloneAndFreeze(event);
      }
      if (options.pendingAfterEvents === true) {
        if (!context.signal.aborted) {
          await new Promise<void>((resolve) => {
            context.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        throwIfAborted(context.signal);
      }
    } finally {
      streamReturnCount += 1;
      signalAbortedAtReturn = context.signal.aborted;
    }
  };

  const adapter: ScriptedSttAdapter = {
    descriptor,
    inputSchema: sttTranscriptionInputSchema,
    outputSchema: sttTranscriptSchema,
    chunkSchema: sttAudioChunkSchema,
    eventSchema,
    invoke,
    transcribe,
    get streamReturnCount() {
      return streamReturnCount;
    },
    get signalAbortedAtReturn() {
      return signalAbortedAtReturn;
    },
  };
  Object.freeze(adapter);
  brandUnaryFake(adapter, {
    descriptor,
    inputSchema: sttTranscriptionInputSchema,
    outputSchema: sttTranscriptSchema,
    invoke: async (input, context) => await invoke(input as SttTranscriptionInput, context),
  });
  brandStreamingFake(adapter, {
    descriptor,
    chunkSchema: sttAudioChunkSchema,
    eventSchema,
    transcribe,
  });
  return adapter;
}

function cloneAndFreeze<Value>(value: Value): Value {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || ArrayBuffer.isView(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Model invocation cancelled");
  }
}
