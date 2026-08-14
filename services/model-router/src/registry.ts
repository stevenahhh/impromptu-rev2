import { type IsolatedAdapterModule, isolatedAdapterModuleSchema } from "./isolation.ts";
import {
  type ModelAdapterDescriptor,
  type ModelInvocationContext,
  modelAdapterDescriptorSchema,
  type Schema,
  type UnaryModelAdapter,
} from "./ports.ts";
import type { ModelCapability } from "./schemas.ts";
import type { StreamingSttAdapter, SttAudioChunk, SttStreamEvent } from "./stt.ts";

interface RegisteredUnaryAdapterBase {
  readonly descriptor: UnaryModelAdapter<unknown, unknown>["descriptor"];
  parseInput(input: unknown): unknown;
  parseOutput(output: unknown): unknown;
}

export interface RegisteredTestUnaryAdapter extends RegisteredUnaryAdapterBase {
  readonly kind: "deterministic-test";
  invoke(input: unknown, context: ModelInvocationContext): Promise<unknown>;
}

export interface RegisteredIsolatedUnaryAdapter extends RegisteredUnaryAdapterBase {
  readonly kind: "isolated-process";
  readonly module: IsolatedAdapterModule;
}

export type RegisteredUnaryAdapter = RegisteredIsolatedUnaryAdapter | RegisteredTestUnaryAdapter;

interface RegisteredStreamingSttAdapterBase {
  readonly descriptor: StreamingSttAdapter["descriptor"];
  readonly chunkSchema: Schema<SttAudioChunk>;
  readonly eventSchema: Schema<SttStreamEvent>;
}

export interface RegisteredTestStreamingSttAdapter extends RegisteredStreamingSttAdapterBase {
  readonly kind: "deterministic-test";
  transcribe(
    chunks: AsyncIterable<SttAudioChunk>,
    context: ModelInvocationContext,
  ): AsyncIterable<SttStreamEvent>;
}

export interface RegisteredIsolatedStreamingSttAdapter extends RegisteredStreamingSttAdapterBase {
  readonly kind: "isolated-process";
  readonly module: IsolatedAdapterModule;
}

export type RegisteredStreamingSttAdapter =
  | RegisteredIsolatedStreamingSttAdapter
  | RegisteredTestStreamingSttAdapter;

export interface IsolatedUnaryAdapterRegistration<Input, Output> {
  readonly descriptor: ModelAdapterDescriptor;
  readonly inputSchema: Schema<Input>;
  readonly outputSchema: Schema<Output>;
  readonly module: IsolatedAdapterModule;
}

export interface IsolatedStreamingSttAdapterRegistration {
  readonly descriptor: StreamingSttAdapter["descriptor"];
  readonly chunkSchema: Schema<SttAudioChunk>;
  readonly eventSchema: Schema<SttStreamEvent>;
  readonly module: IsolatedAdapterModule;
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
    assertDeterministicTestProvider(descriptor);
    this.#registerUnary(
      Object.freeze({
        kind: "deterministic-test" as const,
        descriptor,
        parseInput: (input: unknown) => adapter.inputSchema.parse(input),
        parseOutput: (output: unknown) => adapter.outputSchema.parse(output),
        invoke: async (input: unknown, context: ModelInvocationContext) =>
          await adapter.invoke(adapter.inputSchema.parse(input), context),
      }),
      options,
    );
  }

  registerIsolatedUnary<Input, Output>(
    registration: IsolatedUnaryAdapterRegistration<Input, Output>,
    options: RegistrationOptions = {},
  ): void {
    const descriptor = cloneAndFreezeDescriptor(registration.descriptor);
    this.#registerUnary(
      Object.freeze({
        kind: "isolated-process" as const,
        descriptor,
        module: cloneAndFreezeModule(registration.module),
        parseInput: (input: unknown) => registration.inputSchema.parse(input),
        parseOutput: (output: unknown) => registration.outputSchema.parse(output),
      }),
      options,
    );
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
    const descriptor = sttDescriptor(adapter.descriptor);
    assertDeterministicTestProvider(descriptor);
    this.#registerStreamingStt(
      Object.freeze({
        kind: "deterministic-test" as const,
        descriptor,
        chunkSchema: adapter.chunkSchema,
        eventSchema: adapter.eventSchema,
        transcribe: (chunks: AsyncIterable<SttAudioChunk>, context: ModelInvocationContext) =>
          adapter.transcribe(chunks, context),
      }),
      options,
    );
  }

  registerIsolatedStreamingStt(
    registration: IsolatedStreamingSttAdapterRegistration,
    options: RegistrationOptions = {},
  ): void {
    const descriptor = sttDescriptor(registration.descriptor);
    this.#registerStreamingStt(
      Object.freeze({
        kind: "isolated-process" as const,
        descriptor,
        module: cloneAndFreezeModule(registration.module),
        chunkSchema: registration.chunkSchema,
        eventSchema: registration.eventSchema,
      }),
      options,
    );
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

  #registerUnary(adapter: RegisteredUnaryAdapter, options: RegistrationOptions): void {
    const { adapterId, capability } = adapter.descriptor;
    const adapters = this.#unary.get(capability) ?? new Map<string, RegisteredUnaryAdapter>();
    if (adapters.has(adapterId)) {
      throw new Error(`Unary adapter ${adapterId} is already registered for ${capability}`);
    }
    adapters.set(adapterId, adapter);
    this.#unary.set(capability, adapters);
    if (options.default === true || !this.#unaryDefaults.has(capability)) {
      this.#unaryDefaults.set(capability, adapterId);
    }
  }

  #registerStreamingStt(
    adapter: RegisteredStreamingSttAdapter,
    options: RegistrationOptions,
  ): void {
    const { adapterId } = adapter.descriptor;
    if (this.#streamingStt.has(adapterId)) {
      throw new Error(`Streaming STT adapter ${adapterId} is already registered`);
    }
    this.#streamingStt.set(adapterId, adapter);
    if (options.default === true || this.#streamingSttDefault === undefined) {
      this.#streamingSttDefault = adapterId;
    }
  }
}

function assertDeterministicTestProvider(descriptor: ModelAdapterDescriptor): void {
  if (descriptor.provider !== "fake") {
    throw new TypeError("Production adapters must be registered as isolated process modules");
  }
}

function sttDescriptor(value: unknown): StreamingSttAdapter["descriptor"] {
  const descriptor = cloneAndFreezeDescriptor(value);
  if (descriptor.capability !== "stt") {
    throw new TypeError("Streaming STT adapters must declare the stt capability");
  }
  return Object.freeze({ ...descriptor, capability: "stt" as const });
}

function cloneAndFreezeDescriptor(value: unknown) {
  const descriptor = modelAdapterDescriptorSchema.parse(structuredClone(value));
  if (descriptor.requirement !== undefined) Object.freeze(descriptor.requirement);
  return Object.freeze(descriptor);
}

function cloneAndFreezeModule(value: unknown): IsolatedAdapterModule {
  const module = isolatedAdapterModuleSchema.parse(structuredClone(value));
  Object.freeze(module.allowedReadPaths);
  return Object.freeze(module);
}
