import { describe, expect, test } from "bun:test";
import {
  createTrustedModelContext,
  type DeadlineScheduler,
  type ModelCapability,
  type ModelResult,
} from "@impromptu/model-router";
import { z } from "zod";
import { createRecommendationModelSlots } from "../src/verifier/recommendation-model-slots.ts";

const scheduler: DeadlineScheduler = {
  now: () => Date.now(),
  schedule: () => () => {},
};

const context = createTrustedModelContext({
  tenantId: "tenant",
  principalId: "actor",
  requestId: "request",
  traceId: "trace",
  policyVersion: "model-policy-v1",
  deadlineAtMs: Date.now() + 30_000,
  signal: AbortSignal.timeout(30_000),
});

const outputSchema = z.object({ orderedEvidenceIds: z.array(z.string()).min(1) }).strict();

function metadata(capability: ModelCapability, adapterId: string | null) {
  return {
    capability,
    adapterId,
    provider: "openai-compatible",
    model: adapterId?.endsWith("-fallback") ? "space-bunny-free" : "deepseek-v4.1-flash",
    modelVersion: "api-v1",
    policyVersion: "model-policy-v1",
    requestId: "request",
    traceId: "trace",
    startedAtMs: 0,
    completedAtMs: 1,
    latencyMs: 1,
    cacheStatus: "bypass" as const,
  };
}

function fakeRouter(steps: { primary: ModelResult<unknown>; fallback: ModelResult<unknown> }) {
  const calls: Array<{ capability: ModelCapability; adapterId: string | undefined }> = [];
  const router = {
    async invoke(request: unknown): Promise<ModelResult<unknown>> {
      const { capability, adapterId } = request as {
        capability: ModelCapability;
        adapterId?: string;
      };
      calls.push({ capability, adapterId });
      return adapterId === undefined ? steps.primary : steps.fallback;
    },
  };
  return { router, calls };
}

const retryableFailure = (capability: ModelCapability): ModelResult<unknown> => ({
  ok: false,
  error: { code: "provider_error", message: "upstream 500", retryable: true },
  metadata: metadata(capability, `openai-compatible-${capability}`),
});

const permanentFailure = (capability: ModelCapability): ModelResult<unknown> => ({
  ok: false,
  error: { code: "budget_exceeded", message: "budget", retryable: false },
  metadata: metadata(capability, `openai-compatible-${capability}`),
});

const fallbackSuccess = (capability: ModelCapability): ModelResult<unknown> => ({
  ok: true,
  output: { orderedEvidenceIds: ["ev-1"] },
  metadata: metadata(capability, `openai-compatible-${capability}-fallback`),
});

const rerankInput = {
  task: "RERANK_EVIDENCE",
  query: "revenue",
  untrustedData: [{ evidenceId: "ev-1", content: "Revenue was 42M USD." }],
};

describe("recommendation model slot fallback", () => {
  test("retries a retryable primary failure against the registered fallback adapter", async () => {
    const { router, calls } = fakeRouter({
      primary: retryableFailure("rerank"),
      fallback: fallbackSuccess("rerank"),
    });
    const slots = createRecommendationModelSlots({
      router,
      scheduler,
      fallbackAdapterIds: { rerank: "openai-compatible-rerank-fallback" },
    });

    const result = await slots.invoke("rerank", rerankInput, outputSchema, context);

    expect(result).toEqual({ ok: true, output: { orderedEvidenceIds: ["ev-1"] } });
    expect(calls).toEqual([
      { capability: "rerank", adapterId: undefined },
      { capability: "rerank", adapterId: "openai-compatible-rerank-fallback" },
    ]);
  });

  test("does not retry a non-retryable failure on the fallback adapter", async () => {
    const { router, calls } = fakeRouter({
      primary: permanentFailure("rerank"),
      fallback: fallbackSuccess("rerank"),
    });
    const slots = createRecommendationModelSlots({
      router,
      scheduler,
      fallbackAdapterIds: { rerank: "openai-compatible-rerank-fallback" },
    });

    const result = await slots.invoke("rerank", rerankInput, outputSchema, context);

    expect(result).toEqual({ ok: false, errorCode: "budget_exceeded" });
    expect(calls).toEqual([{ capability: "rerank", adapterId: undefined }]);
  });

  test("returns the primary failure when no fallback is configured", async () => {
    const { router, calls } = fakeRouter({
      primary: retryableFailure("rerank"),
      fallback: fallbackSuccess("rerank"),
    });
    const slots = createRecommendationModelSlots({ router, scheduler });

    const result = await slots.invoke("rerank", rerankInput, outputSchema, context);

    expect(result).toEqual({ ok: false, errorCode: "provider_error" });
    expect(calls).toEqual([{ capability: "rerank", adapterId: undefined }]);
  });
});
