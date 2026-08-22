import { describe, expect, test } from "bun:test";
import type { ModelCapability, ModelResult } from "@impromptu/model-router";
import type { InternalRetrievalService } from "../src/retrieval/internal-retrieval.ts";
import { PrivateRecommendationPipeline } from "../src/verifier/recommendation-pipeline.ts";

/**
 * The parallel rerank/llm pair is the only part of the pipeline that must survive one slow
 * provider call, so these cases drive it directly with controllable model promises and a manual
 * scheduler. Nothing waits on wall-clock time: the hedge trigger is a scheduler callback the test
 * fires itself, and the only timers present are bounded failure deadlines.
 */

const hex = (seed: string) => seed.repeat(64).slice(0, 64);

/** Shaped exactly as RetrievedEvidenceSchema demands so a successful run survives outcome parsing. */
const evidence = {
  evidenceId: "internal:object-1:r1",
  sourceId: "source-1",
  sourceRevision: "r1",
  sourceHash: hex("a"),
  deckVersion: `deck_${hex("b")}`,
  manifestHash: hex("c"),
  title: "Annual report",
  content: "Revenue was 42 million USD in 2025.",
  quote: "Revenue was 42 million USD in 2025.",
  anchor: "page=4",
  canonicalUrl: null,
  sourceDate: null,
  rights: "APPROVED",
  containsPii: false,
  authorizationVersion: "acl-v1",
};

const request = {
  query: "revenue",
  deckVersion: "deck_v1",
  manifestHash: "a".repeat(64),
  maxResults: 3,
};

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Bounded failure deadline: it can only turn a hang into a readable failure, never into a pass. */
function bounded<Value>(promise: Promise<Value>, label: string): Promise<Value> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(label + " never happened")), 2_000);
      void promise.finally(() => clearTimeout(timer));
    }),
  ]);
}

function metadataFor(capability: ModelCapability) {
  return {
    capability,
    adapterId: "fake-" + capability,
    provider: "fake",
    model: "fake",
    modelVersion: "1",
    policyVersion: "model-policy-v1",
    requestId: "request",
    traceId: "trace",
    startedAtMs: 0,
    completedAtMs: 0,
    latencyMs: 0,
    cacheStatus: "bypass" as const,
  };
}

/** A pipeline whose llm slot stays pending until the test releases it. */
function hedgeFixture() {
  const calls: ModelCapability[] = [];
  const scheduled: Array<{ atMs: number; run: () => void }> = [];
  const llmFirstInvoked = deferred<void>();
  const llmSecondInvoked = deferred<void>();
  const llmRelease = deferred<void>();
  let llmInvocations = 0;

  const router = {
    async invoke(untrusted: unknown): Promise<ModelResult<unknown>> {
      const modelRequest = untrusted as { capability: ModelCapability };
      calls.push(modelRequest.capability);
      if (modelRequest.capability === "llm") {
        llmInvocations += 1;
        if (llmInvocations === 1) llmFirstInvoked.resolve();
        if (llmInvocations === 2) llmSecondInvoked.resolve();
        await llmRelease.promise;
      }
      const output =
        modelRequest.capability === "embedding"
          ? { vector: [0.5] }
          : modelRequest.capability === "rerank"
            ? { orderedEvidenceIds: ["e1"] }
            : { unparseable: true };
      return {
        ok: true,
        output,
        metadata: metadataFor(modelRequest.capability),
      } as unknown as ModelResult<unknown>;
    },
  };

  const internal = {
    async retrieve() {
      return [{ objectId: "object-1" }];
    },
    async materialize() {
      return { outcome: "MATERIALIZED", evidence };
    },
    async authorizeForPublication() {
      return true;
    },
  } as unknown as InternalRetrievalService;

  const pipeline = new PrivateRecommendationPipeline({
    router,
    contexts: {
      async resolve() {
        return { tenantId: "tenant-a", principalId: "actor-a", policyVersion: "model-policy-v1" };
      },
    },
    internal,
    now: () => 0,
    scheduler: {
      schedule(atMs: number, run: () => void) {
        scheduled.push({ atMs, run });
        return () => undefined;
      },
    },
  });

  return { pipeline, calls, scheduled, llmFirstInvoked, llmSecondInvoked, llmRelease };
}

