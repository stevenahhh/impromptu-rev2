import { describe, expect, test } from "bun:test";
import {
  createTrustedModelContext,
  ModelRoutingRegistry,
  NodePermissionAdapterIsolate,
  type ProviderEgressTransportRequest,
  ServerModelRouter,
  StaticExactEgressPolicy,
  StaticPolicyVersionAuthority,
} from "@impromptu/model-router";
import {
  type OpenAiCompatibleAdapterBinding,
  registerOpenAiCompatibleAdapters,
} from "../src/model-adapters/openai-compatible.ts";

const evidenceId = "internal:object:revision";
const chatOrigin = "https://opencode.example";
const embeddingOrigin = "https://embedding.example";
const embeddingVector = Array.from({ length: 768 }, (_, index) => (index === 0 ? 0.25 : 0.75));

function adapterConfig() {
  return {
    embedding: {
      origin: embeddingOrigin,
      apiPrefix: "/v1",
      model: "embed-model",
      secretId: "embedding-model-api-key",
    },
    rerank: {
      origin: chatOrigin,
      apiPrefix: "/zen/go/v1",
      model: "deepseek-v4-flash",
      secretId: "rerank-model-api-key",
      reasoningEffort: "minimal" as const,
    },
    llm: {
      origin: chatOrigin,
      apiPrefix: "/zen/go/v1",
      model: "deepseek-v4-flash",
      secretId: "llm-model-api-key",
      reasoningEffort: "high" as const,
    },
    verifier: {
      origin: chatOrigin,
      apiPrefix: "/zen/go/v1",
      model: "deepseek-v4-flash",
      secretId: "verifier-model-api-key",
      reasoningEffort: "minimal" as const,
    },
  };
}

function recommendation() {
  return {
    claim: "Revenue was 42 USD in 2025.",
    evidenceIds: [evidenceId],
    facts: { numbers: ["42", "2025"], units: ["USD"], dates: [], entities: [] },
  };
}

function providerResponse(
  request: ProviderEgressTransportRequest,
  contentPrefix = "",
  reasoningField: "reasoning" | "reasoning_content" = "reasoning",
): unknown {
  if (request.url.endsWith("/v1/embeddings")) {
    return {
      object: "list",
      model: "embed-model",
      data: [{ object: "embedding", index: 0, embedding: embeddingVector }],
      usage: { prompt_tokens: 2, total_tokens: 2 },
    };
  }
  const body = JSON.parse(new TextDecoder().decode(request.body));
  const userInput = JSON.parse(body.messages[1].content);
  const content =
    userInput.task === "RERANK_EVIDENCE"
      ? { orderedEvidenceIds: [evidenceId] }
      : userInput.task === "CREATE_STRUCTURED_RECOMMENDATION"
        ? recommendation()
        : { verdict: "SUPPORTED", rationaleCode: "grounded" };
  return {
    id: "chat-1",
    object: "chat.completion",
    created: 1,
    model: body.model,
    cost: "0",
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: null },
    },
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          name: null,
          [reasoningField]: "private reasoning",
          content: `${contentPrefix}${JSON.stringify(content)}`,
          tool_calls: [],
        },
      },
    ],
  };
}

function router(
  registry: ModelRoutingRegistry,
  bindings: readonly OpenAiCompatibleAdapterBinding[],
  requests: ProviderEgressTransportRequest[],
  contentPrefix = "",
  reasoningField: "reasoning" | "reasoning_content" = "reasoning",
) {
  return new ServerModelRouter({
    registry,
    adapterIsolate: new NodePermissionAdapterIsolate(),
    policyVersionAuthority: new StaticPolicyVersionAuthority("policy-1"),
    quotaPolicy: { async assertWithinQuota() {} },
    budget: {
      async reserve() {
        return { reservationId: crypto.randomUUID(), reservedUnits: 1 };
      },
      async reconcile() {},
    },
    secretStore: {
      async read(secretId) {
        if (secretId === "embedding-model-api-key") return { value: "embedding-secret" };
        if (
          secretId === "rerank-model-api-key" ||
          secretId === "llm-model-api-key" ||
          secretId === "verifier-model-api-key"
        ) {
          return { value: "chat-secret" };
        }
        throw new Error("unknown test secret");
      },
    },
    egressPolicy: new StaticExactEgressPolicy(
      bindings.map(({ adapterId, origin }) => ({ adapterId, origin })),
    ),
    providerTransport: {
      async send(request) {
        requests.push(request);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: new TextEncoder().encode(
            JSON.stringify(providerResponse(request, contentPrefix, reasoningField)),
          ),
        };
      },
    },
  });
}

