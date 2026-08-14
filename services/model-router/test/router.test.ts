import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  type AdapterRequirement,
  type BudgetReconciliation,
  type BudgetReservation,
  createTrustedModelContext,
  type DeadlineScheduler,
  type ModelDispatchRequest,
  ModelRoutingRegistry,
  modelFailureSchema,
  type PolicyVersionAuthority,
  type ProviderEgressTransport,
  type ProviderTransportResponse,
  type SecretStore,
  ServerModelRouter,
  StaticExactEgressPolicy,
  type TenantBudget,
  type TenantQuotaPolicy,
  type TrustedModelContext,
} from "../src/index.ts";
import {
  createScriptedSttAdapter,
  createScriptedUnaryAdapter,
  type ScriptedUnaryStep,
} from "../src/testing.ts";

class ManualTime implements DeadlineScheduler {
  nowMs = 1_000;
  readonly #scheduled = new Set<{ readonly atMs: number; readonly run: () => void }>();

  now = (): number => this.nowMs;

  schedule(atMs: number, run: () => void): () => void {
    const scheduled = { atMs, run };
    this.#scheduled.add(scheduled);
    return () => this.#scheduled.delete(scheduled);
  }

  advanceTo(nowMs: number): void {
    this.nowMs = nowMs;
    for (const scheduled of [...this.#scheduled]) {
      if (scheduled.atMs <= nowMs) {
        this.#scheduled.delete(scheduled);
        scheduled.run();
      }
    }
  }
}

class AllowPolicyGates implements PolicyVersionAuthority, TenantQuotaPolicy, TenantBudget {
  async assertCurrent(
    _request: ModelDispatchRequest,
    _context: TrustedModelContext,
  ): Promise<void> {}

  async assertWithinQuota(
    _request: ModelDispatchRequest,
    _context: TrustedModelContext,
  ): Promise<void> {}

  async reserve(
    request: ModelDispatchRequest,
    _context: TrustedModelContext,
  ): Promise<BudgetReservation> {
    return {
      reservationId: `test-${request.adapterId}`,
      reservedUnits: request.estimatedCostUnits,
    };
  }

  async reconcile(
    _reconciliation: BudgetReconciliation,
    _context: TrustedModelContext,
  ): Promise<void> {}
}

const testProviderTransport: ProviderEgressTransport = {
  async send(): Promise<ProviderTransportResponse> {
    return { status: 200, headers: {}, body: new Uint8Array() };
  },
};

class RecordingSecretStore implements SecretStore {
  readonly reads: string[] = [];

