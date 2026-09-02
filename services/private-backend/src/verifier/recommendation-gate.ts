import type { RetrievedEvidence, StructuredRecommendation } from "@impromptu/contracts/retrieval";
import { StructuredRecommendationSchema } from "@impromptu/contracts/retrieval";
import { reconcileEvidence } from "./deterministic-evidence.ts";

export type RecommendationGateVerdict =
  | Readonly<{
      outcome: "SELECTED";
      canonicalStructured: StructuredRecommendation;
      selectedAliases: readonly string[];
    }>
  | Readonly<{ outcome: "ABSTAIN"; reason: "INSUFFICIENT_EVIDENCE" }>
  | Readonly<{
      outcome: "RECONCILIATION_MISMATCH";
      category: "NUMBER" | "UNIT" | "DATE" | "ENTITY" | "SOURCE";
      value: string;
    }>;

/**
 * Intersects rerank ordering with the model's selected aliases, then reconciles every asserted
 * number, unit, date and entity against the deterministic evidence gate. The gate only ever
 * narrows: any alias that failed rerank ordering or reconciliation yields an abstain verdict,
 * never a widened selection.
 */
export function selectGateApprovedEvidence(input: {
  readonly rerankedEvidenceIds: readonly string[];
  readonly structured: StructuredRecommendation;
  readonly aliasedEvidence: ReadonlyArray<Readonly<{ alias: string; evidence: RetrievedEvidence }>>;
  readonly evidence: readonly RetrievedEvidence[];
}): RecommendationGateVerdict {
  const evidenceByAlias = new Map(input.aliasedEvidence.map((item) => [item.alias, item.evidence]));
  const evidenceById = new Map(input.evidence.map((item) => [item.evidenceId, item]));
  const orderedAliases = new Set(input.rerankedEvidenceIds);
  const ordered = input.rerankedEvidenceIds
    .map((id) => evidenceByAlias.get(id))
    .filter((item): item is RetrievedEvidence => item !== undefined);
  const selectedAliases = input.structured.evidenceIds;
  if (
    ordered.length === 0 ||
    selectedAliases.some((alias) => !orderedAliases.has(alias) || !evidenceByAlias.has(alias))
  ) {
    return { outcome: "ABSTAIN", reason: "INSUFFICIENT_EVIDENCE" };
  }
  const canonicalStructured = StructuredRecommendationSchema.parse({
    ...input.structured,
    evidenceIds: selectedAliases.map((alias) => evidenceByAlias.get(alias)?.evidenceId),
  });
  const deterministic = reconcileEvidence(canonicalStructured, ordered);
  if (deterministic.outcome === "MISMATCH") {
    return {
      outcome: "RECONCILIATION_MISMATCH",
      category: deterministic.category,
      value: deterministic.value,
    };
  }
  const selected = canonicalStructured.evidenceIds
    .map((id) => evidenceById.get(id))
    .filter((item): item is RetrievedEvidence => item !== undefined);
  if (selected.length === 0) return { outcome: "ABSTAIN", reason: "INSUFFICIENT_EVIDENCE" };
  return { outcome: "SELECTED", canonicalStructured, selectedAliases };
}
