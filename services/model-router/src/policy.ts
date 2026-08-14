import { z } from "zod";
import type { TrustedModelContext } from "./context.ts";
import { ModelRouterError } from "./errors.ts";
import { modelCapabilitySchema, modelErrorCodeSchema } from "./schemas.ts";

export const modelDispatchRequestSchema = z
  .object({
    tenantId: z.string().min(1),
    capability: modelCapabilitySchema,
    adapterId: z.string().min(1),
    policyVersion: z.string().min(1),
    estimatedCostUnits: z.number().finite().nonnegative(),
    signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal),
  })
  .strict();
export type ModelDispatchRequest = z.infer<typeof modelDispatchRequestSchema>;

export const budgetReservationSchema = z
  .object({
    reservationId: z.string().min(1),
    reservedUnits: z.number().finite().nonnegative(),
  })
  .strict();
export type BudgetReservation = z.infer<typeof budgetReservationSchema>;

export const budgetReconciliationSchema = z
  .object({
    reservationId: z.string().min(1),
    tenantId: z.string().min(1),
    capability: modelCapabilitySchema,
    adapterId: z.string().min(1),
    reservedUnits: z.number().finite().nonnegative(),
    usedUnits: z.number().finite().nonnegative(),
    outcome: z.enum(["success", "failure", "cancelled"]),
    errorCode: modelErrorCodeSchema.nullable(),
  })
  .strict();
export type BudgetReconciliation = z.infer<typeof budgetReconciliationSchema>;

export interface PolicyVersionAuthority {
  assertCurrent(request: ModelDispatchRequest, context: TrustedModelContext): Promise<void>;
}

export interface TenantQuotaPolicy {
  assertWithinQuota(request: ModelDispatchRequest, context: TrustedModelContext): Promise<void>;
}

export interface TenantBudget {
  reserve(request: ModelDispatchRequest, context: TrustedModelContext): Promise<BudgetReservation>;
  reconcile(reconciliation: BudgetReconciliation, context: TrustedModelContext): Promise<void>;
}

export class StaticPolicyVersionAuthority implements PolicyVersionAuthority {
  readonly #currentVersion: string;

  constructor(currentVersion: string) {
    if (currentVersion.length === 0)
      throw new TypeError("Current policy version must not be empty");
    this.#currentVersion = currentVersion;
  }

  async assertCurrent(request: ModelDispatchRequest, _context: TrustedModelContext): Promise<void> {
    if (request.policyVersion !== this.#currentVersion) {
      throw new ModelRouterError(
        "policy_version_mismatch",
        "Model policy version is not current",
        false,
      );
    }
  }
}
