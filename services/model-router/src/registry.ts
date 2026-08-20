import { z } from "zod";
import { getStreamingFake, getUnaryFake } from "./fake-provenance.ts";
import { type IsolatedAdapterModule, isolatedAdapterModuleSchema } from "./isolation.ts";
import {
  type ModelAdapterDescriptor,
  type ModelInvocationContext,
  modelAdapterDescriptorSchema,
  type Schema,
  type UnaryModelAdapter,
} from "./ports.ts";
import { type ModelCapability, type ModelFailure, modelFailureSchema } from "./schemas.ts";
import type { StreamingSttAdapter, SttAudioChunk, SttStreamEvent } from "./stt.ts";

const registrationOptionsSchema = z.object({ default: z.boolean().optional() }).strict();
const frozenRegistrationFailure = deepFreeze(
  modelFailureSchema.parse({
    ok: false,
    error: {
      code: "invalid_request",
      message: "Model adapter registration is invalid",
      retryable: false,
    },
    metadata: {
      capability: null,
      adapterId: null,
      provider: null,
      model: null,
      modelVersion: null,
      policyVersion: "registration",
      requestId: "registration",
      traceId: "registration",
      startedAtMs: 0,
      completedAtMs: 0,
      latencyMs: 0,
      cacheStatus: "bypass",
    },
  }),
);

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
  #streamingStt = new Map<string, RegisteredStreamingSttAdapter>();
  #streamingSttDefault: string | undefined;

  registerDeterministicFakeUnary(
    untrustedAdapter: unknown,
    untrustedOptions: unknown = {},
  ): ModelFailure | undefined {
    try {
      const fake = getUnaryFake(untrustedAdapter);
      if (fake === undefined) return registrationFailure();
      const options = parseRegistrationOptions(untrustedOptions);
      const descriptor = cloneAndFreezeDescriptor(fake.descriptor);
      if (descriptor.provider !== "fake") return registrationFailure();
      const inputSchema = validatedSchema(fake.inputSchema);
      const outputSchema = validatedSchema(fake.outputSchema);
      if (typeof fake.invoke !== "function") return registrationFailure();
      return this.#registerUnary(
        Object.freeze({
          kind: "deterministic-test" as const,
          descriptor,
          parseInput: (input: unknown) => inputSchema.parse(input),
          parseOutput: (output: unknown) => outputSchema.parse(output),
          invoke: async (input: unknown, context: ModelInvocationContext) =>
            await fake.invoke(inputSchema.parse(input), context),
        }),
        options,
      );
    } catch {
      return registrationFailure();
    }
  }

  registerIsolatedUnary(
    untrustedRegistration: unknown,
    untrustedOptions: unknown = {},
  ): ModelFailure | undefined {
    try {
      const registration = objectRecord(untrustedRegistration);
      const options = parseRegistrationOptions(untrustedOptions);
      const descriptor = cloneAndFreezeDescriptor(registration.descriptor);
      const module = cloneAndFreezeModule(registration.module);
      const inputSchema = validatedSchema(registration.inputSchema);
      const outputSchema = validatedSchema(registration.outputSchema);
      return this.#registerUnary(
        Object.freeze({
          kind: "isolated-process" as const,
          descriptor,
          module,
          parseInput: (input: unknown) => inputSchema.parse(input),
          parseOutput: (output: unknown) => outputSchema.parse(output),
        }),
        options,
      );
    } catch {
      return registrationFailure();
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

  registerDeterministicFakeStreamingStt(
    untrustedAdapter: unknown,
    untrustedOptions: unknown = {},
  ): ModelFailure | undefined {
    try {
      const fake = getStreamingFake(untrustedAdapter);
      if (fake === undefined) return registrationFailure();
      const options = parseRegistrationOptions(untrustedOptions);
      const descriptor = sttDescriptor(fake.descriptor);
      if (descriptor.provider !== "fake") return registrationFailure();
      const chunkSchema = validatedSchema<SttAudioChunk>(fake.chunkSchema);
      const eventSchema = validatedSchema<SttStreamEvent>(fake.eventSchema);
      if (typeof fake.transcribe !== "function") return registrationFailure();
      return this.#registerStreamingStt(
        Object.freeze({
          kind: "deterministic-test" as const,
          descriptor,
          chunkSchema,
          eventSchema,
          transcribe: (chunks: AsyncIterable<SttAudioChunk>, context: ModelInvocationContext) =>
            fake.transcribe(chunks, context),
        }),
        options,
      );
    } catch {
      return registrationFailure();
    }
  }

  registerIsolatedStreamingStt(
    untrustedRegistration: unknown,
    untrustedOptions: unknown = {},
  ): ModelFailure | undefined {
    try {
      const registration = objectRecord(untrustedRegistration);
      const options = parseRegistrationOptions(untrustedOptions);
      const descriptor = sttDescriptor(registration.descriptor);
      const module = cloneAndFreezeModule(registration.module);
      const chunkSchema = validatedSchema<SttAudioChunk>(registration.chunkSchema);
      const eventSchema = validatedSchema<SttStreamEvent>(registration.eventSchema);
      return this.#registerStreamingStt(
        Object.freeze({
          kind: "isolated-process" as const,
          descriptor,
          module,
          chunkSchema,
          eventSchema,
        }),
        options,
      );
    } catch {
      return registrationFailure();
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

  #registerUnary(
    adapter: RegisteredUnaryAdapter,
    options: RegistrationOptions,
  ): ModelFailure | undefined {
    const { adapterId, capability } = adapter.descriptor;
    const current = this.#unary.get(capability) ?? new Map<string, RegisteredUnaryAdapter>();
    if (current.has(adapterId)) return registrationFailure();
    const next = new Map(current);
    next.set(adapterId, adapter);
    const shouldDefault = options.default === true || !this.#unaryDefaults.has(capability);
    this.#unary.set(capability, next);
    if (shouldDefault) this.#unaryDefaults.set(capability, adapterId);
    return undefined;
  }

  #registerStreamingStt(
    adapter: RegisteredStreamingSttAdapter,
    options: RegistrationOptions,
  ): ModelFailure | undefined {
    const { adapterId } = adapter.descriptor;
    if (this.#streamingStt.has(adapterId)) return registrationFailure();
    const next = new Map(this.#streamingStt);
    next.set(adapterId, adapter);
    const shouldDefault = options.default === true || this.#streamingSttDefault === undefined;
    this.#streamingStt = next;
    if (shouldDefault) this.#streamingSttDefault = adapterId;
    return undefined;
  }
}

function registrationFailure(): ModelFailure {
  return frozenRegistrationFailure;
}

function sttDescriptor(value: unknown): StreamingSttAdapter["descriptor"] {
  const descriptor = cloneAndFreezeDescriptor(value);
  if (descriptor.capability !== "stt") throw new TypeError("Invalid STT capability");
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
  Object.freeze(module.configuration);
  return Object.freeze(module);
}

function parseRegistrationOptions(value: unknown): RegistrationOptions {
  const parsed = registrationOptionsSchema.parse(value);
  return parsed.default === undefined ? {} : { default: parsed.default };
}

function validatedSchema<Value = unknown>(value: unknown): Schema<Value> {
  const record = objectRecord(value);
  const parse = record.parse;
  if (typeof parse !== "function") throw new TypeError("Schema parse must be a function");
  return Object.freeze({
    parse: (input: unknown) => Reflect.apply(parse, value, [input]) as Value,
  });
}

function objectRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected object");
  }
  return value as Readonly<Record<string, unknown>>;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
