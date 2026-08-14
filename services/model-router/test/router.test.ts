import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  type AdapterRequirement,
  createTrustedModelContext,
  type DeadlineScheduler,
  DeterministicFakeSttAdapter,
  DeterministicFakeUnaryAdapter,
  type ModelInvocationContext,
  ModelRoutingRegistry,
  type SecretStore,
  ServerModelRouter,
  StaticExactEgressPolicy,
  type TrustedModelContext,
} from "../src/index.ts";

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

function unaryAdapter(
  adapterId: string,
  respond: (
    input: { prompt: string },
    invocation: ModelInvocationContext,
  ) => { answer: string } | Promise<{ answer: string }>,
  requirement?: AdapterRequirement,
) {
  return new DeterministicFakeUnaryAdapter({
    descriptor: {
      adapterId,
      capability: "llm",
      provider: "fake",
      model: "fixed-output",
      modelVersion: "1",
      ...(requirement === undefined ? {} : { requirement }),
    },
    inputSchema: z.object({ prompt: z.string() }),
    outputSchema: z.object({ answer: z.string() }),
    respond,
  });
}

describe("routing registry", () => {
  test("resolves one deterministic default and explicit alternatives", () => {
    const registry = new ModelRoutingRegistry();
    const primary = unaryAdapter("primary", ({ prompt }) => ({ answer: prompt }));
    const secondary = unaryAdapter("secondary", ({ prompt }) => ({ answer: prompt }));

    registry.registerUnary(primary, { default: true });
    registry.registerUnary(secondary);

    expect(registry.resolveUnary("llm").descriptor.adapterId).toBe("primary");
    expect(registry.resolveUnary("llm", "secondary").descriptor.adapterId).toBe("secondary");
    expect(() => registry.registerUnary(primary)).toThrow("already registered");
    expect(() => registry.resolveUnary("ocr")).toThrow("No unary adapter");
  });

  test("registers streaming STT independently from unary STT", () => {
    const registry = new ModelRoutingRegistry();
    const stt = new DeterministicFakeSttAdapter({
      transcript: { text: "final", language: "ko", durationMs: 100 },
      events: [],
    });

    registry.registerUnary(stt);
    registry.registerStreamingStt(stt);

    expect(registry.resolveUnary("stt")).toBeDefined();
    expect(registry.resolveStreamingStt().descriptor.adapterId).toBe("deterministic-fake-stt");
  });
});

describe("server model router", () => {
  test("validates inputs and outputs while recording terminal metadata", async () => {
    const time = new ManualTime();
    const registry = new ModelRoutingRegistry();
    registry.registerUnary(
      unaryAdapter("primary", ({ prompt }) => ({ answer: prompt.toUpperCase() })),
    );
    const router = new ServerModelRouter({ registry, clock: time.now, scheduler: time });

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
    let invocationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      invocationStarted = resolve;
    });
    registry.registerUnary(
      unaryAdapter("pending", async () => {
        invocationStarted?.();
        return await new Promise<{ answer: string }>(() => undefined);
      }),
    );
    const router = new ServerModelRouter({ registry, clock: time.now, scheduler: time });

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
    registry.registerUnary(
      unaryAdapter("pending", async () => await new Promise<{ answer: string }>(() => undefined)),
    );
    const router = new ServerModelRouter({ registry, clock: time.now, scheduler: time });

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
    const adapter = unaryAdapter("never-started", () => ({ answer: "too late" }));
    registry.registerUnary(adapter);
    const router = new ServerModelRouter({ registry, clock: time.now, scheduler: time });

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
      (_input, invocation) => ({
        answer: `${invocation.providerAccess?.egress.origin}:${invocation.providerAccess?.credential}`,
      }),
      {
        secretId: "vendor/stt/service",
        egressOrigin: "https://api.vendor.example",
      },
    );
    registry.registerUnary(secured);
    const router = new ServerModelRouter({
      registry,
      clock: time.now,
      scheduler: time,
      secretStore: secrets,
      egressPolicy: policy,
    });

    const result = await router.invoke(
      { capability: "llm", input: { prompt: "secure" } },
      context(2_000),
    );

    expect(result.ok).toBe(true);
    expect(secrets.reads).toEqual(["vendor/stt/service"]);
    if (result.ok) {
      expect(result.output).toEqual({
        answer: "https://api.vendor.example:fixture-credential",
      });
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
    const secured = unaryAdapter("secured", () => ({ answer: "must not run" }), {
      secretId: "vendor/stt/service",
      egressOrigin: "https://api.vendor.example/v1",
    });
    registry.registerUnary(secured);
    const router = new ServerModelRouter({
      registry,
      clock: time.now,
      scheduler: time,
      secretStore: secrets,
      egressPolicy: new StaticExactEgressPolicy([
        { adapterId: "secured", origin: "https://api.vendor.example" },
      ]),
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
    registry.registerStreamingStt(
      new DeterministicFakeSttAdapter({
        transcript,
        events: [
          { kind: "partial", sequence: 0, transcript: { ...transcript, text: "확" } },
          { kind: "final", sequence: 1, transcript },
        ],
      }),
    );
    const router = new ServerModelRouter({ registry, clock: time.now, scheduler: time });

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

  test("cancels a streaming STT iterator before another event is requested", async () => {
    const time = new ManualTime();
    const cancellation = new AbortController();
    const registry = new ModelRoutingRegistry();
    const transcript = { text: "final", language: "ko", durationMs: 100 };
    registry.registerStreamingStt(
      new DeterministicFakeSttAdapter({
        transcript,
        events: [
          { kind: "partial", sequence: 0, transcript: { ...transcript, text: "part" } },
          { kind: "final", sequence: 1, transcript },
        ],
      }),
    );
    const router = new ServerModelRouter({ registry, clock: time.now, scheduler: time });
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
