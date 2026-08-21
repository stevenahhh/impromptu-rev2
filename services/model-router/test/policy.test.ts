import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  type BudgetReconciliation,
  type BudgetReservation,
  createTrustedModelContext,
  type DeadlineScheduler,
  type ExactEgressGrant,
  type ExactEgressPolicy,
  type ExactEgressRequest,
  type ModelDispatchRequest,
  ModelRouterError,
  ModelRoutingRegistry,
  type PolicyVersionAuthority,
  type ProviderEgressTransport,
  type ProviderEgressTransportRequest,
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

class RecordingPolicyGates implements PolicyVersionAuthority, TenantQuotaPolicy, TenantBudget {
  readonly events: string[] = [];
  readonly reconciliations: BudgetReconciliation[] = [];
  quotaError: ModelRouterError | undefined;
  budgetError: ModelRouterError | undefined;
  reconcileError: Error | undefined;
  onPolicyChecked: (() => void) | undefined;
  onQuotaChecked: (() => void) | undefined;
  onBudgetReserved: (() => void) | undefined;

  async assertCurrent(
    _request: ModelDispatchRequest,
    _context: TrustedModelContext,
  ): Promise<void> {
    this.events.push("policy");
    this.onPolicyChecked?.();
    if (_request.policyVersion !== "policy-current") {
      throw new ModelRouterError(
        "policy_version_mismatch",
        "Model policy version is not current",
        false,
      );
    }
  }

  async assertWithinQuota(
    _request: ModelDispatchRequest,
    _context: TrustedModelContext,
  ): Promise<void> {
    this.events.push("quota");
    this.onQuotaChecked?.();
    if (this.quotaError !== undefined) throw this.quotaError;
  }

  async reserve(
    request: ModelDispatchRequest,
    _context: TrustedModelContext,
  ): Promise<BudgetReservation> {
    this.events.push("reserve");
    this.onBudgetReserved?.();
    if (this.budgetError !== undefined) throw this.budgetError;
    return {
      reservationId: `reservation-${request.tenantId}`,
      reservedUnits: request.estimatedCostUnits,
    };
  }

  async reconcile(
    reconciliation: BudgetReconciliation,
    _context: TrustedModelContext,
  ): Promise<void> {
    this.events.push("reconcile");
    this.reconciliations.push(reconciliation);
    if (this.reconcileError !== undefined) throw this.reconcileError;
  }
}

class CountingEgressPolicy implements ExactEgressPolicy {
  readonly origins: string[] = [];
  onAuthorized: (() => void) | undefined;
  readonly #delegate = new StaticExactEgressPolicy([
    { adapterId: "secured", origin: "https://api.vendor.example" },
  ]);

  async authorize(
    request: ExactEgressRequest,
    context: TrustedModelContext,
  ): Promise<ExactEgressGrant> {
    this.origins.push(request.origin);
    const grant = await this.#delegate.authorize(request, context);
    this.onAuthorized?.();
    return grant;
  }
}

class RecordingTransport implements ProviderEgressTransport {
  readonly requests: ProviderEgressTransportRequest[] = [];

  async send(request: ProviderEgressTransportRequest): Promise<ProviderTransportResponse> {
    this.requests.push(request);
    return { status: 200, headers: {}, body: new Uint8Array([1]) };
  }
}

function trustedContext(
  deadlineAtMs: number,
  signal = new AbortController().signal,
  policyVersion = "policy-current",
) {
  return createTrustedModelContext({
    tenantId: "tenant-1",
    principalId: "user-1",
    requestId: "request-1",
    traceId: "trace-1",
    policyVersion,
    deadlineAtMs,
    signal,
  });
}

function securedAdapter(step: ScriptedUnaryStep<{ answer: string }>) {
  return createScriptedUnaryAdapter({
    descriptor: {
      adapterId: "secured",
      capability: "llm",
      provider: "fake",
      model: "fixed-output",
      modelVersion: "1",
      estimatedCostUnits: 3,
      requirement: {
        secretId: "vendor/service",
        egressOrigin: "https://api.vendor.example",
      },
    },
    inputSchema: z.object({ prompt: z.string() }).strict(),
    outputSchema: z.object({ answer: z.string() }).strict(),
    steps: [step],
  });
}

