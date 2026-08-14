import { describe, expect, test } from "bun:test";
import { RetrievedEvidenceSchema } from "@impromptu/contracts/retrieval";
import type { ModelCapability, ModelResult } from "@impromptu/model-router";
import { isTrustedModelContext } from "@impromptu/model-router";
import {
  InternalRetrievalService,
  type RetrievalObjectMetadata,
} from "../src/retrieval/internal-retrieval.ts";
import { reconcileEvidence } from "../src/verifier/deterministic-evidence.ts";
import { PrivateRecommendationPipeline } from "../src/verifier/recommendation-pipeline.ts";

const text = "Revenue was 42 million USD in 2025.";
const sourceHash = new Bun.CryptoHasher("sha256").update(text).digest("hex");
const manifestHash = "a".repeat(64);
const evidenceId = "internal:object-1:r1";
const request = { query: "revenue", deckVersion: "deck_v1", manifestHash, maxResults: 3 };

interface RouterOptions {
  readonly mismatch?: boolean;
  readonly conflicting?: boolean;
  readonly failCapability?: ModelCapability;
  readonly onVerifier?: () => void;
  readonly stageLatencyMs?: number;
}

function pipelineFixture(options: RouterOptions = {}) {
  let authorized = true;
  let now = 0;
  const calls: Array<{ capability: string; input: unknown; trusted: boolean }> = [];
  const metadata: RetrievalObjectMetadata = {
    tenantId: "tenant-a",
    objectId: "object-1",
    sourceId: "source-1",
    sourceRevision: "r1",
    sourceHash,
    deckVersion: "deck_v1",
    manifestHash,
    title: "Annual report",
    anchor: "page=4",
    rights: "APPROVED",
    containsPii: false,
  };
  const internal = new InternalRetrievalService({
    principals: {
      async resolve(sessionId) {
        return sessionId === "session-a"
          ? { tenantId: "tenant-a", principalId: "actor-a", groupIds: ["finance"], attributes: {} }
          : null;
      },
    },
    policy: {
      async prefilter() {
        return { version: "acl-v1", current: true, authorizedObjectIds: ["object-1"] };
      },
      async authorizeObject() {
        return authorized;
      },
      async isCurrent() {
        return authorized;
      },
    },
    ann: {
      async search(input) {
        expect(input.queryVector).toEqual([0.1, 0.2]);
        return [
          {
            tenantId: "tenant-a",
            objectId: "object-1",
            score: 1,
            indexedSourceHash: sourceHash,
            indexedDeckVersion: "deck_v1",
            indexedManifestHash: manifestHash,
            indexedAuthorizationVersion: "acl-v1",
          },
        ];
      },
    },
    objects: {
      async readMetadata() {
        return metadata;
      },
      async readContent() {
        return text;
      },
    },
  });
  const router = {
    async invoke(untrustedRequest: unknown, context: unknown): Promise<ModelResult<unknown>> {
      const modelRequest = untrustedRequest as { capability: ModelCapability; input: unknown };
      calls.push({
        capability: modelRequest.capability,
        input: modelRequest.input,
        trusted: isTrustedModelContext(context),
      });
      now += options.stageLatencyMs ?? 800;
      const metadata = {
        capability: modelRequest.capability,
        adapterId: `fake-${modelRequest.capability}`,
        provider: "fake",
        model: "fake",
        modelVersion: "1",
        policyVersion: "model-policy-v1",
        requestId: "request",
        traceId: "trace",
        startedAtMs: now,
        completedAtMs: now,
        latencyMs: 0,
        cacheStatus: "bypass" as const,
      };
      if (options.failCapability === modelRequest.capability) {
        return {
          ok: false,
          error: { code: "budget_exceeded", message: "budget", retryable: false },
          metadata,
        };
      }
      const output =
        modelRequest.capability === "embedding"
          ? { vector: [0.1, 0.2] }
          : modelRequest.capability === "rerank"
            ? { orderedEvidenceIds: [evidenceId] }
            : modelRequest.capability === "llm"
              ? {
                  claim: options.mismatch
                    ? "Revenue was 99 million USD in 2025."
                    : "Revenue was 42 million USD in 2025.",
                  evidenceIds: [evidenceId],
                  facts: {
                    numbers: options.mismatch ? ["99", "2025"] : ["42", "2025"],
                    units: ["million", "USD"],
                    dates: [],
                    entities: ["Revenue"],
                  },
                }
              : {
                  verdict: options.conflicting ? "CONFLICTING" : "SUPPORTED",
                  rationaleCode: "checked",
                };
      if (modelRequest.capability === "verifier") options.onVerifier?.();
      return { ok: true, output, metadata };
    },
  };
  const pipeline = new PrivateRecommendationPipeline({
    router,
    contexts: {
      async resolve(sessionId) {
        return sessionId === "session-a"
          ? { tenantId: "tenant-a", principalId: "actor-a", policyVersion: "model-policy-v1" }
          : null;
      },
    },
    internal,
    now: () => now,
    scheduler: { schedule: () => () => undefined },
  });
  return {
    pipeline,
    calls,
    revoke: () => {
      authorized = false;
    },
    get now() {
      return now;
    },
  };
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("fixture value is required");
  return value;
}