  async read(secretId: string, _context: TrustedModelContext): Promise<{ value: string }> {
    this.reads.push(secretId);
    return { value: "fixture-credential" };
  }
}

function context(deadlineAtMs: number, signal = new AbortController().signal) {
  return createTrustedModelContext({
    tenantId: "tenant-1",
    principalId: "user-1",
    requestId: "request-1",
    traceId: "trace-1",
    policyVersion: "policy-2026-08",
    deadlineAtMs,
    signal,
  });
}

function createRouter(
  registry: ModelRoutingRegistry,
  time: ManualTime,
  extras: {
    readonly secretStore?: SecretStore;
    readonly egressPolicy?: StaticExactEgressPolicy;
    readonly providerTransport?: ProviderEgressTransport;
  } = {},
): ServerModelRouter {
  const gates = new AllowPolicyGates();
  return new ServerModelRouter({
    registry,
    clock: time.now,
    scheduler: time,
    policyVersionAuthority: gates,
    quotaPolicy: gates,
    budget: gates,
    ...(extras.secretStore === undefined ? {} : { secretStore: extras.secretStore }),
    ...(extras.egressPolicy === undefined ? {} : { egressPolicy: extras.egressPolicy }),
    ...(extras.providerTransport === undefined
      ? {}
      : { providerTransport: extras.providerTransport }),
  });
}

function unaryAdapter(
  adapterId: string,
  step: ScriptedUnaryStep<{ answer: string }>,
  requirement?: AdapterRequirement,
) {
  return createScriptedUnaryAdapter({
    descriptor: {
      adapterId,
      capability: "llm",
      provider: "fake",
      model: "fixed-output",
      modelVersion: "1",
      estimatedCostUnits: 1,
      ...(requirement === undefined ? {} : { requirement }),
    },
    inputSchema: z.object({ prompt: z.string() }),
    outputSchema: z.object({ answer: z.string() }),
    steps: [step],
  });
}

describe("routing registry", () => {
  test("resolves one deterministic default and explicit alternatives", () => {
    const registry = new ModelRoutingRegistry();
    const primary = unaryAdapter("primary", { kind: "output", output: { answer: "primary" } });
    const secondary = unaryAdapter("secondary", {
      kind: "output",
      output: { answer: "secondary" },
    });

    registry.registerDeterministicFakeUnary(primary, { default: true });
    registry.registerDeterministicFakeUnary(secondary);

    expect(registry.resolveUnary("llm").descriptor.adapterId).toBe("primary");
    expect(registry.resolveUnary("llm", "secondary").descriptor.adapterId).toBe("secondary");
    expect(registry.registerDeterministicFakeUnary(primary)).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(() => registry.resolveUnary("ocr")).toThrow("No unary adapter");
  });

  test("rejects unknown descriptor properties at registration", () => {
    const registry = new ModelRoutingRegistry();
    const descriptor = {
      adapterId: "invalid-descriptor",
      capability: "llm" as const,
      provider: "fake",
      model: "fixed-output",
      modelVersion: "1",
      estimatedCostUnits: 1,
      unexpected: true,
    };
    const adapter = createScriptedUnaryAdapter({
      descriptor,
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ answer: z.string() }).strict(),
      steps: [{ kind: "output", output: { answer: "must not register" } }],
    });

    expect(registry.registerDeterministicFakeUnary(adapter)).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
      metadata: { capability: null },
    });
  });

  test("deep-clones and freezes streaming descriptors at registration", () => {
    const registry = new ModelRoutingRegistry();
    const requirement = {
      secretId: "fixture/secret",
      egressOrigin: "https://api.vendor.example",
    };
    const adapter = createScriptedSttAdapter({
      transcript: { text: "final", language: "ko", durationMs: 100 },
      events: [],
      requirement,
    });

    registry.registerDeterministicFakeStreamingStt(adapter);
    requirement.secretId = "mutated";
    const registered = registry.resolveStreamingStt();

    expect(registered.descriptor.requirement?.secretId).toBe("fixture/secret");
    expect(Object.isFrozen(registered.descriptor)).toBe(true);
    expect(Object.isFrozen(registered.descriptor.requirement)).toBe(true);
  });

  test("registers streaming STT independently from unary STT", () => {
    const registry = new ModelRoutingRegistry();
    const stt = createScriptedSttAdapter({
      transcript: { text: "final", language: "ko", durationMs: 100 },
      events: [],
    });

    registry.registerDeterministicFakeUnary(stt);
    registry.registerDeterministicFakeStreamingStt(stt);

    expect(registry.resolveUnary("stt")).toBeDefined();
    expect(registry.resolveStreamingStt().descriptor.adapterId).toBe("deterministic-fake-stt");
  });

  test("fails registration transactionally for malformed and throwing boundaries", () => {
    const registry = new ModelRoutingRegistry();
    const baselineUnary = unaryAdapter("baseline", {
      kind: "output",
      output: { answer: "stable" },
    });
    const baselineStt = createScriptedSttAdapter({
      adapterId: "baseline-stt",
      transcript: { text: "stable", language: "ko", durationMs: 1 },
      events: [],
    });
    registry.registerDeterministicFakeUnary(baselineUnary);
    registry.registerDeterministicFakeStreamingStt(baselineStt);

    const hostileRegistration = new Proxy(
      {},
      {
        get() {
          throw new Error("hostile registration getter");
        },
      },
    );
    const hostileOptions = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("hostile options reflection");
        },
      },
    );
    const malformedDescriptor = {
      adapterId: "malformed-fake",
      capability: "llm" as const,
      provider: "fake",
      model: "fixed-output",
      modelVersion: "1",
      estimatedCostUnits: 1,
      unexpected: true,
    };
    const malformedFake = createScriptedUnaryAdapter({
      descriptor: malformedDescriptor,
      inputSchema: z.object({ prompt: z.string() }).strict(),
      outputSchema: z.object({ answer: z.string() }).strict(),
      steps: [{ kind: "output", output: { answer: "never" } }],
    });

    const failures = [
      registry.registerDeterministicFakeUnary(malformedFake),
      registry.registerDeterministicFakeUnary(baselineUnary, hostileOptions),
      registry.registerIsolatedUnary(hostileRegistration),
      registry.registerIsolatedStreamingStt(hostileRegistration),
      registry.registerIsolatedUnary({
        descriptor: {
          ...baselineUnary.descriptor,
          adapterId: "partial-isolated",
          provider: "provider",
        },
        inputSchema: z.object({}).strict(),
        outputSchema: z.object({}).strict(),
        module: { modulePath: "relative.mjs", exportName: "invoke", allowedReadPaths: [] },
      }),
    ];

    for (const failure of failures) {
      expect(modelFailureSchema.parse(failure).error.code).toBe("invalid_request");
      expect(Object.isFrozen(failure)).toBe(true);
    }
    expect(registry.resolveUnary("llm").descriptor.adapterId).toBe("baseline");
    expect(registry.resolveStreamingStt().descriptor.adapterId).toBe("baseline-stt");
    expect(() => registry.resolveUnary("llm", "malformed-fake")).toThrow();
    expect(() => registry.resolveUnary("llm", "partial-isolated")).toThrow();
  });

  test("rejects structurally forged deterministic fakes", () => {
    const registry = new ModelRoutingRegistry();
    const genuine = unaryAdapter("genuine", {
      kind: "output",
      output: { answer: "genuine" },
    });
    const forged = {
      descriptor: genuine.descriptor,
      inputSchema: genuine.inputSchema,
      outputSchema: genuine.outputSchema,
      invoke: genuine.invoke,
    };

    const failure = registry.registerDeterministicFakeUnary(forged);

    expect(modelFailureSchema.parse(failure).error.code).toBe("invalid_request");
    expect(() => registry.resolveUnary("llm", "genuine")).toThrow();
  });
});