/** recommend() schedules its terminal abort at deadlineAtMs minus the 500ms guard. */
const DEADLINE_CALLBACK_AT_MS = 4_500;

describe("recommendation slot hedging", () => {
  test("starts exactly one duplicate llm call once the hedge trigger fires", async () => {
    const flow = hedgeFixture();
    const outcome = flow.pipeline.recommend("session-a", request);
    await bounded(flow.llmFirstInvoked.promise, "llm primary invocation");

    const hedgeTriggers = flow.scheduled.filter((entry) => entry.atMs !== DEADLINE_CALLBACK_AT_MS);
    expect(hedgeTriggers.length).toBeGreaterThan(0);
    for (const trigger of hedgeTriggers) trigger.run();

    await bounded(flow.llmSecondInvoked.promise, "llm hedge invocation");
    expect(flow.calls.filter((capability) => capability === "llm").length).toBe(2);

    flow.llmRelease.resolve();
    await outcome;
    for (const trigger of hedgeTriggers) trigger.run();
    expect(flow.calls.filter((capability) => capability === "llm").length).toBe(2);
  });

  test("never duplicates a slot when the primary settles before the hedge trigger", async () => {
    const flow = hedgeFixture();
    flow.llmRelease.resolve();
    await flow.pipeline.recommend("session-a", request);
    expect(flow.calls.filter((capability) => capability === "llm").length).toBe(1);
    expect(flow.calls.filter((capability) => capability === "rerank").length).toBe(1);
  });
});

/** A pipeline whose verifier slot stays pending until the test releases it. */
function verifierFixture() {
  const calls: ModelCapability[] = [];
  const scheduled: Array<{ atMs: number; run: () => void }> = [];
  const verifierFirstInvoked = deferred<void>();
  const verifierSecondInvoked = deferred<void>();
  const verifierRelease = deferred<void>();
  let verifierInvocations = 0;

  const router = {
    async invoke(untrusted: unknown): Promise<ModelResult<unknown>> {
      const modelRequest = untrusted as { capability: ModelCapability };
      calls.push(modelRequest.capability);
      if (modelRequest.capability === "verifier") {
        verifierInvocations += 1;
        if (verifierInvocations === 1) verifierFirstInvoked.resolve();
        if (verifierInvocations === 2) verifierSecondInvoked.resolve();
        await verifierRelease.promise;
      }
      const output =
        modelRequest.capability === "embedding"
          ? { vector: [0.5] }
          : modelRequest.capability === "rerank"
            ? { orderedEvidenceIds: ["e1"] }
            : modelRequest.capability === "llm"
              ? {
                  claim: "Revenue was 42 million USD in 2025.",
                  evidenceIds: ["e1"],
                  facts: { numbers: [], units: [], dates: [], entities: [] },
                }
              : { verdict: "SUPPORTED", rationaleCode: "ok" };
      return {
        ok: true,
        output,
        metadata: metadataFor(modelRequest.capability),
      } as unknown as ModelResult<unknown>;
    },
  };

  const internal = {
    async retrieve() {
      return [{ objectId: "object-1" }];
    },
    async materialize() {
      return { outcome: "MATERIALIZED", evidence };
    },
    async authorizeForPublication() {
      return true;
    },
  } as unknown as InternalRetrievalService;

  const pipeline = new PrivateRecommendationPipeline({
    router,
    contexts: {
      async resolve() {
        return { tenantId: "tenant-a", principalId: "actor-a", policyVersion: "model-policy-v1" };
      },
    },
    internal,
    now: () => 0,
    scheduler: {
      schedule(atMs: number, run: () => void) {
        scheduled.push({ atMs, run });
        return () => undefined;
      },
    },
  });

  return {
    pipeline,
    calls,
    scheduled,
    verifierFirstInvoked,
    verifierSecondInvoked,
    verifierRelease,
  };
}

