import {
  type RecommendationOutcome,
  RecommendationOutcomeSchema,
  type RetrievalFailureCode,
} from "@impromptu/contracts/retrieval";
import type { ModelErrorCode } from "@impromptu/model-router";

/**
 * Terminal budget for one recommendation. The acceptance bar is a client-measured p95 of 5,000ms
 * and the guard below reserves the tail of this budget for returning a terminal answer, so the
 * abort lands at budget minus guard. Keeping that abort under the bar is what makes even an
 * aborted run report inside it, which caps the budget at 5,500ms; 5,400ms leaves the transport a
 * few milliseconds of room while giving the model stages 400ms more than the original 5,000ms.
 */
export const RECOMMENDATION_BUDGET_MS = 5_400;
export const TERMINAL_DEADLINE_GUARD_MS = 500;

export function modelReason(
  errorCode: ModelErrorCode,
): "MODEL_FAILURE" | "BUDGET_EXCEEDED" | "DEADLINE_EXCEEDED" {
  if (errorCode === "budget_exceeded" || errorCode === "quota_exceeded") return "BUDGET_EXCEEDED";
  if (errorCode === "deadline_exceeded" || errorCode === "cancelled") return "DEADLINE_EXCEEDED";
  return "MODEL_FAILURE";
}

export function abstain(
  reason: RetrievalFailureCode,
  startedAtMs: number,
  completedAtMs: number,
): RecommendationOutcome {
  return RecommendationOutcomeSchema.parse({
    outcome: "ABSTAIN",
    reason,
    completedAtMs,
    latencyMs: Math.max(0, completedAtMs - startedAtMs),
  });
}
