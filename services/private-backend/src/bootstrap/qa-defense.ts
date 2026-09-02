import type { RecommendationOutcome } from "@impromptu/contracts/retrieval";
import type { QaDefenseRouteDependencies } from "../http/routes/qa-defense.ts";
import type { PreparedEvidenceCoordinator, PreparedEvidenceStore } from "../prepared-evidence.ts";
import type { QaExchangeLedger } from "../qa/qa-exchange-ledger.ts";

/**
 * Wires the authenticated Q&A-defense routes against the shared prepared evidence,
 * mirroring bootstrap/session-reports.ts: narrowly-shaped function seams, never whole
 * service objects handed to HTTP code.
 */
export function createQaDefense(options: {
  readonly store: PreparedEvidenceStore;
  readonly coordinator: PreparedEvidenceCoordinator;
  /**
   * Optional: a backend composed without the recommendation pipeline still opens Q&A
   * windows but answers audience questions with a typed 503 (enforced by the route).
   */
  readonly recommendations?: {
    readonly recommend: (
      accountSessionId: string,
      input: unknown,
    ) => Promise<RecommendationOutcome>;
  };
  /** Optional exchange sink; without it questions are refused rather than unrecorded. */
  readonly qaExchanges?: QaExchangeLedger;
  readonly persist?: () => Promise<void>;
  /** Clock shared with the rest of the backend; defaults to the wall clock. */
  readonly now?: () => number;
}): QaDefenseRouteDependencies {
  const now = options.now ?? Date.now;
  const { coordinator, store } = options;
  const { recommendations, qaExchanges, persist } = options;

  // Narrow seam: the route moves the lifecycle as the authenticated account session
  // without ever seeing the coordinator or the mutable presentation records.
  const beginQuestions = (accountSessionId: string, presentationSessionId: string) =>
    coordinator.beginQuestions(accountSessionId, presentationSessionId, now());

  /**
   * Read-only phase resolution mirroring #authorizedPresentation, with ONE deliberate
   * deviation: an ENDED presentation resolves instead of rejecting, because "too late"
   * (409 presentation_ended) is the route's phase-guard decision, not an authorization
   * failure. Ownership IS enforced here; status is left entirely to the route.
   */
  async function resolveQaSession(
    accountSessionId: string,
    presentationSessionId: string,
  ): ReturnType<QaDefenseRouteDependencies["resolveQaSession"]> {
    const account = await coordinator.readAccountSession(accountSessionId, now());
    if (account.outcome === "REJECTED") return { outcome: "UNAUTHORIZED" };
    const presentation = store.presentations.get(presentationSessionId);
    if (presentation === undefined) return { outcome: "NOT_FOUND" };
    if (presentation.lifecycle.ownerAccountId !== account.value.accountId) {
      return { outcome: "UNAUTHORIZED" };
    }
    return {
      outcome: "RESOLVED",
      lifecycle: presentation.lifecycle,
      manifestHash: presentation.privateDeck.manifestHash,
    };
  }

  return {
    beginQuestions,
    resolveQaSession,
    ...(recommendations === undefined
      ? {}
      : {
          recommend: (accountSessionId: string, input: unknown) =>
            recommendations.recommend(accountSessionId, input),
        }),
    ...(qaExchanges === undefined
      ? {}
      : {
          ingestExchange: (input: Parameters<QaExchangeLedger["ingest"]>[0]) =>
            qaExchanges.ingest(input),
        }),
    ...(persist === undefined ? {} : { persist }),
    now,
  };
}