describe("verifier slot hedging", () => {
  test("starts exactly one duplicate verifier call once its hedge trigger fires", async () => {
    const flow = verifierFixture();
    const outcome = flow.pipeline.recommend("session-a", request);
    await bounded(flow.verifierFirstInvoked.promise, "verifier primary invocation");

    const triggers = flow.scheduled.filter((entry) => entry.atMs !== DEADLINE_CALLBACK_AT_MS);
    expect(triggers.length).toBeGreaterThan(0);
    for (const trigger of triggers) trigger.run();

    await bounded(flow.verifierSecondInvoked.promise, "verifier hedge invocation");
    expect(flow.calls.filter((capability) => capability === "verifier").length).toBe(2);

    flow.verifierRelease.resolve();
    await outcome;
    for (const trigger of triggers) trigger.run();
    expect(flow.calls.filter((capability) => capability === "verifier").length).toBe(2);
  });
});

/**
 * The model only ever sees the first MAX_MODEL_EVIDENCE entries and the internal set is placed
 * ahead of the external one, so once internal retrieval has filled those slots the external branch
 * cannot reach the model, the deterministic reconciliation, or the selected evidence. Waiting for
 * it there only spends budget the model stages need.
 */
describe("external branch on the critical path", () => {
  test("runs the model pair while an unfinished external branch is still outstanding", async () => {
    const calls: ModelCapability[] = [];
    const rerankInvoked = deferred<void>();
    const router = {
      async invoke(untrusted: unknown): Promise<ModelResult<unknown>> {
        const modelRequest = untrusted as { capability: ModelCapability };
        calls.push(modelRequest.capability);
        if (modelRequest.capability === "rerank") rerankInvoked.resolve();
        const output =
          modelRequest.capability === "embedding"
            ? { vector: [0.5] }
            : modelRequest.capability === "rerank"
              ? { orderedEvidenceIds: ["e1"] }
              : modelRequest.capability === "llm"
                ? {
                    claim: evidence.content,
                    evidenceIds: ["e1"],
                    facts: { numbers: [], units: [], dates: [], entities: [] },
                  }
                : { verdict: "SUPPORTED", rationaleCode: "ok" };
        return {
          ok: true,
          output,
          metadata: metadataFor(modelRequest.capability),
        } as unknown as ModelResult<unknown>;
      },
    };
    const second = { ...evidence, evidenceId: "internal:object-2:r1" };
    let materialized = 0;
    const internal = {
      async retrieve() {
        return [{ objectId: "object-1" }, { objectId: "object-2" }];
      },
      async materialize() {
        materialized += 1;
        return { outcome: "MATERIALIZED", evidence: materialized === 1 ? evidence : second };
      },
      async authorizeForPublication() {
        return true;
      },
    } as unknown as InternalRetrievalService;

    const pipeline = new PrivateRecommendationPipeline({
      router,
      contexts: {
        async resolve() {
          return { tenantId: "tenant-a", principalId: "actor-a", policyVersion: "model-policy-v1" };
        },
      },
      internal,
      now: () => 0,
      scheduler: { schedule: () => () => undefined },
      // Never settles, so the pair can only start if the pipeline stopped waiting for it.
      externalSearch: {
        async search() {
          return await new Promise(() => undefined);
        },
      } as never,
      externalFetch: {
        async fetchCandidate() {
          return await new Promise(() => undefined);
        },
      } as never,
    });

    void pipeline.recommend("session-a", request);
    await bounded(rerankInvoked.promise, "rerank invocation while the external branch is pending");
    expect(calls).toContain("rerank");
    expect(calls).toContain("llm");
  });
});
