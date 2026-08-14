import { z } from "zod";
import type { TrustedModelContext } from "./context.ts";
import { modelCapabilitySchema } from "./schemas.ts";
import type { ExactEgressGrant } from "./security.ts";

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

export interface ProviderTransportRequest {
  readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
}

export interface ProviderTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface ProviderTransport {
  request(request: ProviderTransportRequest): Promise<ProviderTransportResponse>;
}

export interface ProviderAccess {
  readonly credential: string;
  readonly egress: ExactEgressGrant;
}

export interface ModelInvocationContext {
  readonly trustedContext: TrustedModelContext;
  readonly signal: AbortSignal;
  readonly providerAccess?: ProviderAccess;
  readonly transport?: ProviderTransport;
}

export interface UnaryModelAdapter<Input, Output> {
  readonly descriptor: ModelAdapterDescriptor;
  readonly inputSchema: Schema<Input>;
  readonly outputSchema: Schema<Output>;
  invoke(input: Input, context: ModelInvocationContext): Promise<Output>;
}