describe("server model router", () => {
  test("returns schema-valid failures for malformed request and context boundaries", async () => {
    const time = new ManualTime();
    const registry = new ModelRoutingRegistry();
    registry.registerDeterministicFakeUnary(
      unaryAdapter("primary", { kind: "output", output: { answer: "blocked" } }),
    );
    const router = createRouter(registry, time);

    const malformedRequest = await router.invoke(
      { capability: "not-a-capability", input: {} },
      context(2_000),
    );
    const malformedContext = await router.invoke(
      { capability: "llm", input: { prompt: "blocked" } },
      { requestId: "forged" },
    );

    expect(malformedRequest).toMatchObject({
      ok: false,
      error: { code: "invalid_request", retryable: false },
      metadata: { capability: null },
    });
    expect(malformedContext).toMatchObject({
      ok: false,
      error: { code: "policy_denied", retryable: false },
    });
  });

  test("contains throwing Proxy access at request, context, and result boundaries", async () => {
    const time = new ManualTime();
    const registry = new ModelRoutingRegistry();
    const hostileOutput = new Proxy<{ answer: string }>(
      { answer: "hidden" },
      {
        get() {
          throw new Error("hostile output getter");
        },
        ownKeys() {
          throw new Error("hostile output reflection");
        },
      },
    );
    const adapter = createScriptedUnaryAdapter<{ prompt: string }, { answer: string }>({
      descriptor: {
        adapterId: "hostile-boundary",
        capability: "llm",
        provider: "fake",
        model: "hostile-boundary",
        modelVersion: "1",
        estimatedCostUnits: 1,
      },
      inputSchema: z.object({ prompt: z.string() }).strict(),
      outputSchema: { parse: () => hostileOutput },
      steps: [{ kind: "output", output: { answer: "plain-provider-output" } }],
    });
    registry.registerDeterministicFakeUnary(adapter);
    const router = createRouter(registry, time);
    const hostileBoundary = new Proxy(
      {},
      {
        get() {
          throw new Error("hostile boundary getter");
        },
        ownKeys() {
          throw new Error("hostile boundary reflection");
        },
      },
    );

    const malformedRequest = await router.invoke(hostileBoundary, context(2_000));
    const malformedContext = await router.invoke(
      { capability: "llm", input: { prompt: "blocked" } },
      hostileBoundary,
    );
    expect(adapter.invocationCount).toBe(0);
    const malformedOutput = await router.invoke(
      { capability: "llm", input: { prompt: "invoke" } },
      context(2_000),
    );
    const streamed = [];
    for await (const item of router.streamStt(emptyAudio(), hostileBoundary)) streamed.push(item);

    expect(modelFailureSchema.parse(malformedRequest).error.code).toBe("invalid_request");
    expect(modelFailureSchema.parse(malformedContext).error.code).toBe("policy_denied");
    expect(modelFailureSchema.parse(malformedOutput).error.code).toBe("provider_error");
    expect(streamed).toHaveLength(1);
    expect(streamed[0]?.kind).toBe("complete");
    if (streamed[0]?.kind === "complete") {
      expect(modelFailureSchema.parse(streamed[0].result).error.code).toBe("policy_denied");
    }
    expect(adapter.invocationCount).toBe(1);
  });

  test("validates inputs and outputs while recording terminal metadata", async () => {
    const time = new ManualTime();
    const registry = new ModelRoutingRegistry();
    registry.registerDeterministicFakeUnary(
      unaryAdapter("primary", { kind: "output", output: { answer: "TYPED" } }),
    );
    const router = createRouter(registry, time);

    const success = await router.invoke(
      { capability: "llm", input: { prompt: "typed" } },
      context(2_000),
    );
    expect(success).toEqual({
      ok: true,
      output: { answer: "TYPED" },
      metadata: {
        capability: "llm",
        adapterId: "primary",
        provider: "fake",
        model: "fixed-output",
        modelVersion: "1",
        policyVersion: "policy-2026-08",
        requestId: "request-1",
        traceId: "trace-1",
        startedAtMs: 1_000,
        completedAtMs: 1_000,
        latencyMs: 0,
        cacheStatus: "bypass",
      },
    });

    const invalid = await router.invoke(
      { capability: "llm", input: { prompt: 42 } },
      context(2_000),
    );
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe("invalid_request");
  });

  test("cancels an adapter that does not cooperate, without waiting on time", async () => {
    const time = new ManualTime();
    const cancellation = new AbortController();
    const registry = new ModelRoutingRegistry();
    const adapter = unaryAdapter("pending", { kind: "pending" });
    const started = adapter.waitForInvocation();
    registry.registerDeterministicFakeUnary(adapter);
    const router = createRouter(registry, time);

    const pending = router.invoke(
      { capability: "llm", input: { prompt: "cancel" } },
      context(2_000, cancellation.signal),
    );
    await started;
    cancellation.abort();
    const result = await pending;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("cancelled");
  });

  test("ends at an injected deadline without sleeps", async () => {
    const time = new ManualTime();
    const registry = new ModelRoutingRegistry();
    registry.registerDeterministicFakeUnary(unaryAdapter("pending", { kind: "pending" }));
    const router = createRouter(registry, time);

    const pending = router.invoke(
      { capability: "llm", input: { prompt: "deadline" } },
      context(1_250),
    );
    time.advanceTo(1_250);
    const result = await pending;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("deadline_exceeded");
      expect(result.metadata.latencyMs).toBe(250);
    }
  });

  test("does not invoke an adapter after the deadline has already elapsed", async () => {
    const time = new ManualTime();
    const registry = new ModelRoutingRegistry();
    const adapter = unaryAdapter("never-started", {
      kind: "output",
      output: { answer: "too late" },
    });
    registry.registerDeterministicFakeUnary(adapter);
    const router = createRouter(registry, time);

    const result = await router.invoke(
      { capability: "llm", input: { prompt: "expired" } },
      context(1_000),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("deadline_exceeded");
    expect(adapter.invocationCount).toBe(0);
  });

  test("authorizes an exact egress origin before reading a provider secret", async () => {
    const time = new ManualTime();
    const secrets = new RecordingSecretStore();
    const policy = new StaticExactEgressPolicy([
      { adapterId: "secured", origin: "https://api.vendor.example" },
    ]);
    const registry = new ModelRoutingRegistry();
    const secured = unaryAdapter(
      "secured",
      { kind: "output", output: { answer: "authorized" } },
      {
        secretId: "vendor/stt/service",
        egressOrigin: "https://api.vendor.example",
      },
    );
    registry.registerDeterministicFakeUnary(secured);
    const router = createRouter(registry, time, {
      secretStore: secrets,
      egressPolicy: policy,
      providerTransport: testProviderTransport,
    });

    const result = await router.invoke(
      { capability: "llm", input: { prompt: "secure" } },
      context(2_000),
    );

    expect(result.ok).toBe(true);
    expect(secrets.reads).toEqual(["vendor/stt/service"]);
    if (result.ok) {
      expect(result.output).toEqual({ answer: "authorized" });
    }
  });

  test("rejects path, wildcard, and unlisted origins exactly and never reads the secret", async () => {
    expect(
      () =>
        new StaticExactEgressPolicy([{ adapterId: "secured", origin: "https://*.vendor.example" }]),
    ).toThrow("exact URL origin");

    const time = new ManualTime();
    const secrets = new RecordingSecretStore();
    const registry = new ModelRoutingRegistry();
    const secured = unaryAdapter(
      "secured",
      { kind: "output", output: { answer: "must not run" } },
      {
        secretId: "vendor/stt/service",
        egressOrigin: "https://api.vendor.example/v1",
      },
    );
    registry.registerDeterministicFakeUnary(secured);
    const router = createRouter(registry, time, {
      secretStore: secrets,
      egressPolicy: new StaticExactEgressPolicy([
        { adapterId: "secured", origin: "https://api.vendor.example" },
      ]),
      providerTransport: testProviderTransport,
    });

    const result = await router.invoke(
      { capability: "llm", input: { prompt: "blocked" } },
      context(2_000),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("policy_denied");
    expect(secrets.reads).toEqual([]);
  });

  test("streams validated STT events and a terminal result", async () => {
    const time = new ManualTime();
    const registry = new ModelRoutingRegistry();
    const transcript = { text: "확정", language: "ko", durationMs: 100 };
    registry.registerDeterministicFakeStreamingStt(
      createScriptedSttAdapter({
        transcript,
        events: [
          { kind: "partial", sequence: 0, transcript: { ...transcript, text: "확" } },
          { kind: "final", sequence: 1, transcript },
        ],
      }),
    );
    const router = createRouter(registry, time);

    const routed = [];
    for await (const item of router.streamStt(emptyAudio(), context(2_000))) routed.push(item);

    expect(routed.map((item) => item.kind)).toEqual(["transcript", "transcript", "complete"]);
    const completion = routed.at(-1);
    expect(completion?.kind).toBe("complete");
    if (completion?.kind === "complete") {
      expect(completion.result.ok).toBe(true);
      if (completion.result.ok) expect(completion.result.output).toEqual(transcript);
    }
  });

  test("rejects unknown final transcript fields even with a permissive adapter schema", async () => {
    const time = new ManualTime();
    const registry = new ModelRoutingRegistry();
    const event = {
      kind: "final" as const,
      sequence: 0,
      transcript: {
        text: "smuggled",
        language: "ko",
        durationMs: 50,
        unexpected: "must fail",
      },
    };
    const adapter = createScriptedSttAdapter({
      adapterId: "permissive-stt",
      transcript: { text: "fallback", language: "ko", durationMs: 0 },
      events: [event],
      acceptUnvalidatedEvents: true,
    });
    registry.registerDeterministicFakeStreamingStt(adapter);
    const router = createRouter(registry, time);

    const routed = [];
    for await (const item of router.streamStt(emptyAudio(), context(2_000))) routed.push(item);
    const completion = routed.at(-1);

    expect(completion?.kind).toBe("complete");
    if (completion?.kind === "complete") {
      expect(completion.result.ok).toBe(false);
      if (!completion.result.ok) expect(completion.result.error.code).toBe("provider_error");
    }
  });

  test("aborts the internal scope and returns the inner iterator when its consumer returns", async () => {
    const time = new ManualTime();
    const registry = new ModelRoutingRegistry();
    const transcript = { text: "partial", language: "ko", durationMs: 50 };
    const adapter = createScriptedSttAdapter({
      adapterId: "cleanup-stt",
      transcript,
      events: [{ kind: "partial", sequence: 0, transcript }],
      pendingAfterEvents: true,
    });
    registry.registerDeterministicFakeStreamingStt(adapter);
    const router = createRouter(registry, time);
    const outer = router.streamStt(emptyAudio(), context(2_000))[Symbol.asyncIterator]();

    expect((await outer.next()).value?.kind).toBe("transcript");
    await outer.return?.();

    expect(adapter.streamReturnCount).toBe(1);
    expect(adapter.signalAbortedAtReturn).toBe(true);
  });

  test("cancels a streaming STT iterator before another event is requested", async () => {
    const time = new ManualTime();
    const cancellation = new AbortController();
    const registry = new ModelRoutingRegistry();
    const transcript = { text: "final", language: "ko", durationMs: 100 };
    registry.registerDeterministicFakeStreamingStt(
      createScriptedSttAdapter({
        transcript,
        events: [
          { kind: "partial", sequence: 0, transcript: { ...transcript, text: "part" } },
          { kind: "final", sequence: 1, transcript },
        ],
      }),
    );
    const router = createRouter(registry, time);
    const stream = router
      .streamStt(emptyAudio(), context(2_000, cancellation.signal))
      [Symbol.asyncIterator]();

    expect((await stream.next()).value?.kind).toBe("transcript");
    cancellation.abort();
    const completion = (await stream.next()).value;

    expect(completion?.kind).toBe("complete");
    if (completion?.kind === "complete") {
      expect(completion.result.ok).toBe(false);
      if (!completion.result.ok) expect(completion.result.error.code).toBe("cancelled");
    }
    expect((await stream.next()).done).toBe(true);
  });
});

async function* emptyAudio(): AsyncIterable<never> {}
