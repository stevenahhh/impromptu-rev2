import { z } from "zod";

const trustedModelContextBrand: unique symbol = Symbol("TrustedModelContext");
const trustedContexts = new WeakSet<object>();

export const trustedModelContextInputSchema = z
  .object({
    tenantId: z.string().min(1),
    principalId: z.string().min(1),
    requestId: z.string().min(1),
    traceId: z.string().min(1),
    policyVersion: z.string().min(1),
    deadlineAtMs: z.number().finite().nonnegative(),
    signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal, {
      message: "signal must be an AbortSignal",
    }),
  })
  .strict();

export type TrustedModelContextInput = z.infer<typeof trustedModelContextInputSchema>;

export interface TrustedModelContext extends TrustedModelContextInput {
  readonly [trustedModelContextBrand]: true;
}

export function createTrustedModelContext(input: unknown): TrustedModelContext {
  const parsed = trustedModelContextInputSchema.parse(input);
  const context: TrustedModelContext = Object.freeze({
    ...parsed,
    [trustedModelContextBrand]: true as const,
  });
  trustedContexts.add(context);
  return context;
}

export function isTrustedModelContext(value: unknown): value is TrustedModelContext {
  return typeof value === "object" && value !== null && trustedContexts.has(value);
}
