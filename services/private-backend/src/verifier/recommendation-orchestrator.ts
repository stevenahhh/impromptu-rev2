import type { EvidenceCandidate } from "@impromptu/contracts/private";
import {
  type RecommendationOutcome,
  RecommendationOutcomeSchema,
  RetrievalRequestSchema,
  type RetrievedEvidence,
  VerifierModelOutputSchema,
} from "@impromptu/contracts/retrieval";
import type { DeadlineScheduler, ServerModelRouter } from "@impromptu/model-router";
import { createTrustedModelContext, SystemDeadlineScheduler } from "@impromptu/model-router";
import type { SafeExternalEvidenceFetcher } from "../retrieval/external-fetch.ts";
import type { ExternalSearchBoundary } from "../retrieval/external-search.ts";
import type { InternalRetrievalService } from "../retrieval/internal-retrieval.ts";
import { raceWithTerminalDeadline } from "./recommendation-deadline.ts";
import { selectGateApprovedEvidence } from "./recommendation-gate.ts";
import {
  createRecommendationModelSlots,
  embeddingOutputSchema,
  HEDGE_VERIFIER_RESERVE_MS,
  hedgeAtMs,
  hedgedScheduleEndMs,
  prepareModelEvidenceInput,
  type RecommendationStageObserver,
} from "./recommendation-model-slots.ts";
import { abstain, modelReason, RECOMMENDATION_BUDGET_MS } from "./recommendation-outcome.ts";
import { createRecommendationPublicationAuthorizer } from "./recommendation-publication.ts";
import {
  assembleRetrievedEvidence,
  startExternalEvidenceBranch,
} from "./recommendation-retrieval.ts";

export interface RecommendationPrincipalContext {
  readonly tenantId: string;
  readonly principalId: string;
  readonly policyVersion: string;
}

export interface RecommendationContextAuthority {
  resolve(accountSessionId: string): Promise<RecommendationPrincipalContext | null>;
}

export class PrivateRecommendationPipeline {
  readonly #contexts: RecommendationContextAuthority;
  readonly #internal: InternalRetrievalService;
  readonly #externalSearch: ExternalSearchBoundary | undefined;
  readonly #externalFetch: Pick<SafeExternalEvidenceFetcher, "fetchCandidate"> | undefined;
  readonly #now: () => number;
  readonly #scheduler: DeadlineScheduler;
  readonly #stageObserver: RecommendationStageObserver | undefined;
  readonly #slots: ReturnType<typeof createRecommendationModelSlots>;
  readonly #publication: ReturnType<typeof createRecommendationPublicationAuthorizer>;

