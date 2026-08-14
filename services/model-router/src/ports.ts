import { z } from "zod";
import type { TrustedModelContext } from "./context.ts";
import { modelCapabilitySchema } from "./schemas.ts";

export interface Schema<T> {
  parse(value: unknown): T;
}

export const adapterRequirementSchema = z
  .object({
    secretId: z.string().min(1),
    egressOrigin: z.string().min(1),
  })
  .strict();
export type AdapterRequirement = z.infer<typeof adapterRequirementSchema>;

export const modelAdapterDescriptorSchema = z
  .object({
    adapterId: z.string().min(1),
    capability: modelCapabilitySchema,
    provider: z.string().min(1),
    model: z.string().min(1),
    modelVersion: z.string().min(1),
    estimatedCostUnits: z.number().finite().nonnegative(),
    requirement: adapterRequirementSchema.optional(),
  })
  .strict();
export type ModelAdapterDescriptor = z.infer<typeof modelAdapterDescriptorSchema>;

export const providerTransportRequestSchema = z
  .object({
    method: z.enum(["DELETE", "GET", "PATCH", "POST", "PUT"]),
    path: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.instanceof(Uint8Array).optional(),
  })
  .strict();
export type ProviderTransportRequest = z.infer<typeof providerTransportRequestSchema>;

export const providerTransportResponseSchema = z
  .object({
    status: z.number().int().min(100).max(599),
    headers: z.record(z.string(), z.string()),
    body: z.instanceof(Uint8Array),
  })
  .strict();
export type ProviderTransportResponse = z.infer<typeof providerTransportResponseSchema>;

export interface ProviderTransport {
  request(request: ProviderTransportRequest): Promise<ProviderTransportResponse>;
}

export interface ModelInvocationContext {
  readonly trustedContext: TrustedModelContext;
  readonly signal: AbortSignal;
  readonly transport?: ProviderTransport;
}

export interface UnaryModelAdapter<Input, Output> {
  readonly descriptor: ModelAdapterDescriptor;
  readonly inputSchema: Schema<Input>;
  readonly outputSchema: Schema<Output>;
  invoke(input: Input, context: ModelInvocationContext): Promise<Output>;
}
