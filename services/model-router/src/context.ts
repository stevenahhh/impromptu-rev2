import { z } from "zod";

const trustedModelContextBrand: unique symbol = Symbol("TrustedModelContext");
const trustedContexts = new WeakSet<object>();

const trustedContextFieldsSchema = z.object({
  tenantId: z.string().min(1),
  principalId: z.string().min(1),
  requestId: z.string().min(1),
  traceId: z.string().min(1),
  policyVersion: z.string().min(1),
  deadlineAtMs: z.number().finite().nonnegative(),
});

export interface TrustedModelContextInput {
  readonly tenantId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly traceId: string;
  readonly policyVersion: string;
  readonly deadlineAtMs: number;
  readonly signal: AbortSignal;
}

export interface TrustedModelContext extends TrustedModelContextInput {
  readonly [trustedModelContextBrand]: true;
}

export function createTrustedModelContext(input: TrustedModelContextInput): TrustedModelContext {
  const fields = trustedContextFieldsSchema.parse(input);
  const context: TrustedModelContext = Object.freeze({
    ...fields,
    signal: input.signal,
    [trustedModelContextBrand]: true as const,
  });
  trustedContexts.add(context);
  return context;
}

export function isTrustedModelContext(value: unknown): value is TrustedModelContext {
  return typeof value === "object" && value !== null && trustedContexts.has(value);
}
