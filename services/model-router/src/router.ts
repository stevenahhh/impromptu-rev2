import { isTrustedModelContext, type TrustedModelContext } from "./context.ts";
import {
  CancellationScope,
  type Clock,
  cancellationError,
  type DeadlineScheduler,
  SystemDeadlineScheduler,
} from "./deadline.ts";
import { ModelRouterError } from "./errors.ts";
import type { ModelAdapterDescriptor, ModelInvocationContext, ProviderAccess } from "./ports.ts";
import type { ModelRoutingRegistry, RegisteredUnaryAdapter } from "./registry.ts";
import type {
  ModelCapability,
  ModelError,
  ModelFailure,
  ModelResult,
  ModelResultMetadata,
} from "./schemas.ts";
import type { ExactEgressPolicy, SecretStore } from "./security.ts";
import type { StreamingSttAdapter, SttAudioChunk, SttStreamEvent, SttTranscript } from "./stt.ts";

export interface ServerModelRouterOptions {
  readonly registry: ModelRoutingRegistry;
  readonly clock?: Clock;
  readonly scheduler?: DeadlineScheduler;
  readonly secretStore?: SecretStore;
  readonly egressPolicy?: ExactEgressPolicy;
}

export interface ModelInvocationRequest {
  readonly capability: ModelCapability;
  readonly input: unknown;
  readonly adapterId?: string;
}

export type RoutedSttItem =
  | { readonly kind: "transcript"; readonly event: SttStreamEvent }
  | { readonly kind: "complete"; readonly result: ModelResult<SttTranscript> };

export class ServerModelRouter {
  readonly #registry: ModelRoutingRegistry;
  readonly #clock: Clock;
  readonly #scheduler: DeadlineScheduler;
  readonly #secretStore: SecretStore | undefined;
  readonly #egressPolicy: ExactEgressPolicy | undefined;

  constructor(options: ServerModelRouterOptions) {
    this.#registry = options.registry;
    this.#clock = options.clock ?? Date.now;
    this.#scheduler = options.scheduler ?? new SystemDeadlineScheduler(this.#clock);
    this.#secretStore = options.secretStore;
    this.#egressPolicy = options.egressPolicy;
  }

  async invoke(
    request: ModelInvocationRequest,
    context: TrustedModelContext,
  ): Promise<ModelResult<unknown>> {
    assertTrustedContext(context);
    const startedAtMs = this.#clock();
    let adapter: RegisteredUnaryAdapter;
    try {
      adapter = this.#registry.resolveUnary(request.capability, request.adapterId);
    } catch {
      return this.#failure(
        request.capability,
        null,
        context,
        startedAtMs,
        error("unsupported_capability", "No matching model adapter is registered", false),
      );
    }

    const initialCancellation = cancellationError(context, this.#clock());
    if (initialCancellation !== undefined) {
      return this.#failure(
        request.capability,
        adapter.descriptor,
        context,
        startedAtMs,
        initialCancellation.modelError,
      );
    }

