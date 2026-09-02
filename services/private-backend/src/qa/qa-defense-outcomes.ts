import {
  type QaCitation,
  type QaDefenseOutcome,
  QaDefenseOutcomeSchema,
} from "@impromptu/contracts/private";
import type {
  RecommendationOutcome,
  RetrievalFailureCode,
  RetrievedEvidence,
  StructuredRecommendation,
} from "@impromptu/contracts/retrieval";
import { extractFacts } from "../verifier/deterministic-evidence.ts";
import { qaCitations } from "./qa-citations.ts";

/**
 * Pure mapping from the verifier's recommendation outcome to the defense wire contract.
 * No I/O, no clock, no randomness.
 */

/**
 * Transient codes, exactly what modelReason() in src/verifier/recommendation-outcome.ts can
 * produce. Everything else is terminal for one question: the honest retry surface is the
 * user asking again, not silently re-running the pipeline.
 */
export const RETRYABLE_RETRIEVAL_FAILURE_CODES: ReadonlySet<RetrievalFailureCode> = new Set([
  "MODEL_FAILURE",
  "BUDGET_EXCEEDED",
  "DEADLINE_EXCEEDED",
]);

/**
 * Exhaustive over RetrievalFailureCodeSchema with a never-check so a future added code
 * fails compilation here instead of silently defaulting to retryable (or non-retryable).
 */
export function isRetryableRetrievalFailureCode(code: RetrievalFailureCode): boolean {
  switch (code) {
    case "MODEL_FAILURE":
    case "BUDGET_EXCEEDED":
    case "DEADLINE_EXCEEDED":
      return true;
    case "INVALID_REQUEST":
    case "POLICY_UNAVAILABLE":
    case "STALE_AUTHORIZATION_METADATA":
    case "UNAUTHORIZED":
    case "STALE_DECK":
    case "STALE_SOURCE":
    case "FETCH_REJECTED":
    case "FETCH_LIMIT_EXCEEDED":
    case "INSUFFICIENT_EVIDENCE":
    case "CONFLICTING_EVIDENCE":
    case "DETERMINISTIC_MISMATCH":
      return false;
    default: {
      const unhandled: never = code;
      throw new Error(`unhandled retrieval failure code: ${String(unhandled)}`);
    }
  }
}

const AnsweredSchema = QaDefenseOutcomeSchema.options[0];
const AbstainedSchema = QaDefenseOutcomeSchema.options[1];

/**
 * True when NOTHING checkable is asserted anywhere: neither the claim TEXT nor the model's
 * DECLARED fact sets yields a single number, unit, date or entity. This is deliberately the
 * SAME union the deterministic evidence gate reconciles against (extractFacts(claim) unioned
 * with the declared facts in reconcileEvidence), IMPORTED from that module rather than forked:
 * if the gate's notion of a checkable fact ever changes, this policy moves with it. An all-
 * empty union makes the deterministic gate pass vacuously — it verified nothing. No I/O, no
 * clock, no randomness.
 */
export function declaresNoCheckableFacts(recommendation: StructuredRecommendation): boolean {
  const fromClaim = extractFacts(recommendation.claim);
  const declared = recommendation.facts;
  return (
    fromClaim.numbers.length === 0 &&
    fromClaim.units.length === 0 &&
    fromClaim.dates.length === 0 &&
    fromClaim.entities.length === 0 &&
    declared.numbers.length === 0 &&
    declared.units.length === 0 &&
    declared.dates.length === 0 &&
    declared.entities.length === 0
  );
}

/**
 * An answer with no showable source is exactly what this product refuses to render:
 * RECOMMEND whose cited evidence yields zero usable citations becomes ABSTAINED /
 * INSUFFICIENT_EVIDENCE / non-retryable.
 */
export function qaDefenseOutcome(outcome: RecommendationOutcome): QaDefenseOutcome {
  if (outcome.outcome === "ABSTAIN") {
    return AbstainedSchema.parse({
      outcome: "ABSTAINED",
      reason: outcome.reason,
      retryable: isRetryableRetrievalFailureCode(outcome.reason),
      completedAtMs: outcome.completedAtMs,
      latencyMs: outcome.latencyMs,
    });
  }

  // WHY THIS DOWNGRADE EXISTS (do not "fix" it back): observed twice in live defense
  // sessions - a question the uploaded materials could not support produced a
  // refusal-flavoured claim whose text stated no fact at all AND whose structured `facts`
  // were entirely empty, so even against the full asserted union (claim-text facts union
  // declared facts, exactly what the deterministic gate reconciles) there was nothing to
  // check: the gate passed VACUOUSLY, the verifier said SUPPORTED, and a bare answer card with
  // one tangential slide citation shipped instead of the honest cannot-support surface. A
  // defense answer must actually DEFEND something checkable; this Q&A-layer policy is
  // deliberately STRICTLY STRICTER than the gate and does not touch it - but its vacuity test
  // reads the SAME union the gate asserts, so a grounded claim whose text carries the fact is
  // never discarded merely because the model left `facts` empty. On a DEFENSE surface the
  // presenter is being challenged and every rendered assertion needs a traceable basis, so
  // refusing to present an unverifiable claim is the conservative and correct default - same
  // shape as the zero-citation downgrade below.
  if (declaresNoCheckableFacts(outcome.recommendation)) {
    return AbstainedSchema.parse({
      outcome: "ABSTAINED",
      reason: "INSUFFICIENT_EVIDENCE",
      retryable: false,
      completedAtMs: outcome.completedAtMs,
      latencyMs: outcome.latencyMs,
    });
  }

  // Cite only the evidence the model actually used, in its own cited order.
  const byId = new Map(outcome.evidence.map((item) => [item.evidenceId, item]));
  const cited: RetrievedEvidence[] = [];
  for (const id of outcome.recommendation.evidenceIds) {
    const item = byId.get(id);
    if (item !== undefined) cited.push(item);
  }
  const mapped = qaCitations(cited);

  if (mapped.citations.length === 0) {
    // An answer with no showable source must never render: abstain honestly instead.
    return AbstainedSchema.parse({
      outcome: "ABSTAINED",
      reason: "INSUFFICIENT_EVIDENCE",
      retryable: false,
      completedAtMs: outcome.completedAtMs,
      latencyMs: outcome.latencyMs,
    });
  }

  const answer = outcome.recommendation.claim;
  return AnsweredSchema.parse({
    outcome: "ANSWERED",
    answer,
    citations: mapped.citations.slice(0, 3) satisfies QaCitation[],
    completedAtMs: outcome.completedAtMs,
    latencyMs: outcome.latencyMs,
  });
}