  constructor(dependencies: {
    readonly router: Pick<ServerModelRouter, "invoke">;
    readonly contexts: RecommendationContextAuthority;
    readonly internal: InternalRetrievalService;
    readonly externalSearch?: ExternalSearchBoundary;
    readonly externalFetch?: Pick<SafeExternalEvidenceFetcher, "fetchCandidate">;
    readonly now?: () => number;
    readonly scheduler?: DeadlineScheduler;
    readonly stageObserver?: RecommendationStageObserver;
  }) {
    this.#contexts = dependencies.contexts;
    this.#internal = dependencies.internal;
    this.#externalSearch = dependencies.externalSearch;
    this.#externalFetch = dependencies.externalFetch;
    this.#now = dependencies.now ?? Date.now;
    this.#scheduler = dependencies.scheduler ?? new SystemDeadlineScheduler(this.#now);
    this.#stageObserver = dependencies.stageObserver;
    this.#slots = createRecommendationModelSlots({
      router: dependencies.router,
      scheduler: this.#scheduler,
      stageObserver: this.#stageObserver,
    });
    this.#publication = createRecommendationPublicationAuthorizer({ internal: this.#internal });
  }

  async recommend(accountSessionId: string, input: unknown): Promise<RecommendationOutcome> {
    const startedAtMs = this.#now();
    const deadlineAtMs = startedAtMs + RECOMMENDATION_BUDGET_MS;
    return raceWithTerminalDeadline({
      scheduler: this.#scheduler,
      startedAtMs,
      budgetMs: RECOMMENDATION_BUDGET_MS,
      expireReason: "private recommendation deadline exceeded",
      completeReason: "private recommendation complete",
      onExpire: () => abstain("DEADLINE_EXCEEDED", startedAtMs, deadlineAtMs),
      run: (signal) => this.#run(accountSessionId, input, startedAtMs, deadlineAtMs, signal),
    });
  }

  async authorizeEvidenceForPublication(evidence: RetrievedEvidence): Promise<boolean> {
    return this.#publication.authorizeEvidence(evidence);
  }

  async authorizeCandidateForPublication(candidate: EvidenceCandidate): Promise<boolean> {
    return this.#publication.authorizeCandidate(candidate);
  }

  async #run(
    accountSessionId: string,
    input: unknown,
    startedAtMs: number,
    deadlineAtMs: number,
    signal: AbortSignal,
  ): Promise<RecommendationOutcome> {
    const request = RetrievalRequestSchema.safeParse(input);
    if (!request.success) return abstain("INVALID_REQUEST", startedAtMs, this.#now());
    // A principal that cannot be resolved - including a resolver that throws - fails closed to
    // UNAUTHORIZED; the run never proceeds without an authorized principal context.
    const principal = await this.#contexts.resolve(accountSessionId).catch(() => null);
    if (principal === null) return abstain("UNAUTHORIZED", startedAtMs, this.#now());
    const trustedContext = createTrustedModelContext({
      tenantId: principal.tenantId,
      principalId: principal.principalId,
      policyVersion: principal.policyVersion,
      requestId: `recommendation:${accountSessionId}:${startedAtMs}`,
      traceId: `recommendation:${principal.tenantId}:${startedAtMs}`,
      deadlineAtMs,
      signal,
    });

    // The external branch only reads the request, so it runs beside embedding and internal
    // retrieval instead of after them. Its evidence is still appended after the internal set,
    // so candidate ordering and every downstream gate stay byte-identical.
    const externalPromise = startExternalEvidenceBranch({
      externalSearch: this.#externalSearch,
      externalFetch: this.#externalFetch,
      request: request.data,
      parentDeadlineAtMs: deadlineAtMs,
      parentSignal: signal,
      now: this.#now,
      scheduler: this.#scheduler,
    });

    const embedded = await this.#slots.invoke(
      "embedding",
      { task: "EMBED_RETRIEVAL_QUERY", query: request.data.query },
      embeddingOutputSchema,
      trustedContext,
    );
    if (!embedded.ok) {
      await externalPromise;
      return abstain(modelReason(embedded.errorCode), startedAtMs, this.#now());
    }

    const { evidence, referenceByEvidenceId } = await assembleRetrievedEvidence({
      internal: this.#internal,
      accountSessionId,
      request: request.data,
      queryVector: embedded.output.vector,
      externalPromise,
    });
    if (signal.aborted) return abstain("DEADLINE_EXCEEDED", startedAtMs, deadlineAtMs);
    if (evidence.length === 0) return abstain("INSUFFICIENT_EVIDENCE", startedAtMs, this.#now());

    const { aliasedEvidence, rerankData, generationData } = prepareModelEvidenceInput(evidence);
    // Both slots inspect the same ACL-approved candidates. Their outputs are intersected before
    // deterministic reconciliation, so running them concurrently does not weaken evidence gates.
    //
    // Every deadline abort in the 20-run provider profile was a run where one of these two slots
    // ran long enough to leave no room for the serial verifier, and the two never ran long in the
    // same run. One duplicate call therefore addresses exactly the observed failure. The trigger
    // is derived from the remaining budget instead of a fixed delay: a duplicate is only worth
    // starting while a typical call still fits before the verifier needs its slot, so once that
    // moment has passed the slot runs unduplicated.
    const pairStartedAtMs = this.#now();
    const pairBudgetMs =
      hedgedScheduleEndMs(startedAtMs) - pairStartedAtMs - HEDGE_VERIFIER_RESERVE_MS;
    const [reranked, structured] = await this.#slots.invokeRerankAndLlmPair({
      query: request.data.query,
      rerankData,
      generationData,
      context: trustedContext,
      pairStartedAtMs,
      pairBudgetMs,
    });
    if (!reranked.ok) return abstain(modelReason(reranked.errorCode), startedAtMs, this.#now());
    if (!structured.ok) return abstain(modelReason(structured.errorCode), startedAtMs, this.#now());
    // The deterministic gate intersects rerank ordering with the model's selection and reconciles
    // every asserted fact against retrieved evidence; any mismatch narrows to an abstain.
    const gated = selectGateApprovedEvidence({
      rerankedEvidenceIds: reranked.output.orderedEvidenceIds,
      structured: structured.output,
      aliasedEvidence,
      evidence,
    });
    if (gated.outcome === "ABSTAIN") {
      return abstain(gated.reason, startedAtMs, this.#now());
    }
    if (gated.outcome === "RECONCILIATION_MISMATCH") {
      this.#stageObserver?.observeReconciliation?.({
        category: gated.category,
        value: gated.value,
      });
      return abstain("DETERMINISTIC_MISMATCH", startedAtMs, this.#now());
    }
    const { canonicalStructured, selectedAliases } = gated;
    const evidenceById = new Map(evidence.map((item) => [item.evidenceId, item]));
    const selected = canonicalStructured.evidenceIds
      .map((id) => evidenceById.get(id))
      .filter((item): item is RetrievedEvidence => item !== undefined);
    if (selected.length === 0) return abstain("INSUFFICIENT_EVIDENCE", startedAtMs, this.#now());

    // The verifier is the last serial stage, so whatever budget the pair left is all it has.
    // Three runs in the cohort probe had it cancelled mid-flight, which is the same isolated slow
    // call the other two slots already guard against.
    const verifierStartedAtMs = this.#now();
    const verified = await this.#slots.hedgedInvoke(
      "verifier",
      {
        task: "VERIFY_RECOMMENDATION",
        constraints: { untrustedEvidence: true, mayAuthorize: false, mayPublish: false },
        recommendation: structured.output,
        untrustedData: generationData.filter((item) => selectedAliases.includes(item.evidenceId)),
      },
      VerifierModelOutputSchema,
      trustedContext,
      hedgeAtMs(
        "verifier",
        verifierStartedAtMs,
        hedgedScheduleEndMs(startedAtMs) - verifierStartedAtMs,
      ),
    );
    if (!verified.ok) return abstain(modelReason(verified.errorCode), startedAtMs, this.#now());
    if (verified.output.verdict !== "SUPPORTED") {
      return abstain(
        verified.output.verdict === "CONFLICTING"
          ? "CONFLICTING_EVIDENCE"
          : "INSUFFICIENT_EVIDENCE",
        startedAtMs,
        this.#now(),
      );
    }

    // Re-check internal authorization after model work and immediately before Console materialization.
    if (!(await this.#publication.ensureAuthorized(selected, referenceByEvidenceId))) {
      return abstain("UNAUTHORIZED", startedAtMs, this.#now());
    }
    const completedAtMs = this.#now();
    if (completedAtMs >= deadlineAtMs || signal.aborted) {
      return abstain("DEADLINE_EXCEEDED", startedAtMs, deadlineAtMs);
    }
    this.#publication.recordSelectedForPublication(selected, referenceByEvidenceId);
    return RecommendationOutcomeSchema.parse({
      outcome: "RECOMMEND",
      recommendation: canonicalStructured,
      evidence: selected,
      completedAtMs,
      latencyMs: completedAtMs - startedAtMs,
    });
  }
}