    try {
      adapter.parseInput(request.input);
    } catch {
      return this.#failure(
        request.capability,
        adapter.descriptor,
        context,
        startedAtMs,
        error("invalid_request", "Model input did not match the adapter schema", false),
      );
    }

    const scope = new CancellationScope(context, this.#clock, this.#scheduler);
    try {
      const output = await scope.race(
        (async () => {
          const providerAccess = await this.#providerAccess(adapter.descriptor, context);
          const invocationContext = invocation(context, scope.signal, providerAccess);
          const rawOutput = await adapter.invoke(request.input, invocationContext);
          try {
            return adapter.parseOutput(rawOutput);
          } catch {
            throw new ModelRouterError(
              "provider_error",
              "Model output did not match the adapter schema",
              false,
            );
          }
        })(),
      );
      return {
        ok: true,
        output,
        metadata: this.#metadata(request.capability, adapter.descriptor, context, startedAtMs),
      };
    } catch (caught) {
      return this.#failure(
        request.capability,
        adapter.descriptor,
        context,
        startedAtMs,
        classifyError(caught),
      );
    } finally {
      scope.dispose();
    }
  }

  async *streamStt(
    chunks: AsyncIterable<SttAudioChunk>,
    context: TrustedModelContext,
    adapterId?: string,
  ): AsyncIterable<RoutedSttItem> {
    assertTrustedContext(context);
    const startedAtMs = this.#clock();
    let adapter: StreamingSttAdapter;
    try {
      adapter = this.#registry.resolveStreamingStt(adapterId);
    } catch {
      yield {
        kind: "complete",
        result: this.#failure(
          "stt",
          null,
          context,
          startedAtMs,
          error("unsupported_capability", "No matching streaming STT adapter is registered", false),
        ),
      };
      return;
    }

    const initialCancellation = cancellationError(context, this.#clock());
    if (initialCancellation !== undefined) {
      yield {
        kind: "complete",
        result: this.#failure(
          "stt",
          adapter.descriptor,
          context,
          startedAtMs,
          initialCancellation.modelError,
        ),
      };
      return;
    }

    const scope = new CancellationScope(context, this.#clock, this.#scheduler);
    let finalTranscript: SttTranscript | undefined;
    try {
      const providerAccess = await scope.race(this.#providerAccess(adapter.descriptor, context));
      const invocationContext = invocation(context, scope.signal, providerAccess);
      const stream = adapter.transcribe(
        validatedChunks(chunks, adapter.chunkSchema, scope.signal),
        invocationContext,
      );
      const iterator = stream[Symbol.asyncIterator]();
      while (true) {
        const next = await scope.race(iterator.next());
        if (next.done) break;
        let event: SttStreamEvent;
        try {
          event = adapter.eventSchema.parse(next.value);
        } catch {
          throw new ModelRouterError(
            "provider_error",
            "Streaming STT output did not match the adapter schema",
            false,
          );
        }
        if (event.kind === "final") finalTranscript = event.transcript;
        yield { kind: "transcript", event };
      }
      if (finalTranscript === undefined) {
        throw new ModelRouterError(
          "provider_error",
          "Streaming STT completed without a final transcript",
          false,
        );
      }
      yield {
        kind: "complete",
        result: {
          ok: true,
          output: finalTranscript,
          metadata: this.#metadata("stt", adapter.descriptor, context, startedAtMs),
        },
      };
    } catch (caught) {
      yield {
        kind: "complete",
        result: this.#failure(
          "stt",
          adapter.descriptor,
          context,
          startedAtMs,
          classifyError(caught),
        ),
      };
    } finally {
      scope.dispose();
    }
  }

  async #providerAccess(
    descriptor: ModelAdapterDescriptor,
    context: TrustedModelContext,
  ): Promise<ProviderAccess | undefined> {
    const requirement = descriptor.requirement;
    if (requirement === undefined) return undefined;
    if (this.#egressPolicy === undefined) {
      throw new ModelRouterError("policy_denied", "No provider egress policy is configured", false);
    }
    const egress = this.#egressPolicy.authorize(
      { adapterId: descriptor.adapterId, origin: requirement.egressOrigin },
      context,
    );
    if (this.#secretStore === undefined) {
      throw new ModelRouterError(
        "secret_unavailable",
        "No server secret store is configured",
        true,
      );
    }
    let value: string;
    try {
      ({ value } = await this.#secretStore.read(requirement.secretId, context));
    } catch {
      throw new ModelRouterError("secret_unavailable", "Provider credential is unavailable", true);
    }
    if (value.length === 0) {
      throw new ModelRouterError("secret_unavailable", "Provider credential is unavailable", true);
    }
    return { credential: value, egress };
  }

  #failure(
    capability: ModelCapability,
    descriptor: ModelAdapterDescriptor | null,
    context: TrustedModelContext,
    startedAtMs: number,
    modelError: ModelError,
  ): ModelFailure {
    return {
      ok: false,
      error: modelError,
      metadata: this.#metadata(capability, descriptor, context, startedAtMs),
    };
  }

  #metadata(
    capability: ModelCapability,
    descriptor: ModelAdapterDescriptor | null,
    context: TrustedModelContext,
    startedAtMs: number,
  ): ModelResultMetadata {
    const completedAtMs = Math.max(startedAtMs, this.#clock());
    return {
      capability,
      adapterId: descriptor?.adapterId ?? null,
      provider: descriptor?.provider ?? null,
      model: descriptor?.model ?? null,
      modelVersion: descriptor?.modelVersion ?? null,
      policyVersion: context.policyVersion,
      requestId: context.requestId,
      traceId: context.traceId,
      startedAtMs,
      completedAtMs,
      latencyMs: completedAtMs - startedAtMs,
      cacheStatus: "bypass",
    };
  }
}

function invocation(
  trustedContext: TrustedModelContext,
  signal: AbortSignal,
  providerAccess: ProviderAccess | undefined,
): ModelInvocationContext {
  return providerAccess === undefined
    ? { trustedContext, signal }
    : { trustedContext, signal, providerAccess };
}

async function* validatedChunks(
  chunks: AsyncIterable<SttAudioChunk>,
  schema: { parse(value: unknown): SttAudioChunk },
  signal: AbortSignal,
): AsyncIterable<SttAudioChunk> {
  for await (const chunk of chunks) {
    if (signal.aborted) throw signal.reason;
    try {
      yield schema.parse(chunk);
    } catch {
      throw new ModelRouterError(
        "invalid_request",
        "Streaming STT input did not match the audio chunk schema",
        false,
      );
    }
  }
}

function classifyError(caught: unknown): ModelError {
  if (caught instanceof ModelRouterError) return caught.modelError;
  if (caught instanceof DOMException && caught.name === "AbortError") {
    return error("cancelled", "Model invocation was cancelled", false);
  }
  return error("provider_error", "Model adapter failed", true);
}

function error(code: ModelError["code"], message: string, retryable: boolean): ModelError {
  return { code, message, retryable };
}

function assertTrustedContext(context: TrustedModelContext): void {
  if (!isTrustedModelContext(context)) {
    throw new TypeError("ServerModelRouter requires a TrustedModelContext");
  }
}