describe("private recommendation verifier", () => {
  test("routes embedding, rerank, structured LLM, and verifier inference through the server router", async () => {
    const flow = pipelineFixture();
    const result = await flow.pipeline.recommend("session-a", request);
    expect(result.outcome).toBe("RECOMMEND");
    expect(result.latencyMs).toBe(3_200);
    expect(flow.calls.map((call) => call.capability)).toEqual([
      "embedding",
      "rerank",
      "llm",
      "verifier",
    ]);
    expect(flow.calls.every((call) => call.trusted)).toBe(true);
    const llmInput = flow.calls.find((call) => call.capability === "llm")?.input;
    expect(llmInput).toMatchObject({
      constraints: {
        maySelectTools: false,
        maySelectUrls: false,
        mayAuthorize: false,
        mayPublish: false,
      },
    });
  });

  test("deterministically abstains for numeric mismatch and model-reported conflict", async () => {
    const mismatch = await pipelineFixture({ mismatch: true }).pipeline.recommend(
      "session-a",
      request,
    );
    expect(mismatch).toMatchObject({ outcome: "ABSTAIN", reason: "DETERMINISTIC_MISMATCH" });
    const conflict = await pipelineFixture({ conflicting: true }).pipeline.recommend(
      "session-a",
      request,
    );
    expect(conflict).toMatchObject({ outcome: "ABSTAIN", reason: "CONFLICTING_EVIDENCE" });
  });

  test("reconciles number, unit, date, and entity facts", () => {
    const evidence = RetrievedEvidenceSchema.parse({
      evidenceId,
      sourceId: "s",
      sourceRevision: "r",
      sourceHash,
      deckVersion: "deck_v1",
      manifestHash,
      title: "t",
      content: "Acme shipped 1,200 kg on 2025-03-04.",
      quote: "q",
      anchor: "a",
      canonicalUrl: null,
      sourceDate: null,
      rights: "APPROVED",
      containsPii: false,
      authorizationVersion: "acl-v1",
    });
    expect(
      reconcileEvidence(
        {
          claim: "Acme shipped 1200 kg on 2025-03-04.",
          evidenceIds: [evidenceId],
          facts: {
            numbers: ["1200", "2025", "03", "04"],
            units: ["kg"],
            dates: ["2025-03-04"],
            entities: ["Acme"],
          },
        },
        [evidence],
      ),
    ).toEqual({ outcome: "SUPPORTED" });
    expect(
      reconcileEvidence(
        {
          claim: "Other shipped 1200 kg on 2025-03-04.",
          evidenceIds: [evidenceId],
          facts: {
            numbers: ["1200", "2025", "03", "04"],
            units: ["kg"],
            dates: ["2025-03-04"],
            entities: ["Other"],
          },
        },
        [evidence],
      ),
    ).toMatchObject({ outcome: "MISMATCH", category: "ENTITY" });
  });

  test("fails closed on budget denial and ACL revoke during verification", async () => {
    const budget = pipelineFixture({ failCapability: "rerank" });
    expect(await budget.pipeline.recommend("session-a", request)).toMatchObject({
      outcome: "ABSTAIN",
      reason: "BUDGET_EXCEEDED",
    });

    let revoke: () => void = () => undefined;
    const revoked = pipelineFixture({ onVerifier: () => revoke() });
    revoke = revoked.revoke;
    expect(await revoked.pipeline.recommend("session-a", request)).toMatchObject({
      outcome: "ABSTAIN",
      reason: "UNAUTHORIZED",
    });
  });

  test("blocks PII and unknown-rights evidence at publication authorization", async () => {
    const flow = pipelineFixture();
    const result = await flow.pipeline.recommend("session-a", request);
    if (result.outcome !== "RECOMMEND") throw new Error("expected recommendation");
    const evidence = required(result.evidence[0]);
    expect(
      await flow.pipeline.authorizeEvidenceForPublication({ ...evidence, containsPii: true }),
    ).toBe(false);
    expect(
      await flow.pipeline.authorizeEvidenceForPublication({ ...evidence, rights: "UNKNOWN" }),
    ).toBe(false);
    expect(await flow.pipeline.authorizeEvidenceForPublication(evidence)).toBe(true);
    flow.revoke();
    expect(await flow.pipeline.authorizeEvidenceForPublication(evidence)).toBe(false);
  });

  test("terminally abstains at five seconds without timing-based test waits", async () => {
    let fireDeadline: () => void = () => undefined;
    let invokedResolve: () => void = () => undefined;
    const invoked = new Promise<void>((resolve) => {
      invokedResolve = resolve;
    });
    const pendingRouter = {
      async invoke(): Promise<ModelResult<unknown>> {
        invokedResolve();
        return await new Promise<ModelResult<unknown>>(() => undefined);
      },
    };
    const pipeline = new PrivateRecommendationPipeline({
      router: pendingRouter,
      contexts: {
        async resolve() {
          return { tenantId: "t", principalId: "p", policyVersion: "v" };
        },
      },
      internal: {} as InternalRetrievalService,
      now: () => 0,
      scheduler: {
        schedule(_deadline, run) {
          fireDeadline = run;
          return () => undefined;
        },
      },
    });
    const terminal = pipeline.recommend("session-a", request);
    await invoked;
    fireDeadline();
    expect(await terminal).toEqual({
      outcome: "ABSTAIN",
      reason: "DEADLINE_EXCEEDED",
      completedAtMs: 5_000,
      latencyMs: 5_000,
    });
  });

  test("private Console harness p95 remains below five seconds", async () => {
    const latencies: number[] = [];
    for (let index = 0; index < 100; index += 1) {
      const result = await pipelineFixture({
        stageLatencyMs: 1_100 + (index % 2) * 10,
      }).pipeline.recommend("session-a", request);
      expect(result.outcome).toBe("RECOMMEND");
      latencies.push(result.latencyMs);
    }
    latencies.sort((left, right) => left - right);
    expect(latencies[94]).toBe(4_440);
    expect(required(latencies[94])).toBeLessThanOrEqual(5_000);
  });
});
