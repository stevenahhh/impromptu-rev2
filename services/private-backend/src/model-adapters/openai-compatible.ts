import { fileURLToPath } from "node:url";
import { StructuredRecommendationSchema } from "@impromptu/contracts/retrieval";
import type { ModelCapability, ModelRoutingRegistry } from "@impromptu/model-router";
import { z } from "zod";

/**
 * Indexing embeds whole retrieval chunks, not just presenter queries, so this bound must cover
 * the chunk splitter's MAX_CHUNK_CHARACTERS in
 * `src/retrieval/postgres-deck-retrieval.ts`. While it was 500 every real deck failed to index
 * with `invalid_request`, and the Console could only ever report that no evidence was ready.
 */
const MAX_EMBEDDING_INPUT_CHARACTERS = 2_000;

const embeddingInputSchema = z
  .object({
    task: z.literal("EMBED_RETRIEVAL_QUERY"),
    query: z.string().min(1).max(MAX_EMBEDDING_INPUT_CHARACTERS),
  })
  .strict();
const untrustedEvidenceSchema = z
  .object({
    evidenceId: z.string().min(1).max(256),
    content: z.string().min(1).max(700),
  })
  .strict();
const rerankInputSchema = z
  .object({
    task: z.literal("RERANK_EVIDENCE"),
    query: z.string().min(1).max(500),
    untrustedData: z.array(untrustedEvidenceSchema).min(1).max(2),
  })
  .strict();
const llmInputSchema = z
  .object({
    task: z.literal("CREATE_STRUCTURED_RECOMMENDATION"),
    constraints: z
      .object({
        maySelectTools: z.literal(false),
        maySelectUrls: z.literal(false),
        mayAuthorize: z.literal(false),
        mayPublish: z.literal(false),
      })
      .strict(),
    query: z.string().min(1).max(500),
    untrustedData: z.array(untrustedEvidenceSchema).min(1).max(2),
  })
  .strict();
const verifierInputSchema = z
  .object({
    task: z.literal("VERIFY_RECOMMENDATION"),
    constraints: z
      .object({
        untrustedEvidence: z.literal(true),
        mayAuthorize: z.literal(false),
        mayPublish: z.literal(false),
      })
      .strict(),
    recommendation: StructuredRecommendationSchema,
    untrustedData: z.array(untrustedEvidenceSchema).min(1).max(2),
  })
  .strict();
const compactFactSchema = z.string().min(1).max(48);
const compactRecommendationSchema = z
  .object({
    claim: z.string().trim().min(1).max(320),
    evidenceIds: z.array(z.string().min(1).max(256)).length(1),
    facts: z
      .object({
        numbers: z.array(compactFactSchema).max(6),
        units: z.array(compactFactSchema).max(6),
        dates: z.array(compactFactSchema).max(6),
        entities: z.array(compactFactSchema).max(6),
      })
      .strict(),
  })
  .strict();
const compactVerifierOutputSchema = z
  .object({
    verdict: z.enum(["SUPPORTED", "INSUFFICIENT", "CONFLICTING"]),
    rationaleCode: z.string().min(1).max(48),
  })
  .strict();

const usageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative(),
    prompt_tokens_details: z
      .object({
        cached_tokens: z.number().int().nonnegative().optional(),
        cache_write_tokens: z.number().int().nonnegative().nullable().optional(),
        audio_tokens: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    completion_tokens_details: z
      .object({
        reasoning_tokens: z.number().int().nonnegative().optional(),
        audio_tokens: z.number().int().nonnegative().optional(),
        accepted_prediction_tokens: z.number().int().nonnegative().optional(),
        rejected_prediction_tokens: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const embeddingProviderResponseSchema = z
  .object({
    object: z.literal("list"),
    model: z.string().min(1),
    data: z
      .array(
        z
          .object({
            object: z.literal("embedding"),
            index: z.number().int().nonnegative(),
            embedding: z.array(z.number().finite()).length(768),
          })
          .strict(),
      )
      .length(1),
    usage: usageSchema.optional(),
  })
  .strict()
  .transform((response) => ({ vector: response.data[0]?.embedding ?? [] }));
const chatProviderResponseSchema = z
  .object({
    id: z.string().min(1),
    object: z.literal("chat.completion"),
    created: z.number().int().nonnegative(),
    model: z.string().min(1),
    choices: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            finish_reason: z.string().nullable(),
            logprobs: z.null().optional(),
            message: z
              .object({
                role: z.literal("assistant"),
                content: z.string().min(1),
                name: z.string().nullable().optional(),
                reasoning: z.string().nullable().optional(),
                reasoning_content: z.string().nullable().optional(),
                refusal: z.string().nullable().optional(),
                tool_calls: z.union([z.null(), z.array(z.never()).length(0)]).optional(),
                annotations: z.array(z.never()).optional(),
              })
              .strict(),
          })
          .strict(),
      )
      .length(1),
    usage: usageSchema.optional(),
    system_fingerprint: z.string().nullable().optional(),
    service_tier: z.string().nullable().optional(),
    cost: z
      .string()
      .regex(/^\d+(?:\.\d+)?$/)
      .optional(),
  })
  .strict();

function extractJsonObject(content: string): unknown {
  for (let start = 0; start < content.length; start += 1) {
    if (content[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let end = start; end < content.length; end += 1) {
      const character = content[end];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
      } else if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) {
        try {
          return JSON.parse(content.slice(start, end + 1));
        } catch {
          break;
        }
      }
    }
  }
  throw new SyntaxError("Provider message content does not contain a JSON object");
}

