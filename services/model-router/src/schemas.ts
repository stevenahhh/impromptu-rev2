import { z } from "zod";

export const MODEL_CAPABILITIES = [
  "stt",
  "ocr",
  "vlm",
  "embedding",
  "rerank",
  "llm",
  "verifier",
  "dlp-pii",
  "coaching",
  "report-summary",
] as const;

export const modelCapabilitySchema = z.enum(MODEL_CAPABILITIES);
export type ModelCapability = z.infer<typeof modelCapabilitySchema>;

export const modelErrorCodeSchema = z.enum([
  "cancelled",
  "deadline_exceeded",
  "invalid_request",
  "unsupported_capability",
  "policy_denied",
  "policy_version_mismatch",
  "quota_exceeded",
  "budget_exceeded",
  "secret_unavailable",
  "transport_error",
  "provider_error",
]);
export type ModelErrorCode = z.infer<typeof modelErrorCodeSchema>;

export const modelErrorSchema = z
  .object({
    code: modelErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
    details: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type ModelError = z.infer<typeof modelErrorSchema>;

export const modelResultMetadataSchema = z
  .object({
    capability: modelCapabilitySchema.nullable(),
    adapterId: z.string().min(1).nullable(),
    provider: z.string().min(1).nullable(),
    model: z.string().min(1).nullable(),
    modelVersion: z.string().min(1).nullable(),
    policyVersion: z.string().min(1),
    requestId: z.string().min(1),
    traceId: z.string().min(1),
    startedAtMs: z.number().finite().nonnegative(),
    completedAtMs: z.number().finite().nonnegative(),
    latencyMs: z.number().finite().nonnegative(),
    cacheStatus: z.enum(["hit", "miss", "bypass"]),
  })
  .strict()
  .superRefine((metadata, context) => {
    if (metadata.completedAtMs < metadata.startedAtMs) {
      context.addIssue({
        code: "custom",
        message: "completedAtMs must not precede startedAtMs",
        path: ["completedAtMs"],
      });
    }
    if (metadata.latencyMs !== metadata.completedAtMs - metadata.startedAtMs) {
      context.addIssue({
        code: "custom",
        message: "latencyMs must equal completedAtMs - startedAtMs",
        path: ["latencyMs"],
      });
    }
  });
export type ModelResultMetadata = z.infer<typeof modelResultMetadataSchema>;

export function modelSuccessSchema<OutputSchema extends z.ZodType>(outputSchema: OutputSchema) {
  return z
    .object({
      ok: z.literal(true),
      output: outputSchema,
      metadata: modelResultMetadataSchema,
    })
    .strict();
}

export const modelFailureSchema = z
  .object({
    ok: z.literal(false),
    error: modelErrorSchema,
    metadata: modelResultMetadataSchema,
  })
  .strict();

export function modelResultSchema<OutputSchema extends z.ZodType>(outputSchema: OutputSchema) {
  return z.union([modelSuccessSchema(outputSchema), modelFailureSchema]);
}

export interface ModelSuccess<Output> {
  readonly ok: true;
  readonly output: Output;
  readonly metadata: ModelResultMetadata;
}

export interface ModelFailure {
  readonly ok: false;
  readonly error: ModelError;
  readonly metadata: ModelResultMetadata;
}

export type ModelResult<Output> = ModelSuccess<Output> | ModelFailure;
