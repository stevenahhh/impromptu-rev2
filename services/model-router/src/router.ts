import { z } from "zod";
import { isTrustedModelContext, type TrustedModelContext } from "./context.ts";
import {
  CancellationScope,
  type Clock,
  cancellationError,
  type DeadlineScheduler,
  SystemDeadlineScheduler,
} from "./deadline.ts";
import { ModelRouterError, normalizedModelError } from "./errors.ts";
import type { AdapterIsolate } from "./isolation.ts";
import {
  type BudgetReservation,
  budgetReconciliationSchema,
  budgetReservationSchema,
  type ModelDispatchRequest,
  modelDispatchRequestSchema,
  type PolicyVersionAuthority,
  type TenantBudget,
  type TenantQuotaPolicy,
} from "./policy.ts";
import type { ModelAdapterDescriptor, ModelInvocationContext, ProviderTransport } from "./ports.ts";
import type {
  ModelRoutingRegistry,
  RegisteredStreamingSttAdapter,
  RegisteredUnaryAdapter,
} from "./registry.ts";
import {
  type ModelCapability,
  type ModelError,
  type ModelFailure,
  type ModelResult,
  type ModelResultMetadata,
  modelCapabilitySchema,
  modelResultSchema,
} from "./schemas.ts";
import {
  createPolicyMediatedTransport,
  type ExactEgressPolicy,
  type ProviderEgressTransport,
  type RevocableTransportLease,
  type SecretStore,
} from "./security.ts";
import {
  type SttAudioChunk,
  type SttStreamEvent,
  type SttTranscript,
  sttStreamEventSchema,
  sttTranscriptSchema,
} from "./stt.ts";

const terminalResultSchema = modelResultSchema(z.unknown());
const sttTerminalResultSchema = modelResultSchema(sttTranscriptSchema);

export const modelInvocationRequestSchema = z
  .object({
    capability: modelCapabilitySchema,
    input: z.unknown(),
    adapterId: z.string().min(1).optional(),
  })
  .strict();
export type ModelInvocationRequest = z.infer<typeof modelInvocationRequestSchema>;

interface ResultContext {
  readonly policyVersion: string;
  readonly requestId: string;
  readonly traceId: string;
}

export interface ServerModelRouterOptions {
  readonly registry: ModelRoutingRegistry;
  readonly policyVersionAuthority: PolicyVersionAuthority;
  readonly quotaPolicy: TenantQuotaPolicy;
  readonly budget: TenantBudget;
  readonly adapterIsolate?: AdapterIsolate;
  readonly clock?: Clock;
  readonly scheduler?: DeadlineScheduler;
  readonly secretStore?: SecretStore;
  readonly egressPolicy?: ExactEgressPolicy;
  readonly providerTransport?: ProviderEgressTransport;
}

export type RoutedSttItem =
  | { readonly kind: "transcript"; readonly event: SttStreamEvent }
  | { readonly kind: "complete"; readonly result: ModelResult<SttTranscript> };

export class ServerModelRouter {
  readonly #registry: ModelRoutingRegistry;
  readonly #policyVersionAuthority: PolicyVersionAuthority;
  readonly #quotaPolicy: TenantQuotaPolicy;
  readonly #budget: TenantBudget;
  readonly #adapterIsolate: AdapterIsolate | undefined;
  readonly #clock: Clock;
  readonly #scheduler: DeadlineScheduler;
  readonly #secretStore: SecretStore | undefined;
  readonly #egressPolicy: ExactEgressPolicy | undefined;
  readonly #providerTransport: ProviderEgressTransport | undefined;

  constructor(options: ServerModelRouterOptions) {
    this.#registry = options.registry;
    this.#policyVersionAuthority = options.policyVersionAuthority;
    this.#quotaPolicy = options.quotaPolicy;
    this.#budget = options.budget;
    this.#adapterIsolate = options.adapterIsolate;
    this.#clock = options.clock ?? Date.now;
    this.#scheduler = options.scheduler ?? new SystemDeadlineScheduler(this.#clock);
    this.#secretStore = options.secretStore;
    this.#egressPolicy = options.egressPolicy;
    this.#providerTransport = options.providerTransport;
  }

