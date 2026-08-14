import { expect, test } from "bun:test";
import {
  type ModelDispatchRequest,
  ModelRoutingRegistry,
  type PolicyVersionAuthority,
  ServerModelRouter,
  type TenantBudget,
  type TenantQuotaPolicy,
  type TrustedModelContext,
} from "@impromptu/model-router";
import { PreparedEvidenceProjectionGateway } from "@impromptu/projection-gateway";
import { z } from "zod";
import { createScriptedUnaryAdapter } from "../../model-router/src/testing.ts";
import { parsePrivateBackendConfig } from "../src/config.ts";
import { createPrivateBackendHandler } from "../src/http.ts";
import { PreparedEvidenceCoordinator } from "../src/prepared-evidence.ts";
import { InternalRetrievalService } from "../src/retrieval/internal-retrieval.ts";
import { PrivateRecommendationPipeline } from "../src/verifier/recommendation-pipeline.ts";

const origin = "https://console.example.test";
const manifestHash = "a".repeat(64);
const content = "Acme revenue was 42 million USD in 2025.";
const sourceHash = new Bun.CryptoHasher("sha256").update(content).digest("hex");
const evidenceId = "internal:object-1:r1";
const recommendationRequest = {
  query: "revenue",
  deckVersion: "deck_v1",
  manifestHash,
  maxResults: 3,
};

class ModelGates implements PolicyVersionAuthority, TenantQuotaPolicy, TenantBudget {
  #reservation = 0;
  async assertCurrent(_request: ModelDispatchRequest, _context: TrustedModelContext) {}
  async assertWithinQuota(_request: ModelDispatchRequest, _context: TrustedModelContext) {}
  async reserve(request: ModelDispatchRequest, _context: TrustedModelContext) {
    this.#reservation += 1;
    return {
      reservationId: `http-reservation-${this.#reservation}`,
      reservedUnits: request.estimatedCostUnits,
    };
  }
  async reconcile() {}
}

function modelRouter(pendingEmbedding = false): ServerModelRouter {
  const registry = new ModelRoutingRegistry();
  const outputs = {
    embedding: { vector: [0.1, 0.2] },
    rerank: { orderedEvidenceIds: [evidenceId] },
    llm: {
      claim: "Acme revenue was 42 million USD in 2025.",
      evidenceIds: [evidenceId],
      facts: {
        numbers: ["42", "2025"],
        units: ["million", "USD"],
        dates: [],
        entities: ["Acme"],
      },
    },
    verifier: { verdict: "SUPPORTED", rationaleCode: "http-harness" },
  } as const;
  for (const capability of ["embedding", "rerank", "llm", "verifier"] as const) {
    registry.registerDeterministicFakeUnary(
      createScriptedUnaryAdapter({
        descriptor: {
          adapterId: `http-${capability}`,
          capability,
          provider: "fake",
          model: `http-${capability}`,
          modelVersion: "1",
          estimatedCostUnits: 1,
        },
        inputSchema: z.unknown(),
        outputSchema: z.unknown(),
        steps:
          pendingEmbedding && capability === "embedding"
            ? [{ kind: "pending" }]
            : [{ kind: "output", output: outputs[capability] }],
      }),
    );
  }
  const gates = new ModelGates();
  return new ServerModelRouter({
    registry,
    policyVersionAuthority: gates,
    quotaPolicy: gates,
    budget: gates,
  });
}

function internalRetrieval(): InternalRetrievalService {
  return new InternalRetrievalService({
    principals: {
      async resolve() {
        return {
          tenantId: "account_http",
          principalId: "actor_http",
          groupIds: ["finance"],
          attributes: {},
        };
      },
    },
    policy: {
      async prefilter() {
        return { version: "acl-v1", current: true, authorizedObjectIds: ["object-1"] };
      },
      async authorizeObject() {
        return true;
      },
      async isCurrent() {
        return true;
      },
    },
    ann: {
      async search() {
        return [
          {
            tenantId: "account_http",
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
        return {
          tenantId: "account_http",
          objectId: "object-1",
          sourceId: "source-http",
          sourceRevision: "r1",
          sourceHash,
          deckVersion: "deck_v1",
          manifestHash,
          title: "HTTP evidence",
          anchor: "page=1",
          rights: "APPROVED",
          containsPii: false,
        };
      },
      async readContent() {
        return content;
      },
    },
  });
}

async function httpHarness(pendingEmbedding = false) {
  const coordinator = new PreparedEvidenceCoordinator(new PreparedEvidenceProjectionGateway());
  const pipeline = new PrivateRecommendationPipeline({
    router: modelRouter(pendingEmbedding),
    contexts: {
      async resolve() {
        return {
          tenantId: "account_http",
          principalId: "actor_http",
          policyVersion: "model-policy-v1",
        };
      },
    },
    internal: internalRetrieval(),
  });
  const handler = createPrivateBackendHandler(
    parsePrivateBackendConfig({ CONSOLE_ORIGIN: origin }),
    {
      coordinator,
      identityVerifier: {
        async exchangeAuthorizationCode() {
          return { accountId: "account_http", actorId: "actor_http" };
        },
      },
      internalAuthToken: "http-harness-token",
      now: Date.now,
      recommendations: pipeline,
    },
  );
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const serviceOrigin = server.url.origin;
  const signIn = await fetch(`${serviceOrigin}/v1/account-sessions`, {
    method: "POST",
    headers: { origin, referer: `${origin}/`, "content-type": "application/json" },
    body: JSON.stringify({ authorizationCode: "code" }),
  });
  const cookie = signIn.headers.get("set-cookie")?.split(";", 1)[0];
  const session = await signIn.json();
  if (cookie === undefined || typeof session.csrfToken !== "string")
    throw new Error("sign-in failed");
  const recommend = () =>
    fetch(`${serviceOrigin}/v1/recommendations`, {
      method: "POST",
      headers: {
        origin,
        referer: `${origin}/`,
        cookie,
        "content-type": "application/json",
        "x-csrf-token": session.csrfToken,
      },
      body: JSON.stringify(recommendationRequest),
    });
  return {
    recommend,
    async close() {
      await server.stop(true);
    },
  };
}

test("real loopback TCP recommendation chain meets p95 and wall-clock terminal deadline", async () => {
  const harness = await httpHarness();
  let pending: Awaited<ReturnType<typeof httpHarness>> | undefined;
  try {
    const latencies: number[] = [];
    for (let index = 0; index < 100; index += 1) {
      const startedAtMs = performance.now();
      const response = await harness.recommend();
      latencies.push(performance.now() - startedAtMs);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ outcome: "RECOMMEND" });
    }
    latencies.sort((left, right) => left - right);
    const p95 = latencies[94];
    if (p95 === undefined) throw new Error("missing p95 sample");
    console.log(JSON.stringify({ privateRecommendationTcpP95Ms: Number(p95.toFixed(3)) }));
    expect(p95).toBeLessThanOrEqual(5_000);

    pending = await httpHarness(true);
    const deadlineStartedAtMs = performance.now();
    const terminal = await pending.recommend();
    const deadlineWallMs = performance.now() - deadlineStartedAtMs;
    expect(await terminal.json()).toMatchObject({
      outcome: "ABSTAIN",
      reason: "DEADLINE_EXCEEDED",
    });
    console.log(
      JSON.stringify({ privateRecommendationTcpDeadlineWallMs: Number(deadlineWallMs.toFixed(3)) }),
    );
    expect(deadlineWallMs).toBeLessThan(5_000);
  } finally {
    await pending?.close();
    await harness.close();
  }
}, 7_000);