function context() {
  const now = Date.now();
  return createTrustedModelContext({
    tenantId: "tenant-1",
    principalId: "principal-1",
    policyVersion: "policy-1",
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    deadlineAtMs: now + 5_000,
    signal: new AbortController().signal,
  });
}

const evidence = [{ evidenceId, content: "Revenue was 42 USD in 2025." }];
const llmInput = (query: string) => ({
  task: "CREATE_STRUCTURED_RECOMMENDATION" as const,
  constraints: {
    maySelectTools: false as const,
    maySelectUrls: false as const,
    mayAuthorize: false as const,
    mayPublish: false as const,
  },
  query,
  untrustedData: evidence,
});
const verifierInput = {
  task: "VERIFY_RECOMMENDATION" as const,
  constraints: {
    untrustedEvidence: true as const,
    mayAuthorize: false as const,
    mayPublish: false as const,
  },
  recommendation: recommendation(),
  untrustedData: evidence,
};

describe("OpenAI-compatible isolated adapters", () => {
  test("keeps slot descriptors, exact origins, credentials, and reasoning settings independent", async () => {
    const registry = new ModelRoutingRegistry();
    const bindings = registerOpenAiCompatibleAdapters(registry, adapterConfig());
    const requests: ProviderEgressTransportRequest[] = [];
    const modelRouter = router(registry, bindings, requests);

    const results = await Promise.all([
      modelRouter.invoke(
        { capability: "embedding", input: { task: "EMBED_RETRIEVAL_QUERY", query: "revenue" } },
        context(),
      ),
      modelRouter.invoke(
        {
          capability: "rerank",
          input: { task: "RERANK_EVIDENCE", query: "revenue", untrustedData: evidence },
        },
        context(),
      ),
      modelRouter.invoke({ capability: "llm", input: llmInput("revenue") }, context()),
      modelRouter.invoke({ capability: "verifier", input: verifierInput }, context()),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(results[0]).toMatchObject({ ok: true, output: { vector: embeddingVector } });
    expect(results[1]).toMatchObject({ ok: true, output: { orderedEvidenceIds: [evidenceId] } });
    expect(results[3]).toMatchObject({ ok: true, output: { verdict: "SUPPORTED" } });
    expect(bindings.map(({ adapterId }) => adapterId)).toEqual([
      "openai-compatible-embedding",
      "openai-compatible-rerank",
      "openai-compatible-llm",
      "openai-compatible-verifier",
    ]);
    expect(new Set(bindings.map(({ secretId }) => secretId)).size).toBe(4);
    expect(registry.resolveUnary("embedding").descriptor.requirement).toEqual({
      secretId: "embedding-model-api-key",
      egressOrigin: embeddingOrigin,
    });
    for (const capability of ["rerank", "llm", "verifier"] as const) {
      expect(registry.resolveUnary(capability).descriptor).toMatchObject({
        adapterId: `openai-compatible-${capability}`,
        capability,
        model: "deepseek-v4-flash",
        requirement: {
          secretId: `${capability}-model-api-key`,
          egressOrigin: chatOrigin,
        },
      });
    }

    expect(requests).toHaveLength(4);
    const embeddingRequest = requests.find((request) => request.adapterId.endsWith("embedding"));
    expect(embeddingRequest).toMatchObject({ credential: "embedding-secret" });
    expect(new URL(embeddingRequest?.url ?? "").origin).toBe(embeddingOrigin);
    const chatRequests = requests.filter((request) => !request.adapterId.endsWith("embedding"));
    expect(chatRequests).toHaveLength(3);
    expect(
      chatRequests.every(
        (request) =>
          request.credential === "chat-secret" && new URL(request.url).origin === chatOrigin,
      ),
    ).toBe(true);
    const bodies = Object.fromEntries(
      chatRequests.map((request) => [
        request.adapterId,
        JSON.parse(new TextDecoder().decode(request.body)),
      ]),
    );
    expect(bodies["openai-compatible-rerank"].reasoning_effort).toBe("minimal");
    expect(bodies["openai-compatible-llm"].reasoning_effort).toBe("high");
    expect(bodies["openai-compatible-verifier"].reasoning_effort).toBe("minimal");
    expect(bodies["openai-compatible-rerank"].max_completion_tokens).toBe(256);
    expect(bodies["openai-compatible-llm"].max_completion_tokens).toBe(512);
    expect(bodies["openai-compatible-verifier"].max_completion_tokens).toBe(256);
    expect(
      chatRequests.every((request) => {
        const responseFormat = bodies[request.adapterId].response_format;
        return (
          responseFormat.type === "json_schema" &&
          responseFormat.json_schema.strict === true &&
          responseFormat.json_schema.schema.additionalProperties === false
        );
      }),
    ).toBe(true);
    expect(
      chatRequests.every(
        (request) => new URL(request.url).pathname === "/zen/go/v1/chat/completions",
      ),
    ).toBe(true);
  });

  test("builds a fresh single-turn payload across repeated and cross-slot calls", async () => {
    const registry = new ModelRoutingRegistry();
    const bindings = registerOpenAiCompatibleAdapters(registry, adapterConfig());
    const requests: ProviderEgressTransportRequest[] = [];
    const modelRouter = router(registry, bindings, requests);

    await modelRouter.invoke(
      { capability: "llm", input: llmInput("first-turn-marker") },
      context(),
    );
    await modelRouter.invoke(
      { capability: "llm", input: llmInput("second-turn-marker") },
      context(),
    );
    await modelRouter.invoke({ capability: "verifier", input: verifierInput }, context());

    const payloads = requests.map((request) => JSON.parse(new TextDecoder().decode(request.body)));
    expect(payloads).toHaveLength(3);
    expect(payloads.every((payload) => payload.messages.length === 2)).toBe(true);
    expect(
      payloads.every(
        (payload) =>
          payload.messages.map(({ role }: { role: string }) => role).join(",") === "system,user",
      ),
    ).toBe(true);
    expect(payloads[0].messages[1].content).toContain("first-turn-marker");
    expect(payloads[1].messages[1].content).toContain("second-turn-marker");
    expect(payloads[1].messages[1].content).not.toContain("first-turn-marker");
    expect(payloads[2].messages[1].content).not.toContain("first-turn-marker");
    expect(payloads[2].messages[1].content).not.toContain("second-turn-marker");
  });

  test("accepts the Go response reasoning field under strict validation", async () => {
    const registry = new ModelRoutingRegistry();
    const bindings = registerOpenAiCompatibleAdapters(registry, adapterConfig());
    const requests: ProviderEgressTransportRequest[] = [];
    const result = await router(registry, bindings, requests, "Reasoning complete.\n").invoke(
      { capability: "llm", input: llmInput("revenue") },
      context(),
    );
    expect(result).toMatchObject({ ok: true, output: recommendation() });
  });

  test("continues to accept the legacy reasoning_content response field", async () => {
    const registry = new ModelRoutingRegistry();
    const bindings = registerOpenAiCompatibleAdapters(registry, adapterConfig());
    const requests: ProviderEgressTransportRequest[] = [];
    const result = await router(registry, bindings, requests, "", "reasoning_content").invoke(
      { capability: "llm", input: llmInput("revenue") },
      context(),
    );
    expect(result).toMatchObject({ ok: true, output: recommendation() });
  });

  test("fails closed when a provider response contains unknown fields", async () => {
    const registry = new ModelRoutingRegistry();
    const bindings = registerOpenAiCompatibleAdapters(registry, adapterConfig());
    const modelRouter = new ServerModelRouter({
      registry,
      adapterIsolate: new NodePermissionAdapterIsolate(),
      policyVersionAuthority: new StaticPolicyVersionAuthority("policy-1"),
      quotaPolicy: { async assertWithinQuota() {} },
      budget: {
        async reserve() {
          return { reservationId: "one", reservedUnits: 1 };
        },
        async reconcile() {},
      },
      secretStore: {
        async read() {
          return { value: "embedding-secret" };
        },
      },
      egressPolicy: new StaticExactEgressPolicy(
        bindings.map(({ adapterId, origin }) => ({ adapterId, origin })),
      ),
      providerTransport: {
        async send(request) {
          const raw = providerResponse(request);
          if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
            throw new Error("expected object provider fixture");
          }
          return {
            status: 200,
            headers: {},
            body: new TextEncoder().encode(JSON.stringify({ ...raw, unexpected: true })),
          };
        },
      },
    });
    const result = await modelRouter.invoke(
      { capability: "embedding", input: { task: "EMBED_RETRIEVAL_QUERY", query: "revenue" } },
      context(),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "provider_error" } });
  });
});