  async invoke(
    untrustedRequest: unknown,
    untrustedContext: unknown,
  ): Promise<ModelResult<unknown>> {
    const startedAtMs = this.#now();
    const resultContext = resultContextFrom(untrustedContext);
    let request: ModelInvocationRequest;
    try {
      request = modelInvocationRequestSchema.parse(untrustedRequest);
    } catch {
      return this.#validatedResult(
        this.#failure(
          null,
          null,
          resultContext,
          startedAtMs,
          normalizedModelError("invalid_request", "Model invocation request is invalid", false),
        ),
        null,
        resultContext,
        startedAtMs,
      );
    }
    if (!isTrustedModelContext(untrustedContext)) {
      return this.#validatedResult(
        this.#failure(
          request.capability,
          null,
          resultContext,
          startedAtMs,
          normalizedModelError("policy_denied", "Trusted model context is required", false),
        ),
        request.capability,
        resultContext,
        startedAtMs,
      );
    }
    const context = untrustedContext;

    let adapter: RegisteredUnaryAdapter;
    try {
      adapter = this.#registry.resolveUnary(request.capability, request.adapterId);
    } catch {
      return this.#validatedResult(
        this.#failure(
          request.capability,
          null,
          context,
          startedAtMs,
          normalizedModelError(
            "unsupported_capability",
            "No matching model adapter is registered",
            false,
          ),
        ),
        request.capability,
        context,
        startedAtMs,
      );
    }

    const initialCancellation = cancellationError(context, this.#now());
    if (initialCancellation !== undefined) {
      return this.#validatedResult(
        this.#failure(
          request.capability,
          adapter.descriptor,
          context,
          startedAtMs,
          initialCancellation.modelError,
        ),
        request.capability,
        context,
        startedAtMs,
      );
    }

    try {
      adapter.parseInput(request.input);
    } catch {
      return this.#validatedResult(
        this.#failure(
          request.capability,
          adapter.descriptor,
          context,
          startedAtMs,
          normalizedModelError(
            "invalid_request",
            "Model input did not match the adapter schema",
            false,
          ),
        ),
        request.capability,
        context,
        startedAtMs,
      );
    }

    const scope = new CancellationScope(context, this.#clock, this.#scheduler);
    let dispatch: ModelDispatchRequest;
    try {
      dispatch = createDispatchRequest(adapter.descriptor, context, scope.signal);
    } catch {
      scope.dispose();
      return this.#validatedResult(
        this.#failure(
          request.capability,
          null,
          context,
          startedAtMs,
          normalizedModelError("invalid_request", "Model adapter descriptor is invalid", false),
        ),
        request.capability,
        context,
        startedAtMs,
      );
    }

    let reservation: BudgetReservation | undefined;
    let lease: RevocableTransportLease | undefined;
    let result: ModelResult<unknown>;
    try {
      lease = await this.#prepareDispatch(
        dispatch,
        adapter.descriptor,
        context,
        scope,
        (reserved) => {
          reservation = reserved;
        },
      );
      scope.throwIfCancelled();
      const adapterContext = invocation(context, scope.signal, lease?.transport);
      let rawOutput: unknown;
      if (adapter.kind === "deterministic-test") {
        rawOutput = await scope.race(() => adapter.invoke(request.input, adapterContext));
      } else {
        if (this.#adapterIsolate === undefined) {
          throw new ModelRouterError(
            "provider_error",
            "No production adapter isolate is configured",
            false,
          );
        }
        rawOutput = await this.#adapterIsolate.invoke(
          adapter.module,
          request.input,
          adapterContext,
        );
      }
      scope.throwIfCancelled();
      let output: unknown;
      try {
        output = structuredClone(adapter.parseOutput(rawOutput));
      } catch {
        throw new ModelRouterError(
          "provider_error",
          "Model output did not match the adapter schema",
          false,
        );
      }
      result = {
        ok: true,
        output,
        metadata: this.#metadata(request.capability, adapter.descriptor, context, startedAtMs),
      };
    } catch (caught) {
      result = this.#failure(
        request.capability,
        adapter.descriptor,
        context,
        startedAtMs,
        classifyError(caught),
      );
    } finally {
      lease?.revoke();
      scope.dispose();
    }

    result = await this.#reconcile(
      reservation,
      dispatch,
      result,
      context,
      startedAtMs,
      adapter.descriptor,
    );
    return this.#validatedResult(result, request.capability, context, startedAtMs);
  }

  async *streamStt(
    chunks: AsyncIterable<SttAudioChunk>,
    untrustedContext: unknown,
    adapterId?: string,
  ): AsyncIterable<RoutedSttItem> {
    const startedAtMs = this.#now();
    const resultContext = resultContextFrom(untrustedContext);
    if (!isTrustedModelContext(untrustedContext)) {
      yield {
        kind: "complete",
        result: this.#validatedSttResult(
          this.#failure(
            "stt",
            null,
            resultContext,
            startedAtMs,
            normalizedModelError("policy_denied", "Trusted model context is required", false),
          ),
          resultContext,
          startedAtMs,
        ),
      };
      return;
    }
    const context = untrustedContext;
    if (adapterId !== undefined && !z.string().min(1).safeParse(adapterId).success) {
      yield {
        kind: "complete",
        result: this.#validatedSttResult(
          this.#failure(
            "stt",
            null,
            context,
            startedAtMs,
            normalizedModelError("invalid_request", "Streaming STT request is invalid", false),
          ),
          context,
          startedAtMs,
        ),
      };
      return;
    }

    let adapter: RegisteredStreamingSttAdapter;
    try {
      adapter = this.#registry.resolveStreamingStt(adapterId);
    } catch {
      yield {
        kind: "complete",
        result: this.#validatedSttResult(
          this.#failure(
            "stt",
            null,
            context,
            startedAtMs,
            normalizedModelError(
              "unsupported_capability",
              "No matching streaming STT adapter is registered",
              false,
            ),
          ),
          context,
          startedAtMs,
        ),
      };
      return;
    }

    const initialCancellation = cancellationError(context, this.#now());
    if (initialCancellation !== undefined) {
      yield {
        kind: "complete",
        result: this.#validatedSttResult(
          this.#failure(
            "stt",
            adapter.descriptor,
            context,
            startedAtMs,
            initialCancellation.modelError,
          ),
          context,
          startedAtMs,
        ),
      };
      return;
    }

    const scope = new CancellationScope(context, this.#clock, this.#scheduler);
    let dispatch: ModelDispatchRequest;
    try {
      dispatch = createDispatchRequest(adapter.descriptor, context, scope.signal);
    } catch {
      scope.dispose();
      yield {
        kind: "complete",
        result: this.#validatedSttResult(
          this.#failure(
            "stt",
            null,
            context,
            startedAtMs,
            normalizedModelError("invalid_request", "Streaming STT descriptor is invalid", false),
          ),
          context,
          startedAtMs,
        ),
      };
      return;
    }

    let reservation: BudgetReservation | undefined;
    let lease: RevocableTransportLease | undefined;
    let iterator: AsyncIterator<SttStreamEvent> | undefined;
    let innerDone = false;
    let terminalResult: ModelResult<SttTranscript> | undefined;
    try {
      lease = await this.#prepareDispatch(
        dispatch,
        adapter.descriptor,
        context,
        scope,
        (reserved) => {
          reservation = reserved;
        },
      );
      scope.throwIfCancelled();
      const validatedInput = validatedChunks(chunks, adapter.chunkSchema, scope.signal);
      const adapterContext = invocation(context, scope.signal, lease?.transport);
      let stream: AsyncIterable<SttStreamEvent>;
      if (adapter.kind === "deterministic-test") {
        stream = adapter.transcribe(validatedInput, adapterContext);
      } else {
        if (this.#adapterIsolate === undefined) {
          throw new ModelRouterError(
            "provider_error",
            "No production adapter isolate is configured",
            false,
          );
        }
        stream = this.#adapterIsolate.streamStt(adapter.module, validatedInput, adapterContext);
      }
      iterator = stream[Symbol.asyncIterator]();
      const activeIterator = iterator;
      let finalTranscript: SttTranscript | undefined;
      while (true) {
        const next = await scope.race(() => activeIterator.next());
        scope.throwIfCancelled();
        if (next.done) {
          innerDone = true;
          break;
        }
        let event: SttStreamEvent;
        try {
          event = sttStreamEventSchema.parse(adapter.eventSchema.parse(next.value));
        } catch {
          throw new ModelRouterError(
            "provider_error",
            "Streaming STT output did not match the canonical schema",
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
      terminalResult = {
        ok: true,
        output: finalTranscript,
        metadata: this.#metadata("stt", adapter.descriptor, context, startedAtMs),
      };
    } catch (caught) {
      terminalResult = this.#failure(
        "stt",
        adapter.descriptor,
        context,
        startedAtMs,
        classifyError(caught),
      );
    } finally {
      if (terminalResult === undefined) {
        scope.abort();
        terminalResult = this.#failure(
          "stt",
          adapter.descriptor,
          context,
          startedAtMs,
          normalizedModelError("cancelled", "Streaming STT consumer ended", false),
        );
      }
      if (!innerDone) scope.abort();
      try {
        if (!innerDone && iterator?.return !== undefined) await iterator.return();
      } finally {
        lease?.revoke();
        scope.dispose();
        terminalResult = (await this.#reconcile(
          reservation,
          dispatch,
          terminalResult,
          context,
          startedAtMs,
          adapter.descriptor,
        )) as ModelResult<SttTranscript>;
      }
    }

    yield {
      kind: "complete",
      result: this.#validatedSttResult(terminalResult, context, startedAtMs),
    };
  }

  async #prepareDispatch(
    dispatch: ModelDispatchRequest,
    descriptor: ModelAdapterDescriptor,
    context: TrustedModelContext,
    scope: CancellationScope,
    onReserved: (reservation: BudgetReservation) => void,
  ): Promise<RevocableTransportLease | undefined> {
    await guardedStep(
      scope,
      () => this.#policyVersionAuthority.assertCurrent(dispatch, context),
      "policy_version_mismatch",
      "Model policy version could not be verified",
    );
    await guardedStep(
      scope,
      () => this.#quotaPolicy.assertWithinQuota(dispatch, context),
      "quota_exceeded",
      "Tenant model quota could not be authorized",
    );

    let reservation: BudgetReservation;
    try {
      const untrustedReservation = await guardedStep(
        scope,
        () => this.#budget.reserve(dispatch, context),
        "budget_exceeded",
        "Tenant model budget could not be reserved",
      );
      reservation = budgetReservationSchema.parse(untrustedReservation);
    } catch (caught) {
      if (caught instanceof ModelRouterError) throw caught;
      throw new ModelRouterError(
        "budget_exceeded",
        "Tenant model budget could not be reserved",
        false,
      );
    }
    onReserved(Object.freeze(reservation));
    scope.throwIfCancelled();

    const requirement = descriptor.requirement;
    if (requirement === undefined) return undefined;
    if (this.#egressPolicy === undefined) {
      throw new ModelRouterError("policy_denied", "No provider egress policy is configured", false);
    }
    if (this.#secretStore === undefined) {
      throw new ModelRouterError(
        "secret_unavailable",
        "No server secret store is configured",
        true,
      );
    }
    if (this.#providerTransport === undefined) {
      throw new ModelRouterError("transport_error", "No provider transport is configured", false);
    }

    await guardedStep(
      scope,
      () =>
        this.#egressPolicy?.authorize(
          { adapterId: descriptor.adapterId, origin: requirement.egressOrigin },
          context,
        ) ?? Promise.reject(new Error("Missing egress policy")),
      "policy_denied",
      "Provider egress could not be authorized",
    );
    const secret = await guardedStep(
      scope,
      () =>
        this.#secretStore?.read(requirement.secretId, context) ??
        Promise.reject(new Error("Missing secret store")),
      "secret_unavailable",
      "Provider credential is unavailable",
    );
    if (secret.value.length === 0) {
      throw new ModelRouterError("secret_unavailable", "Provider credential is unavailable", true);
    }
    scope.throwIfCancelled();
    return createPolicyMediatedTransport({
      adapterId: descriptor.adapterId,
      origin: requirement.egressOrigin,
      credential: secret.value,
      context,
      signal: scope.signal,
      egressPolicy: this.#egressPolicy,
      providerTransport: this.#providerTransport,
      checkpoint: () => scope.throwIfCancelled(),
    });
  }

  async #reconcile<Output>(
    reservation: BudgetReservation | undefined,
    dispatch: ModelDispatchRequest,
    result: ModelResult<Output>,
    context: TrustedModelContext,
    startedAtMs: number,
    descriptor: ModelAdapterDescriptor,
  ): Promise<ModelResult<Output>> {
    if (reservation === undefined) return result;
    const errorCode = result.ok ? null : result.error.code;
    try {
      const reconciliation = budgetReconciliationSchema.parse({
        reservationId: reservation.reservationId,
        tenantId: dispatch.tenantId,
        capability: dispatch.capability,
        adapterId: dispatch.adapterId,
        reservedUnits: reservation.reservedUnits,
        usedUnits: result.ok ? reservation.reservedUnits : 0,
        outcome: result.ok
          ? "success"
          : errorCode === "cancelled" || errorCode === "deadline_exceeded"
            ? "cancelled"
            : "failure",
        errorCode,
      });
      await this.#budget.reconcile(reconciliation, context);
      return result;
    } catch {
      if (!result.ok) return result;
      return this.#failure(
        dispatch.capability,
        descriptor,
        context,
        startedAtMs,
        normalizedModelError("budget_exceeded", "Tenant model budget reconciliation failed", false),
      );
    }
  }

  #failure(
    capability: ModelCapability | null,
    descriptor: ModelAdapterDescriptor | null,
    context: ResultContext,
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
    capability: ModelCapability | null,
    descriptor: ModelAdapterDescriptor | null,
    context: ResultContext,
    startedAtMs: number,
  ): ModelResultMetadata {
    const completedAtMs = Math.max(startedAtMs, this.#now());
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

  #validatedResult(
    result: ModelResult<unknown>,
    capability: ModelCapability | null,
    context: ResultContext,
    startedAtMs: number,
  ): ModelResult<unknown> {
    try {
      const parsed = terminalResultSchema.parse(result);
      return parsed as ModelResult<unknown>;
    } catch {
      return this.#failure(
        capability,
        null,
        context,
        startedAtMs,
        normalizedModelError("provider_error", "Model terminal result was invalid", false),
      );
    }
  }

  #validatedSttResult(
    result: ModelResult<unknown>,
    context: ResultContext,
    startedAtMs: number,
  ): ModelResult<SttTranscript> {
    try {
      const parsed = sttTerminalResultSchema.parse(result);
      return parsed as ModelResult<SttTranscript>;
    } catch {
      return this.#failure(
        "stt",
        null,
        context,
        startedAtMs,
        normalizedModelError("provider_error", "Streaming STT terminal result was invalid", false),
      );
    }
  }

  #now(): number {
    try {
      const value = this.#clock();
      return Number.isFinite(value) && value >= 0 ? value : 0;
    } catch {
      return 0;
    }
  }
}

