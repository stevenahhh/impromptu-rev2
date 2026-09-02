import type { EvidenceCandidate } from "@impromptu/contracts/private";
import type { RetrievedEvidence } from "@impromptu/contracts/retrieval";
import type {
  AuthorizedEvidenceReference,
  InternalRetrievalService,
} from "../retrieval/internal-retrieval.ts";

/**
 * Publication authorization bookkeeping: which evidence has been gate-approved for this
 * pipeline instance, and whether a given item may still be materialized on Console.
 */
export interface RecommendationPublicationAuthorizer {
  /** Re-checks internal authorization for every selected item immediately before materialization. */
  ensureAuthorized(
    selected: readonly RetrievedEvidence[],
    referenceByEvidenceId: ReadonlyMap<string, AuthorizedEvidenceReference>,
  ): Promise<boolean>;
  recordSelectedForPublication(
    selected: readonly RetrievedEvidence[],
    referenceByEvidenceId: ReadonlyMap<string, AuthorizedEvidenceReference>,
  ): void;
  authorizeEvidence(evidence: RetrievedEvidence): Promise<boolean>;
  authorizeCandidate(candidate: EvidenceCandidate): Promise<boolean>;
}

export function createRecommendationPublicationAuthorizer(dependencies: {
  readonly internal: InternalRetrievalService;
}): RecommendationPublicationAuthorizer {
  const { internal } = dependencies;
  const publicationReferences = new Map<string, AuthorizedEvidenceReference>();
  const publicationEvidence = new Map<string, RetrievedEvidence>();
  return {
    async ensureAuthorized(selected, referenceByEvidenceId) {
      for (const item of selected) {
        const reference = referenceByEvidenceId.get(item.evidenceId);
        if (reference !== undefined && !(await internal.authorizeForPublication(reference, item))) {
          return false;
        }
      }
      return true;
    },
    recordSelectedForPublication(selected, referenceByEvidenceId) {
      for (const item of selected) {
        const reference = referenceByEvidenceId.get(item.evidenceId);
        if (reference !== undefined) {
          publicationReferences.set(item.evidenceId, reference);
          publicationEvidence.set(item.evidenceId, item);
        }
      }
    },
    async authorizeEvidence(evidence) {
      if (evidence.rights !== "APPROVED" || evidence.containsPii) return false;
      const reference = publicationReferences.get(evidence.evidenceId);
      return (
        reference !== undefined && (await internal.authorizeForPublication(reference, evidence))
      );
    },
    async authorizeCandidate(candidate) {
      const evidence = [...publicationEvidence.values()].find(
        (item) =>
          item.sourceId === candidate.causal.source.sourceId &&
          item.sourceRevision === candidate.causal.source.revision &&
          item.sourceHash === candidate.causal.source.contentHash &&
          item.deckVersion === candidate.causal.deckVersion &&
          item.manifestHash === candidate.causal.manifestHash,
      );
      return evidence !== undefined && (await this.authorizeEvidence(evidence));
    },
  };
}
