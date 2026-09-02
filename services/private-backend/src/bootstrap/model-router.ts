import {
  FetchProviderEgressTransport,
  ModelRoutingRegistry,
  NodePermissionAdapterIsolate,
  ServerModelRouter,
  StaticExactEgressPolicy,
  StaticPolicyVersionAuthority,
} from "@impromptu/model-router";
import { registerOpenAiCompatibleAdapters } from "../model-adapters/openai-compatible.ts";
import {
  registerWhisperCppStreamingStt,
  verifyWhisperCppInstallation,
  WhisperCppAdapterIsolate,
} from "../model-adapters/stt-whisper-cpp.ts";
import type { WhisperCppPaths } from "./env.ts";
import { apiPrefix, credentialFreeHttpsBaseUrl, optionalWhisperCppPaths, required } from "./env.ts";

export type { WhisperCppPaths };
export { optionalWhisperCppPaths };

/**
 * Builds the trusted model router: adapter registration (whisper.cpp when pinned locally,
 * OpenAI-compatible endpoints otherwise), a pass-through budget, and an exact egress allowlist.
 */
export async function createModelRouter(
  whisperPaths: WhisperCppPaths | null,
): Promise<ServerModelRouter> {
  const chatModelApiKey = required("CHAT_MODEL_API_KEY");
  const embeddingModelApiKey = required("EMBEDDING_MODEL_API_KEY");
  const chatModelBaseUrl = credentialFreeHttpsBaseUrl("CHAT_MODEL_BASE_URL");
  const embeddingModelBaseUrl = credentialFreeHttpsBaseUrl("EMBEDDING_MODEL_BASE_URL");
  const modelRegistry = new ModelRoutingRegistry();
  const chatModel = {
    origin: chatModelBaseUrl.origin,
    apiPrefix: apiPrefix(chatModelBaseUrl),
    model: required("LLM_MODEL"),
  };
  // Local capture is an optional deployment capability. Without a pinned whisper.cpp installation the
  // service still composes and every /v1/audio route stays closed, instead of refusing to boot at all.
  if (whisperPaths !== null) {
    await verifyWhisperCppInstallation(whisperPaths);
    registerWhisperCppStreamingStt(modelRegistry, whisperPaths);
  }
  const modelAdapterBindings = registerOpenAiCompatibleAdapters(modelRegistry, {
    embedding: {
      origin: embeddingModelBaseUrl.origin,
      apiPrefix: apiPrefix(embeddingModelBaseUrl),
      model: required("EMBEDDING_MODEL"),
      secretId: "embedding-model-api-key",
    },
    rerank: {
      ...chatModel,
      model: required("RERANK_MODEL"),
      secretId: "rerank-model-api-key",
      reasoningEffort: "none",
    },
    llm: { ...chatModel, secretId: "llm-model-api-key", reasoningEffort: "none" },
    verifier: {
      ...chatModel,
      model: required("VERIFIER_MODEL"),
      secretId: "verifier-model-api-key",
      reasoningEffort: "none",
    },
  });
  const modelBudget = {
    async reserve(request: { readonly estimatedCostUnits: number }) {
      return { reservationId: crypto.randomUUID(), reservedUnits: request.estimatedCostUnits };
    },
    async reconcile() {},
  };
  return new ServerModelRouter({
    registry: modelRegistry,
    adapterIsolate: new WhisperCppAdapterIsolate(new NodePermissionAdapterIsolate()),
    policyVersionAuthority: new StaticPolicyVersionAuthority("model-policy-v1"),
    quotaPolicy: { async assertWithinQuota() {} },
    budget: modelBudget,
    secretStore: {
      async read(secretId) {
        if (secretId === "embedding-model-api-key") return { value: embeddingModelApiKey };
        if (
          secretId === "rerank-model-api-key" ||
          secretId === "llm-model-api-key" ||
          secretId === "verifier-model-api-key"
        ) {
          return { value: chatModelApiKey };
        }
        throw new Error("Unknown model credential");
      },
    },
    egressPolicy: new StaticExactEgressPolicy(
      modelAdapterBindings.map(({ adapterId, origin }) => ({ adapterId, origin })),
    ),
    providerTransport: new FetchProviderEgressTransport(),
  });
}
