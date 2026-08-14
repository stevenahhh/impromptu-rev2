import type { TrustedModelContext } from "./context.ts";
import type { ModelCapability } from "./schemas.ts";
import type { ExactEgressGrant } from "./security.ts";

export interface Schema<T> {
  parse(value: unknown): T;
}

export interface AdapterRequirement {
  readonly secretId: string;
  readonly egressOrigin: string;
}

export interface ModelAdapterDescriptor {
  readonly adapterId: string;
  readonly capability: ModelCapability;
  readonly provider: string;
  readonly model: string;
  readonly modelVersion: string;
  readonly requirement?: AdapterRequirement;
}

export interface ProviderAccess {
  readonly credential: string;
  readonly egress: ExactEgressGrant;
}

export interface ModelInvocationContext {
  readonly trustedContext: TrustedModelContext;
  readonly signal: AbortSignal;
  readonly providerAccess?: ProviderAccess;
}

export interface UnaryModelAdapter<Input, Output> {
  readonly descriptor: ModelAdapterDescriptor;
  readonly inputSchema: Schema<Input>;
  readonly outputSchema: Schema<Output>;
  invoke(input: Input, context: ModelInvocationContext): Promise<Output>;
}