async function guardedStep<Value>(
  scope: CancellationScope,
  operation: () => Promise<Value>,
  fallbackCode: ModelError["code"],
  fallbackMessage: string,
): Promise<Value> {
  try {
    const value = await scope.race(operation);
    scope.throwIfCancelled();
    return value;
  } catch (caught) {
    if (caught instanceof ModelRouterError) throw caught;
    throw new ModelRouterError(fallbackCode, fallbackMessage, false);
  }
}

function createDispatchRequest(
  descriptor: ModelAdapterDescriptor,
  context: TrustedModelContext,
  signal: AbortSignal,
): ModelDispatchRequest {
  return modelDispatchRequestSchema.parse({
    tenantId: context.tenantId,
    capability: descriptor.capability,
    adapterId: descriptor.adapterId,
    policyVersion: context.policyVersion,
    estimatedCostUnits: descriptor.estimatedCostUnits,
    signal,
  });
}

function invocation(
  trustedContext: TrustedModelContext,
  signal: AbortSignal,
  transport: ProviderTransport | undefined,
): ModelInvocationContext {
  return transport === undefined
    ? { trustedContext, signal }
    : { trustedContext, signal, transport };
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

function resultContextFrom(value: unknown): ResultContext {
  try {
    if (isTrustedModelContext(value)) return value;
    if (typeof value !== "object" || value === null) return untrustedResultContext();
    const candidate = value as Readonly<Record<string, unknown>>;
    return {
      policyVersion: nonemptyString(candidate.policyVersion) ?? "untrusted",
      requestId: nonemptyString(candidate.requestId) ?? "untrusted",
      traceId: nonemptyString(candidate.traceId) ?? "untrusted",
    };
  } catch {
    return untrustedResultContext();
  }
}

function untrustedResultContext(): ResultContext {
  return { policyVersion: "untrusted", requestId: "untrusted", traceId: "untrusted" };
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function classifyError(caught: unknown): ModelError {
  if (caught instanceof ModelRouterError) return caught.modelError;
  if (caught instanceof DOMException && caught.name === "AbortError") {
    return normalizedModelError("cancelled", "Model invocation was cancelled", false);
  }
  return normalizedModelError("provider_error", "Model adapter failed", true);
}