function structuredChatOutput<Output>(schema: z.ZodType<Output>): z.ZodType<Output> {
  return chatProviderResponseSchema.transform((response, context) => {
    let value: unknown;
    try {
      value = extractJsonObject(response.choices[0]?.message.content ?? "");
    } catch {
      context.addIssue({ code: "custom", message: "Provider message content is not JSON" });
      return z.NEVER;
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      context.addIssue({ code: "custom", message: "Provider message JSON has an invalid shape" });
      return z.NEVER;
    }
    return parsed.data;
  });
}

export type ReasoningEffort = "none" | "minimal" | "low" | "high" | "max";

export interface OpenAiCompatibleSlotConfig {
  readonly origin: string;
  readonly apiPrefix: string;
  readonly model: string;
  readonly secretId: string;
  readonly reasoningEffort?: ReasoningEffort;
  /** Optional second model served by the same origin/secret, registered as a non-default
   * adapter (`<slot>-fallback`) that callers may retry against on a retryable primary failure. */
  readonly modelFallback?: string | undefined;
}

export interface OpenAiCompatibleAdapterConfig {
  readonly embedding: OpenAiCompatibleSlotConfig;
  readonly rerank: OpenAiCompatibleSlotConfig;
  readonly llm: OpenAiCompatibleSlotConfig;
  readonly verifier: OpenAiCompatibleSlotConfig;
}

export interface OpenAiCompatibleAdapterBinding {
  readonly adapterId: string;
  readonly capability: ModelCapability;
  readonly origin: string;
  readonly secretId: string;
}

const modulePath = fileURLToPath(new URL("./openai-compatible.mjs", import.meta.url));

export function registerOpenAiCompatibleAdapters(
  registry: ModelRoutingRegistry,
  config: OpenAiCompatibleAdapterConfig,
): readonly OpenAiCompatibleAdapterBinding[] {
  const registrations: ReadonlyArray<{
    capability: ModelCapability;
    slot: OpenAiCompatibleSlotConfig;
    inputSchema: z.ZodType;
    outputSchema: z.ZodType;
  }> = [
    {
      capability: "embedding",
      slot: config.embedding,
      inputSchema: embeddingInputSchema,
      outputSchema: embeddingProviderResponseSchema,
    },
    {
      capability: "rerank",
      slot: config.rerank,
      inputSchema: rerankInputSchema,
      outputSchema: structuredChatOutput(
        z
          .object({
            orderedEvidenceIds: z.array(z.string().min(1).max(256)).min(1).max(2),
          })
          .strict(),
      ),
    },
    {
      capability: "llm",
      slot: config.llm,
      inputSchema: llmInputSchema,
      outputSchema: structuredChatOutput(compactRecommendationSchema),
    },
    {
      capability: "verifier",
      slot: config.verifier,
      inputSchema: verifierInputSchema,
      outputSchema: structuredChatOutput(compactVerifierOutputSchema),
    },
  ];
  const bindings: OpenAiCompatibleAdapterBinding[] = [];
  const registerSlot = (
    registration: (typeof registrations)[number],
    model: string,
    adapterId: string,
  ) => {
    const failure = registry.registerIsolatedUnary({
      descriptor: {
        adapterId,
        capability: registration.capability,
        provider: "openai-compatible",
        model,
        modelVersion: "api-v1",
        estimatedCostUnits: 1,
        requirement: {
          secretId: registration.slot.secretId,
          egressOrigin: registration.slot.origin,
        },
      },
      inputSchema: registration.inputSchema,
      outputSchema: registration.outputSchema,
      module: {
        modulePath,
        exportName: registration.capability,
        allowedReadPaths: [],
        configuration: {
          apiPrefix: registration.slot.apiPrefix,
          model,
          ...(registration.slot.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: registration.slot.reasoningEffort }),
        },
      },
    });
    if (failure !== undefined)
      throw new Error(`Failed to register ${registration.capability} adapter ${adapterId}`);
    bindings.push({
      adapterId,
      capability: registration.capability,
      origin: registration.slot.origin,
      secretId: registration.slot.secretId,
    });
  };
  for (const registration of registrations) {
    const adapterId = `openai-compatible-${registration.capability}`;
    registerSlot(registration, registration.slot.model, adapterId);
    if (registration.slot.modelFallback !== undefined) {
      // Registered non-default so the registry never resolves it implicitly; callers opt in per
      // retry. The fallback shares the primary's origin and secret.
      registerSlot(registration, registration.slot.modelFallback, `${adapterId}-fallback`);
    }
  }
  return Object.freeze(bindings.map((binding) => Object.freeze(binding)));
}