function routerOptions(
  registry: ModelRoutingRegistry,
  time: ManualTime,
  gates: RecordingPolicyGates,
  overrides: {
    readonly policyVersionAuthority?: PolicyVersionAuthority;
    readonly secretStore?: SecretStore;
    readonly egressPolicy?: ExactEgressPolicy;
    readonly providerTransport?: ProviderEgressTransport;
  } = {},
) {
  return {
    registry,
    clock: time.now,
    scheduler: time,
    policyVersionAuthority: overrides.policyVersionAuthority ?? gates,
    quotaPolicy: gates,
    budget: gates,
    ...(overrides.secretStore === undefined ? {} : { secretStore: overrides.secretStore }),
    ...(overrides.egressPolicy === undefined ? {} : { egressPolicy: overrides.egressPolicy }),
    ...(overrides.providerTransport === undefined
      ? {}
      : { providerTransport: overrides.providerTransport }),
  };
}

const fixedSecretStore: SecretStore = {
  async read() {
    return { value: "fixture-credential" };
  },
};

describe("dispatch policy gates", () => {
  test("enforces current policy, quota, and budget before provider dispatch and reconciles", async () => {
    const time = new ManualTime();
    const gates = new RecordingPolicyGates();
    const registry = new ModelRoutingRegistry();
    const adapter = securedAdapter({ kind: "output", output: { answer: "ok" } });
    registry.registerDeterministicFakeUnary(adapter);
    const providerTransport = new RecordingTransport();
    const router = new ServerModelRouter(
      routerOptions(registry, time, gates, {
        secretStore: fixedSecretStore,
        egressPolicy: new CountingEgressPolicy(),
        providerTransport,
      }),
    );

    const result = await router.invoke(
      { capability: "llm", input: { prompt: "secure" } },
      trustedContext(2_000),
    );

    expect(result.ok).toBe(true);
    expect(gates.events).toEqual(["policy", "quota", "reserve", "reconcile"]);
    expect(adapter.invocationCount).toBe(1);
    expect(providerTransport.requests).toEqual([]);
    expect(gates.reconciliations).toEqual([
      {
        reservationId: "reservation-tenant-1",
        tenantId: "tenant-1",
        capability: "llm",
        adapterId: "secured",
        reservedUnits: 3,
        usedUnits: 3,
        outcome: "success",
        errorCode: null,
      },
    ]);
  });

  test("fails closed on stale policy, quota, and budget denial before dispatch", async () => {
    const cases = [
      {
        expected: "policy_version_mismatch",
        contextVersion: "policy-stale",
        configure: (_gates: RecordingPolicyGates) => undefined,
      },
      {
        expected: "quota_exceeded",
        contextVersion: "policy-current",
        configure: (gates: RecordingPolicyGates) => {
          gates.quotaError = new ModelRouterError("quota_exceeded", "Tenant quota exceeded", false);
        },
      },
      {
        expected: "budget_exceeded",
        contextVersion: "policy-current",
        configure: (gates: RecordingPolicyGates) => {
          gates.budgetError = new ModelRouterError(
            "budget_exceeded",
            "Tenant budget exceeded",
            false,
          );
        },
      },
    ] as const;

    for (const entry of cases) {
      const time = new ManualTime();
      const gates = new RecordingPolicyGates();
      entry.configure(gates);
      const registry = new ModelRoutingRegistry();
      const adapter = securedAdapter({ kind: "output", output: { answer: "must not run" } });
      registry.registerDeterministicFakeUnary(adapter);
      const router = new ServerModelRouter(
        routerOptions(registry, time, gates, {
          secretStore: fixedSecretStore,
          egressPolicy: new CountingEgressPolicy(),
          providerTransport: new RecordingTransport(),
        }),
      );

      const result = await router.invoke(
        { capability: "llm", input: { prompt: "blocked" } },
        trustedContext(2_000, new AbortController().signal, entry.contextVersion),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(entry.expected);
      expect(adapter.invocationCount).toBe(0);
    }
  });

  test("checks cancellation and deadline after every awaited policy gate", async () => {
    for (const mode of ["cancel", "deadline"] as const) {
      for (const gate of ["policy", "quota", "budget", "egress"] as const) {
        const time = new ManualTime();
        const cancellation = new AbortController();
        const gates = new RecordingPolicyGates();
        const egress = new CountingEgressPolicy();
        const stop = () => {
          if (mode === "cancel") cancellation.abort();
          else time.advanceTo(1_250);
        };
        if (gate === "policy") gates.onPolicyChecked = stop;
        if (gate === "quota") gates.onQuotaChecked = stop;
        if (gate === "budget") gates.onBudgetReserved = stop;
        if (gate === "egress") egress.onAuthorized = stop;
        const registry = new ModelRoutingRegistry();
        const adapter = securedAdapter({ kind: "output", output: { answer: "must not run" } });
        registry.registerDeterministicFakeUnary(adapter);
        const router = new ServerModelRouter(
          routerOptions(registry, time, gates, {
            secretStore: fixedSecretStore,
            egressPolicy: egress,
            providerTransport: new RecordingTransport(),
          }),
        );

        const result = await router.invoke(
          { capability: "llm", input: { prompt: `${mode}-${gate}` } },
          trustedContext(1_250, cancellation.signal),
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(mode === "cancel" ? "cancelled" : "deadline_exceeded");
        }
        expect(adapter.invocationCount).toBe(0);
        expect(gates.reconciliations.length).toBe(gate === "egress" ? 1 : 0);
      }
    }
  });

  test("settles cancellation while a deferred budget reservation never resolves", async () => {
    const time = new ManualTime();
    const cancellation = new AbortController();
    const gates = new RecordingPolicyGates();
    let reservationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      reservationStarted = resolve;
    });
    gates.reserve = async () => {
      reservationStarted?.();
      return await new Promise<BudgetReservation>(() => undefined);
    };
    const registry = new ModelRoutingRegistry();
    const adapter = securedAdapter({ kind: "output", output: { answer: "must not run" } });
    registry.registerDeterministicFakeUnary(adapter);
    const router = new ServerModelRouter(routerOptions(registry, time, gates));

    const pending = router.invoke(
      { capability: "llm", input: { prompt: "deferred" } },
      trustedContext(2_000, cancellation.signal),
    );
    await started;
    cancellation.abort();
    const result = await pending;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("cancelled");
    expect(adapter.invocationCount).toBe(0);
  }, 1_000);

  test("checks cancellation and deadline after an awaited secret read before dispatch", async () => {
    for (const mode of ["cancel", "deadline"] as const) {
      const time = new ManualTime();
      const cancellation = new AbortController();
      const gates = new RecordingPolicyGates();
      const registry = new ModelRoutingRegistry();
      const adapter = securedAdapter({ kind: "output", output: { answer: "must not run" } });
      registry.registerDeterministicFakeUnary(adapter);
      const secretStore: SecretStore = {
        async read() {
          if (mode === "cancel") cancellation.abort();
          else time.advanceTo(1_250);
          return { value: "fixture-credential" };
        },
      };
      const router = new ServerModelRouter(
        routerOptions(registry, time, gates, {
          secretStore,
          egressPolicy: new CountingEgressPolicy(),
          providerTransport: new RecordingTransport(),
        }),
      );

      const result = await router.invoke(
        { capability: "llm", input: { prompt: mode } },
        trustedContext(1_250, cancellation.signal),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(mode === "cancel" ? "cancelled" : "deadline_exceeded");
      }
      expect(adapter.invocationCount).toBe(0);
      expect(gates.reconciliations).toHaveLength(1);
    }
  });
  test("buffers streaming success until budget reconciliation succeeds", async () => {
    const time = new ManualTime();
    const gates = new RecordingPolicyGates();
    gates.reconcileError = new Error("accounting unavailable");
    const registry = new ModelRoutingRegistry();
    const transcript = { text: "final", language: "ko", durationMs: 100 };
    registry.registerDeterministicFakeStreamingStt(
      createScriptedSttAdapter({
        transcript,
        events: [
          {
            kind: "FINAL",
            sessionGeneration: 1,
            sequence: 0,
            segmentId: "segment-policy",
            finalSegmentId: "final-policy",
            transcript: { ...transcript, words: [] },
          },
        ],
      }),
    );
    const router = new ServerModelRouter(routerOptions(registry, time, gates));

    const routed = [];
    for await (const item of router.streamStt(emptyAudio(), trustedContext(2_000))) {
      routed.push(item);
    }
    const completions = routed.filter((item) => item.kind === "complete");

    expect(routed.filter((item) => item.kind === "transcript")).toEqual([]);
    expect(completions).toHaveLength(1);
    expect(completions[0]?.result.ok).toBe(false);
    if (completions[0] !== undefined && !completions[0].result.ok) {
      expect(completions[0].result.error.code).toBe("budget_exceeded");
    }
  });
});

