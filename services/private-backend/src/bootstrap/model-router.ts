import {
  FetchProviderEgressTransport,
  type ModelCapability,
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

/** Optional per-slot fallback model ids; an empty value registers no fallback adapter. */
function optionalModelFallback(name: string): string | undefined {
  const value = Bun.env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

export interface ModelRouterComposition {
  readonly router: ServerModelRouter;
  /** Registered non-default adapter ids keyed by capability, for retry-after-failure dispatch. */
  readonly fallbackAdapterIds: Partial<Record<ModelCapability, string>>;
}

/**
 * Builds the trusted model router: adapter registration (whisper.cpp when pinned locally,
 * OpenAI-compatible endpoints otherwise), a pass-through budget, and an exact egress allowlist.
 */
export async function createModelRouter(
  whisperPaths: WhisperCppPaths | null,
): Promise<ModelRouterComposition> {
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
      modelFallback: optionalModelFallback("EMBEDDING_MODEL_FALLBACK"),
    },
    rerank: {
      ...chatModel,
      model: required("RERANK_MODEL"),
      secretId: "rerank-model-api-key",
      reasoningEffort: "none",
      modelFallback: optionalModelFallback("RERANK_MODEL_FALLBACK"),
    },
    llm: {
      ...chatModel,
      secretId: "llm-model-api-key",
      reasoningEffort: "none",
      modelFallback: optionalModelFallback("LLM_MODEL_FALLBACK"),
    },
    verifier: {
      ...chatModel,
      model: required("VERIFIER_MODEL"),
      secretId: "verifier-model-api-key",
      reasoningEffort: "none",
      modelFallback: optionalModelFallback("VERIFIER_MODEL_FALLBACK"),
    },
  });
  const fallbackAdapterIds: Partial<Record<ModelCapability, string>> = {};
  for (const binding of modelAdapterBindings) {
    if (binding.adapterId.endsWith("-fallback")) {
      fallbackAdapterIds[binding.capability] = binding.adapterId;
    }
  }
  const modelBudget = {
    async reserve(request: { readonly estimatedCostUnits: number }) {
      return { reservationId: crypto.randomUUID(), reservedUnits: request.estimatedCostUnits };
    },
    async reconcile() {},
  };
  return {
    router: new ServerModelRouter({
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
    }),
    fallbackAdapterIds,
  };
}
