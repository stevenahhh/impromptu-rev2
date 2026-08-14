import {
  type ModelInvocationContext,
  modelAdapterDescriptorSchema,
  type Schema,
  type UnaryModelAdapter,
} from "./ports.ts";
import type { ModelCapability } from "./schemas.ts";
import type { StreamingSttAdapter, SttAudioChunk, SttStreamEvent } from "./stt.ts";

export interface RegisteredUnaryAdapter {
  readonly descriptor: UnaryModelAdapter<unknown, unknown>["descriptor"];
  parseInput(input: unknown): unknown;
  parseOutput(output: unknown): unknown;
  invoke(input: unknown, context: ModelInvocationContext): Promise<unknown>;
}

export interface RegisteredStreamingSttAdapter {
  readonly descriptor: StreamingSttAdapter["descriptor"];
  readonly chunkSchema: Schema<SttAudioChunk>;
  readonly eventSchema: Schema<SttStreamEvent>;
  transcribe(
    chunks: AsyncIterable<SttAudioChunk>,
    context: ModelInvocationContext,
  ): AsyncIterable<SttStreamEvent>;
}

export interface RegistrationOptions {
  readonly default?: boolean;
}

export class ModelRoutingRegistry {
  readonly #unary = new Map<ModelCapability, Map<string, RegisteredUnaryAdapter>>();
  readonly #unaryDefaults = new Map<ModelCapability, string>();
  readonly #streamingStt = new Map<string, RegisteredStreamingSttAdapter>();
  #streamingSttDefault: string | undefined;

  registerUnary<Input, Output>(
    adapter: UnaryModelAdapter<Input, Output>,
    options: RegistrationOptions = {},
  ): void {
    const descriptor = cloneAndFreezeDescriptor(adapter.descriptor);
    const { adapterId, capability } = descriptor;
    const adapters = this.#unary.get(capability) ?? new Map<string, RegisteredUnaryAdapter>();
    if (adapters.has(adapterId)) {
      throw new Error(`Unary adapter ${adapterId} is already registered for ${capability}`);
    }
    adapters.set(
      adapterId,
      Object.freeze({
        descriptor,
        parseInput: (input: unknown) => adapter.inputSchema.parse(input),
        parseOutput: (output: unknown) => adapter.outputSchema.parse(output),
        invoke: async (input: unknown, context: ModelInvocationContext) =>
          await adapter.invoke(adapter.inputSchema.parse(input), context),
      }),
    );
    this.#unary.set(capability, adapters);
    if (options.default === true || !this.#unaryDefaults.has(capability)) {
      this.#unaryDefaults.set(capability, adapterId);
    }
  }

  resolveUnary(capability: ModelCapability, adapterId?: string): RegisteredUnaryAdapter {
    const resolvedId = adapterId ?? this.#unaryDefaults.get(capability);
    const adapter =
      resolvedId === undefined ? undefined : this.#unary.get(capability)?.get(resolvedId);
    if (adapter === undefined) {
      throw new Error(
        adapterId === undefined
          ? `No unary adapter is registered for ${capability}`
          : `No unary adapter ${adapterId} is registered for ${capability}`,
      );
    }
    return adapter;
  }

  registerStreamingStt(adapter: StreamingSttAdapter, options: RegistrationOptions = {}): void {
    const descriptor = cloneAndFreezeDescriptor(adapter.descriptor);
    if (descriptor.capability !== "stt") {
      throw new TypeError("Streaming STT adapters must declare the stt capability");
    }
    const { adapterId } = descriptor;
    if (this.#streamingStt.has(adapterId)) {
      throw new Error(`Streaming STT adapter ${adapterId} is already registered`);
    }
    this.#streamingStt.set(
      adapterId,
      Object.freeze({
        descriptor: Object.freeze({ ...descriptor, capability: "stt" as const }),
        chunkSchema: adapter.chunkSchema,
        eventSchema: adapter.eventSchema,
        transcribe: (chunks: AsyncIterable<SttAudioChunk>, context: ModelInvocationContext) =>
          adapter.transcribe(chunks, context),
      }),
    );
    if (options.default === true || this.#streamingSttDefault === undefined) {
      this.#streamingSttDefault = adapterId;
    }
  }

  resolveStreamingStt(adapterId?: string): RegisteredStreamingSttAdapter {
    const resolvedId = adapterId ?? this.#streamingSttDefault;
    const adapter = resolvedId === undefined ? undefined : this.#streamingStt.get(resolvedId);
    if (adapter === undefined) {
      throw new Error(
        adapterId === undefined
          ? "No streaming STT adapter is registered"
          : `No streaming STT adapter ${adapterId} is registered`,
      );
    }
    return adapter;
  }
}

function cloneAndFreezeDescriptor(value: unknown) {
  const descriptor = modelAdapterDescriptorSchema.parse(structuredClone(value));
  if (descriptor.requirement !== undefined) Object.freeze(descriptor.requirement);
  return Object.freeze(descriptor);
}
