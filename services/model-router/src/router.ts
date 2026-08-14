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
  type SecretStore,
} from "./security.ts";
import type { SttAudioChunk, SttStreamEvent, SttTranscript } from "./stt.ts";

const terminalResultSchema = modelResultSchema(z.unknown());

export const modelInvocationRequestSchema = z
  .object({
    capability: modelCapabilitySchema,
    input: z.unknown(),
    adapterId: z.string().min(1).optional(),
  })
  .strict();
export type ModelInvocationRequest = z.infer<typeof modelInvocationRequestSchema>;

export interface ServerModelRouterOptions {
  readonly registry: ModelRoutingRegistry;
  readonly policyVersionAuthority: PolicyVersionAuthority;
  readonly quotaPolicy: TenantQuotaPolicy;
  readonly budget: TenantBudget;
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
    this.#clock = options.clock ?? Date.now;
    this.#scheduler = options.scheduler ?? new SystemDeadlineScheduler(this.#clock);
    this.#secretStore = options.secretStore;
    this.#egressPolicy = options.egressPolicy;
    this.#providerTransport = options.providerTransport;
  }

  async invoke(
    untrustedRequest: unknown,
    context: TrustedModelContext,
  ): Promise<ModelResult<unknown>> {
    assertTrustedContext(context);
    const request = parseInvocationRequest(untrustedRequest);
    const startedAtMs = this.#clock();
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
      );
    }

    const initialCancellation = cancellationError(context, this.#clock());
    if (initialCancellation !== undefined) {
      return this.#validatedResult(
        this.#failure(
          request.capability,
          adapter.descriptor,
          context,
          startedAtMs,
          initialCancellation.modelError,
        ),
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
      );
    }

    const scope = new CancellationScope(context, this.#clock, this.#scheduler);
    const dispatch = createDispatchRequest(adapter.descriptor, context, scope.signal);
    let reservation: BudgetReservation | undefined;
    let result: ModelResult<unknown>;
    try {
      const transport = await this.#prepareDispatch(
        dispatch,
        adapter.descriptor,
        context,
        scope,
        (reserved) => {
          reservation = reserved;
        },
      );
      scope.throwIfCancelled();
      const rawOutput = await scope.race(() =>
        adapter.invoke(request.input, invocation(context, scope.signal, transport)),
      );
      scope.throwIfCancelled();
      let output: unknown;
      try {
        output = adapter.parseOutput(rawOutput);
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
    return this.#validatedResult(result);
  }

  async *streamStt(
    chunks: AsyncIterable<SttAudioChunk>,
    context: TrustedModelContext,
    adapterId?: string,
  ): AsyncIterable<RoutedSttItem> {
    assertTrustedContext(context);
    const startedAtMs = this.#clock();
    let adapter: RegisteredStreamingSttAdapter;
    try {
      adapter = this.#registry.resolveStreamingStt(adapterId);
    } catch {
      yield {
        kind: "complete",
        result: this.#validatedResult(
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
        ) as ModelResult<SttTranscript>,
      };
      return;
    }

    const initialCancellation = cancellationError(context, this.#clock());
    if (initialCancellation !== undefined) {
      yield {
        kind: "complete",
        result: this.#validatedResult(
          this.#failure(
            "stt",
            adapter.descriptor,
            context,
            startedAtMs,
            initialCancellation.modelError,
          ),
        ) as ModelResult<SttTranscript>,
      };
      return;
    }

    const scope = new CancellationScope(context, this.#clock, this.#scheduler);
    const dispatch = createDispatchRequest(adapter.descriptor, context, scope.signal);
    let reservation: BudgetReservation | undefined;
    let iterator: AsyncIterator<SttStreamEvent> | undefined;
    let innerDone = false;
    let terminalResult: ModelResult<SttTranscript> | undefined;
    try {
      const transport = await this.#prepareDispatch(
        dispatch,
        adapter.descriptor,
        context,
        scope,
        (reserved) => {
          reservation = reserved;
        },
      );
      scope.throwIfCancelled();
      const stream = adapter.transcribe(
        validatedChunks(chunks, adapter.chunkSchema, scope.signal),
        invocation(context, scope.signal, transport),
      );
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
      terminalResult = this.#validatedResult({
        ok: true,
        output: finalTranscript,
        metadata: this.#metadata("stt", adapter.descriptor, context, startedAtMs),
      }) as ModelResult<SttTranscript>;
      yield { kind: "complete", result: terminalResult };
    } catch (caught) {
      terminalResult = this.#validatedResult(
        this.#failure("stt", adapter.descriptor, context, startedAtMs, classifyError(caught)),
      ) as ModelResult<SttTranscript>;
      yield { kind: "complete", result: terminalResult };
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
      try {
        if (!innerDone && iterator?.return !== undefined) await iterator.return();
      } finally {
        scope.dispose();
        terminalResult = (await this.#reconcile(
          reservation,
          dispatch,
          terminalResult,
          context,
          startedAtMs,
          adapter.descriptor,
        )) as ModelResult<SttTranscript>;
        this.#validatedResult(terminalResult);
      }
    }
  }

  async #prepareDispatch(
    dispatch: ModelDispatchRequest,
    descriptor: ModelAdapterDescriptor,
    context: TrustedModelContext,
    scope: CancellationScope,
    onReserved: (reservation: BudgetReservation) => void,
  ): Promise<ProviderTransport | undefined> {
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
      reservation = budgetReservationSchema.parse(await this.#budget.reserve(dispatch, context));
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
    try {
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

  #validatedResult(result: ModelResult<unknown>): ModelResult<unknown> {
    return terminalResultSchema.parse(result) as ModelResult<unknown>;
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

function parseInvocationRequest(value: unknown): ModelInvocationRequest {
  try {
    return modelInvocationRequestSchema.parse(value);
  } catch {
    throw new ModelRouterError("invalid_request", "Model invocation request is invalid", false);
  }
}

function classifyError(caught: unknown): ModelError {
  if (caught instanceof ModelRouterError) return caught.modelError;
  if (caught instanceof DOMException && caught.name === "AbortError") {
    return normalizedModelError("cancelled", "Model invocation was cancelled", false);
  }
  return normalizedModelError("provider_error", "Model adapter failed", true);
}

function assertTrustedContext(context: TrustedModelContext): void {
  if (!isTrustedModelContext(context)) {
    throw new ModelRouterError("policy_denied", "Trusted model context is required", false);
  }
}
