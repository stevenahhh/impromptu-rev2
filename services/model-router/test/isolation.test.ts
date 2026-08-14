import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  type BudgetReconciliation,
  type BudgetReservation,
  createTrustedModelContext,
  type DeadlineScheduler,
  type ModelDispatchRequest,
  ModelRoutingRegistry,
  NodePermissionAdapterIsolate,
  type PolicyVersionAuthority,
  type ProviderEgressTransport,
  type ProviderEgressTransportRequest,
  type ProviderTransportResponse,
  type SecretStore,
  ServerModelRouter,
  StaticExactEgressPolicy,
  sttAudioChunkSchema,
  sttStreamEventSchema,
  type TenantBudget,
  type TenantQuotaPolicy,
  type TrustedModelContext,
} from "../src/index.ts";

const modulePath = fileURLToPath(new URL("./fixtures/isolated-adapter.mjs", import.meta.url));

class ManualTime implements DeadlineScheduler {
  nowMs = 1_000;
  readonly #scheduled = new Set<{ readonly atMs: number; readonly run: () => void }>();

  now = (): number => this.nowMs;

  schedule(atMs: number, run: () => void): () => void {
    const scheduled = { atMs, run };
    this.#scheduled.add(scheduled);
    return () => this.#scheduled.delete(scheduled);
  }
}

class AllowGates implements PolicyVersionAuthority, TenantQuotaPolicy, TenantBudget {
  async assertCurrent(
    _request: ModelDispatchRequest,
    _context: TrustedModelContext,
  ): Promise<void> {}

  async assertWithinQuota(
    _request: ModelDispatchRequest,
    _context: TrustedModelContext,
  ): Promise<void> {}

  async reserve(request: ModelDispatchRequest): Promise<BudgetReservation> {
    return { reservationId: `isolate-${request.adapterId}`, reservedUnits: 1 };
  }

  async reconcile(
    _reconciliation: BudgetReconciliation,
    _context: TrustedModelContext,
  ): Promise<void> {}
}

class RecordingEgressTransport implements ProviderEgressTransport {
  readonly requests: ProviderEgressTransportRequest[] = [];
  onRequest: (() => void) | undefined;

  async send(request: ProviderEgressTransportRequest): Promise<ProviderTransportResponse> {
    this.requests.push(request);
    this.onRequest?.();
    return { status: 202, headers: {}, body: new Uint8Array([1]) };
  }
}

const secretStore: SecretStore = {
  async read() {
    return { value: "parent-only-credential" };
  },
};

function context(signal = new AbortController().signal) {
  return createTrustedModelContext({
    tenantId: "tenant-1",
    principalId: "user-1",
    requestId: "request-1",
    traceId: "trace-1",
    policyVersion: "policy-current",
    deadlineAtMs: 2_000,
    signal,
  });
}

function isolatedRouter(
  registry: ModelRoutingRegistry,
  isolate: NodePermissionAdapterIsolate,
  transport: RecordingEgressTransport,
  time = new ManualTime(),
): ServerModelRouter {
  const gates = new AllowGates();
  return new ServerModelRouter({
    registry,
    adapterIsolate: isolate,
    policyVersionAuthority: gates,
    quotaPolicy: gates,
    budget: gates,
    clock: time.now,
    scheduler: time,
    secretStore,
    egressPolicy: new StaticExactEgressPolicy([
      { adapterId: "isolated", origin: "https://api.vendor.example" },
    ]),
    providerTransport: transport,
  });
}

function registerIsolatedUnary(registry: ModelRoutingRegistry): void {
  registry.registerIsolatedUnary({
    descriptor: {
      adapterId: "isolated",
      capability: "llm",
      provider: "fixture-provider",
      model: "isolated-fixture",
      modelVersion: "1",
      estimatedCostUnits: 1,
      requirement: {
        secretId: "fixture/provider",
        egressOrigin: "https://api.vendor.example",
      },
    },
    inputSchema: z.object({ id: z.string().min(1), pending: z.boolean().optional() }).strict(),
    outputSchema: z
      .object({
        id: z.string(),
        fetchBlocked: z.literal(true),
        webSocketBlocked: z.literal(true),
        dnsBlocked: z.literal(true),
        status: z.literal(202),
      })
      .strict(),
    module: { modulePath, exportName: "invoke", allowedReadPaths: [] },
  });
}

