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

const evidence = {
  evidenceId: "internal:object-1:r1",
  title: "Annual report",
  anchor: "page=4",
  content: "Revenue was 42 million USD in 2025.",
  sourceId: "source-1",
  sourceRevision: "r1",
  rights: "APPROVED",
  origin: "INTERNAL",
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