describe("policy-mediated provider transport", () => {
  test("mediates every request and never exposes credentials to the adapter", async () => {
    const time = new ManualTime();
    const gates = new RecordingPolicyGates();
    const egress = new CountingEgressPolicy();
    const transport = new RecordingTransport();
    const registry = new ModelRoutingRegistry();
    registry.registerDeterministicFakeUnary(
      securedAdapter({
        kind: "transport",
        requests: [
          { method: "POST", path: "/v1/first" },
          { method: "GET", path: "/v1/second" },
        ],
        output: { answer: "transported" },
      }),
    );
    const router = new ServerModelRouter(
      routerOptions(registry, time, gates, {
        secretStore: fixedSecretStore,
        egressPolicy: egress,
        providerTransport: transport,
      }),
    );

    const result = await router.invoke(
      { capability: "llm", input: { prompt: "transport" } },
      trustedContext(2_000),
    );

    expect(result.ok).toBe(true);
    expect(egress.origins).toEqual([
      "https://api.vendor.example",
      "https://api.vendor.example",
      "https://api.vendor.example",
    ]);
    expect(transport.requests.map(({ url }) => url)).toEqual([
      "https://api.vendor.example/v1/first",
      "https://api.vendor.example/v1/second",
    ]);
    expect(transport.requests.every(({ credential }) => credential === "fixture-credential")).toBe(
      true,
    );
  });

  test("revokes retained transport capabilities after success, cancellation, and deadline", async () => {
    for (const terminal of ["success", "cancel", "deadline"] as const) {
      const time = new ManualTime();
      const cancellation = new AbortController();
      const gates = new RecordingPolicyGates();
      const registry = new ModelRoutingRegistry();
      const adapter = securedAdapter(
        terminal === "success"
          ? { kind: "output", output: { answer: "done" } }
          : { kind: "pending" },
      );
      const started = adapter.waitForInvocation();
      registry.registerDeterministicFakeUnary(adapter);
      const router = new ServerModelRouter(
        routerOptions(registry, time, gates, {
          secretStore: fixedSecretStore,
          egressPolicy: new CountingEgressPolicy(),
          providerTransport: new RecordingTransport(),
        }),
      );

      const pending = router.invoke(
        { capability: "llm", input: { prompt: terminal } },
        trustedContext(terminal === "deadline" ? 1_250 : 2_000, cancellation.signal),
      );
      await started;
      if (terminal === "cancel") cancellation.abort();
      if (terminal === "deadline") time.advanceTo(1_250);
      await pending;

      const retained = adapter.retainedTransports[0];
      let rejected: unknown;
      try {
        await retained?.request({ method: "GET", path: "/after-terminal" });
      } catch (caught) {
        rejected = caught;
      }
      expect(rejected).toMatchObject({
        modelError: { code: "transport_error", retryable: false },
      });
    }
  });

  test("rejects an absolute or cross-origin transport path before egress", async () => {
    const time = new ManualTime();
    const gates = new RecordingPolicyGates();
    const transport = new RecordingTransport();
    const registry = new ModelRoutingRegistry();
    registry.registerDeterministicFakeUnary(
      securedAdapter({
        kind: "transport",
        requests: [{ method: "POST", path: "https://other.example/v1" }],
        output: { answer: "must not complete" },
      }),
    );
    const router = new ServerModelRouter(
      routerOptions(registry, time, gates, {
        secretStore: fixedSecretStore,
        egressPolicy: new CountingEgressPolicy(),
        providerTransport: transport,
      }),
    );

    const result = await router.invoke(
      { capability: "llm", input: { prompt: "blocked" } },
      trustedContext(2_000),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("policy_denied");
    expect(transport.requests).toEqual([]);
  });
});

async function* emptyAudio(): AsyncIterable<never> {}