describe("production adapter process isolation", () => {
  test("rejects in-process registration for non-fake providers", () => {
    const registry = new ModelRoutingRegistry();

    expect(
      registry.registerDeterministicFakeUnary({
        descriptor: {
          adapterId: "unsafe",
          capability: "llm",
          provider: "production-provider",
          model: "unsafe",
          modelVersion: "1",
          estimatedCostUnits: 1,
        },
        inputSchema: z.unknown(),
        outputSchema: z.unknown(),
        async invoke() {
          return "unsafe";
        },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
      metadata: { capability: null },
    });
  });

  test("denies direct network APIs and mediates concurrent outbound bytes in the parent", async () => {
    const registry = new ModelRoutingRegistry();
    registerIsolatedUnary(registry);
    const isolate = new NodePermissionAdapterIsolate();
    const transport = new RecordingEgressTransport();
    const router = isolatedRouter(registry, isolate, transport);

    const [first, second] = await Promise.all([
      router.invoke({ capability: "llm", input: { id: "first" } }, context()),
      router.invoke({ capability: "llm", input: { id: "second" } }, context()),
    ]);

    expect(first).toMatchObject({
      ok: true,
      output: {
        id: "first",
        fetchBlocked: true,
        webSocketBlocked: true,
        dnsBlocked: true,
        status: 202,
      },
    });
    expect(second).toMatchObject({ ok: true, output: { id: "second" } });
    expect(transport.requests.map(({ url }) => url).sort()).toEqual([
      "https://api.vendor.example/v1/first",
      "https://api.vendor.example/v1/second",
    ]);
    expect(
      transport.requests.every(({ credential }) => credential === "parent-only-credential"),
    ).toBe(true);
    expect(isolate.activeIsolates).toBe(0);
  });

  test("terminates and cleans the isolate on cancellation without waiting for adapter completion", async () => {
    const registry = new ModelRoutingRegistry();
    registerIsolatedUnary(registry);
    const isolate = new NodePermissionAdapterIsolate();
    const transport = new RecordingEgressTransport();
    let requestObserved: (() => void) | undefined;
    const observed = new Promise<void>((resolve) => {
      requestObserved = resolve;
    });
    transport.onRequest = requestObserved;
    const cancellation = new AbortController();
    const router = isolatedRouter(registry, isolate, transport);

    const pending = router.invoke(
      { capability: "llm", input: { id: "pending", pending: true } },
      context(cancellation.signal),
    );
    await observed;
    cancellation.abort();
    const result = await pending;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("cancelled");
    expect(transport.requests).toHaveLength(1);
    expect(isolate.activeIsolates).toBe(0);
  }, 2_000);

  test("streams STT through an isolated module and cleans the process", async () => {
    const registry = new ModelRoutingRegistry();
    registry.registerIsolatedStreamingStt({
      descriptor: {
        adapterId: "isolated-stt",
        capability: "stt",
        provider: "fixture-provider",
        model: "isolated-stt-fixture",
        modelVersion: "1",
        estimatedCostUnits: 1,
      },
      chunkSchema: sttAudioChunkSchema,
      eventSchema: sttStreamEventSchema,
      module: { modulePath, exportName: "transcribe", allowedReadPaths: [] },
    });
    const isolate = new NodePermissionAdapterIsolate();
    const transport = new RecordingEgressTransport();
    const router = isolatedRouter(registry, isolate, transport);

    const routed = [];
    for await (const item of router.streamStt(audioChunks(), context())) routed.push(item);
    const completion = routed.at(-1);

    expect(completion?.kind).toBe("complete");
    if (completion?.kind === "complete") {
      expect(completion.result).toMatchObject({
        ok: true,
        output: { text: "chunk-1", language: "ko", durationMs: 100 },
      });
    }
    expect(isolate.activeIsolates).toBe(0);
  });
});

async function* audioChunks() {
  yield { sequence: 0, audio: new Uint8Array([1]) };
  yield { sequence: 1, audio: new Uint8Array([2]) };
}
