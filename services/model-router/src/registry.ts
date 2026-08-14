import type { UnaryModelAdapter } from "./ports.ts";
import type { ModelCapability } from "./schemas.ts";
import type { StreamingSttAdapter } from "./stt.ts";

export interface RegisteredUnaryAdapter {
  readonly descriptor: UnaryModelAdapter<unknown, unknown>["descriptor"];
  parseInput(input: unknown): unknown;
  parseOutput(output: unknown): unknown;
  invoke(
    input: unknown,
    context: Parameters<UnaryModelAdapter<unknown, unknown>["invoke"]>[1],
  ): Promise<unknown>;
}

export interface RegistrationOptions {
  readonly default?: boolean;
}

export class ModelRoutingRegistry {
  readonly #unary = new Map<ModelCapability, Map<string, RegisteredUnaryAdapter>>();
  readonly #unaryDefaults = new Map<ModelCapability, string>();
  readonly #streamingStt = new Map<string, StreamingSttAdapter>();
  #streamingSttDefault: string | undefined;

  registerUnary<Input, Output>(
    adapter: UnaryModelAdapter<Input, Output>,
    options: RegistrationOptions = {},
  ): void {
    const { adapterId, capability } = adapter.descriptor;
    const adapters = this.#unary.get(capability) ?? new Map<string, RegisteredUnaryAdapter>();
    if (adapters.has(adapterId)) {
      throw new Error(`Unary adapter ${adapterId} is already registered for ${capability}`);
    }
    adapters.set(adapterId, {
      descriptor: adapter.descriptor,
      parseInput: (input) => adapter.inputSchema.parse(input),
      parseOutput: (output) => adapter.outputSchema.parse(output),
      invoke: async (input, context) =>
        await adapter.invoke(adapter.inputSchema.parse(input), context),
    });
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
    const { adapterId } = adapter.descriptor;
    if (this.#streamingStt.has(adapterId)) {
      throw new Error(`Streaming STT adapter ${adapterId} is already registered`);
    }
    this.#streamingStt.set(adapterId, adapter);
    if (options.default === true || this.#streamingSttDefault === undefined) {
      this.#streamingSttDefault = adapterId;
    }
  }

  resolveStreamingStt(adapterId?: string): StreamingSttAdapter {
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
