/**
 * Public entry point for the private recommendation pipeline. The implementation is split by
 * responsibility (model slot invocation, external retrieval fan-out, terminal outcomes,
 * publication authorization, orchestration); this path stays a barrel so existing importers
 * keep working untouched.
 */
export type { ExternalSearchBoundary } from "../retrieval/external-search.ts";
export type {
  RecommendationHedgeEvent,
  RecommendationModelStageEvent,
  RecommendationReconciliationEvent,
  RecommendationStageObserver,
} from "./recommendation-model-slots.ts";
export {
  PrivateRecommendationPipeline,
  type RecommendationContextAuthority,
  type RecommendationPrincipalContext,
} from "./recommendation-orchestrator.ts";
