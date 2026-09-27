import type { ModelCapability, ServerModelRouter } from "@impromptu/model-router";
import type { JsonLogger } from "../observability.ts";
import type { PreparedEvidenceCoordinator } from "../prepared-evidence.ts";
import type { SafeExternalEvidenceFetcher } from "../retrieval/external-fetch.ts";
import type { KeylessFirstExternalSearchBoundary } from "../retrieval/external-search.ts";
import type { InternalRetrievalService } from "../retrieval/internal-retrieval.ts";
import type { PostgresDeckRetrievalStore } from "../retrieval/postgres-deck-retrieval.ts";
import { PrivateRecommendationPipeline } from "../verifier/recommendation-pipeline.ts";

/** Wires the recommendation pipeline with its stage/hedge/reconciliation observers. */
export function createRecommendations(options: {
  readonly modelRouter: ServerModelRouter;
  /** Registered non-default fallback adapter ids, retried once on retryable slot failure. */
  readonly fallbackAdapterIds?: Partial<Record<ModelCapability, string>>;
  readonly slideText: PostgresDeckRetrievalStore;
  readonly internalRetrieval: InternalRetrievalService;
  readonly externalSearch: KeylessFirstExternalSearchBoundary;
  readonly externalFetcher: SafeExternalEvidenceFetcher;
  readonly logger: JsonLogger;
  /** Lazy accessor: the coordinator is composed after this pipeline it feeds back into. */
  readonly readCoordinator: () => PreparedEvidenceCoordinator;
}): PrivateRecommendationPipeline {
  const { logger } = options;
  return new PrivateRecommendationPipeline({
    router: options.modelRouter,
    fallbackAdapterIds: options.fallbackAdapterIds,
    slideText: options.slideText,
    contexts: {
      async resolve(accountSessionId) {
        const session = await options
          .readCoordinator()
          .readAccountSession(accountSessionId, Date.now());
        return session.outcome === "APPLIED"
          ? {
              tenantId: session.value.accountId,
              principalId: session.value.actorId,
              policyVersion: "model-policy-v1",
            }
          : null;
      },
    },
    internal: options.internalRetrieval,
    externalSearch: options.externalSearch,
    externalFetch: options.externalFetcher,
    stageObserver: {
      observe(event) {
        logger.request({
          requestId: `recommendation-stage:${crypto.randomUUID()}`,
          method: "INFERENCE",
          path: `/internal/recommendation/${event.stage}`,
          status: event.outcome === "SUCCESS" ? 200 : 500,
          durationMs: event.latencyMs,
          outcome:
            event.errorCode === undefined ? event.outcome : `${event.outcome}:${event.errorCode}`,
        });
      },
      observeHedge(event) {
        logger.request({
          requestId: `recommendation-hedge:${crypto.randomUUID()}`,
          method: "HEDGE",
          path: `/internal/recommendation/${event.stage}`,
          status: 200,
          durationMs: 0,
          outcome: event.outcome,
        });
      },
      observeReconciliation(event) {
        logger.request({
          requestId: `recommendation-reconcile:${crypto.randomUUID()}`,
          method: "RECONCILE",
          path: "/internal/recommendation/deterministic",
          status: 422,
          durationMs: 0,
          outcome: `${event.category}:${event.value}`,
        });
      },
    },
  });
}
