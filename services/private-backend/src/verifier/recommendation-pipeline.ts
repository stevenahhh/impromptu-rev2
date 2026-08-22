import type { EvidenceCandidate } from "@impromptu/contracts/private";
import {
  type RecommendationOutcome,
  RecommendationOutcomeSchema,
  type RetrievalFailureCode,
  RetrievalRequestSchema,
  type RetrievedEvidence,
  StructuredRecommendationSchema,
  VerifierModelOutputSchema,
} from "@impromptu/contracts/retrieval";
import {
  createTrustedModelContext,
  type DeadlineScheduler,
  type ModelErrorCode,
  type ServerModelRouter,
  SystemDeadlineScheduler,
} from "@impromptu/model-router";
import { z } from "zod";
import type { SafeExternalEvidenceFetcher, SearchCandidate } from "../retrieval/external-fetch.ts";
import type { ExternalSearchBoundary } from "../retrieval/external-search.ts";
import type {
  AuthorizedEvidenceReference,
  InternalRetrievalService,
} from "../retrieval/internal-retrieval.ts";
import { reconcileEvidence } from "./deterministic-evidence.ts";

/**
 * Terminal budget for one recommendation. The acceptance bar is a client-measured p95 of 5,000ms
 * and the guard below reserves the tail of this budget for returning a terminal answer, so the
 * abort lands at budget minus guard. Keeping that abort under the bar is what makes even an
 * aborted run report inside it, which caps the budget at 5,500ms; 5,400ms leaves the transport a
 * few milliseconds of room while giving the model stages 400ms more than the original 5,000ms.
 */
const RECOMMENDATION_BUDGET_MS = 5_400;
/**
 * The hedge offsets below were tuned by measurement against a 5,000ms budget, and a duplicate that
 * starts later rescues fewer runs. Widening the terminal budget therefore has to buy tail room for
 * a slow call rather than permission to wait longer before duplicating, so the schedule keeps
 * using the budget it was tuned on while the abort follows the real one.
 */
const HEDGE_SCHEDULE_BUDGET_MS = 5_000;
const TERMINAL_DEADLINE_GUARD_MS = 500;
const EXTERNAL_BRANCH_DEADLINE_MS = 1_800;
const MAX_MODEL_EVIDENCE = 2;
const MAX_MODEL_CONTENT_CHARACTERS = 700;
/**
 * Slot hedging budget, derived from the hedged 20-run provider profile in
 * `.omo/evidence/task-37`. The verifier runs serially after the pair, so the pair must leave
 * behind enough room for the verifier tail rather than its median: reserving the p50 leaves the
 * verifier short on half of all runs, which is exactly the abort the reserve exists to prevent.
 * The reserve is therefore the measured verifier p90 (1,934ms). The per-slot figures are the
 * measured p50 of each slot, because that is how long a duplicate typically needs in order to
 * be worth starting at all.
 */
const HEDGE_VERIFIER_RESERVE_MS = 1_934;
const HEDGE_TYPICAL_CALL_MS = { rerank: 967, llm: 1_284, verifier: 1_644 } as const;
/**
 * The fastest durations either slot was observed to return in. Deferring a duplicate to a point
 * earlier than this can never avoid starting one - no call settles that early - so the delay
 * would only shorten the duplicate's runway. Both hedged profiles recorded llm duplicates on
 * every single run, which is exactly that situation.
 */
const HEDGE_FAST_PATH_MS = { rerank: 750, llm: 1_000, verifier: 1_200 } as const;

const embeddingOutputSchema = z
  .object({ vector: z.array(z.number().finite()).min(1).max(8_192) })
  .strict();
const rerankOutputSchema = z
  .object({ orderedEvidenceIds: z.array(z.string().min(1)).min(1).max(MAX_MODEL_EVIDENCE) })
  .strict();

export interface RecommendationPrincipalContext {
  readonly tenantId: string;
  readonly principalId: string;
  readonly policyVersion: string;
}

export interface RecommendationContextAuthority {
  resolve(accountSessionId: string): Promise<RecommendationPrincipalContext | null>;
}

export type { ExternalSearchBoundary } from "../retrieval/external-search.ts";

export type RecommendationModelStageEvent = Readonly<{
  stage: "embedding" | "rerank" | "llm" | "verifier";
  outcome: "SUCCESS" | "FAILED";
  latencyMs: number;
  errorCode?: ModelErrorCode;
}>;

export type RecommendationReconciliationEvent = Readonly<{
  category: "NUMBER" | "UNIT" | "DATE" | "ENTITY" | "SOURCE";
  /** The rejected fact token itself; never claim or evidence prose. */
  value: string;
}>;

export type RecommendationHedgeEvent = Readonly<{
  stage: "rerank" | "llm" | "verifier";
  outcome: "STARTED" | "PRIMARY_WON" | "HEDGE_WON" | "BOTH_FAILED";
}>;

export interface RecommendationStageObserver {
  observe(event: RecommendationModelStageEvent): void;
  observeReconciliation?(event: RecommendationReconciliationEvent): void;
  observeHedge?(event: RecommendationHedgeEvent): void;
}

export class PrivateRecommendationPipeline {
  readonly #router: Pick<ServerModelRouter, "invoke">;
  readonly #contexts: RecommendationContextAuthority;
  readonly #internal: InternalRetrievalService;
  readonly #externalSearch: ExternalSearchBoundary | undefined;
  readonly #externalFetch: Pick<SafeExternalEvidenceFetcher, "fetchCandidate"> | undefined;
  readonly #now: () => number;
  readonly #scheduler: DeadlineScheduler;
  readonly #stageObserver: RecommendationStageObserver | undefined;
  readonly #publicationReferences = new Map<string, AuthorizedEvidenceReference>();
  readonly #publicationEvidence = new Map<string, RetrievedEvidence>();

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
    this.#router = dependencies.router;
    this.#contexts = dependencies.contexts;
    this.#internal = dependencies.internal;
    this.#externalSearch = dependencies.externalSearch;
    this.#externalFetch = dependencies.externalFetch;
    this.#now = dependencies.now ?? Date.now;
    this.#scheduler = dependencies.scheduler ?? new SystemDeadlineScheduler(this.#now);
    this.#stageObserver = dependencies.stageObserver;
  }

  async recommend(accountSessionId: string, input: unknown): Promise<RecommendationOutcome> {
    const startedAtMs = this.#now();
    const deadlineAtMs = startedAtMs + RECOMMENDATION_BUDGET_MS;
    const controller = new AbortController();
    let resolveDeadline: (outcome: RecommendationOutcome) => void = () => undefined;
    const deadline = new Promise<RecommendationOutcome>((resolve) => {
      resolveDeadline = resolve;
    });
    const removeDeadline = this.#scheduler.schedule(
      deadlineAtMs - TERMINAL_DEADLINE_GUARD_MS,
      () => {
        controller.abort("private recommendation deadline exceeded");
        resolveDeadline(abstain("DEADLINE_EXCEEDED", startedAtMs, deadlineAtMs));
      },
    );
    try {
      return await Promise.race([
        this.#run(accountSessionId, input, startedAtMs, deadlineAtMs, controller.signal),
        deadline,
      ]);
    } finally {
      removeDeadline();
      // Cancels any evidence branch that is still in flight once the outcome is decided.
      controller.abort("private recommendation complete");
    }
  }

  async authorizeEvidenceForPublication(evidence: RetrievedEvidence): Promise<boolean> {
    if (evidence.rights !== "APPROVED" || evidence.containsPii) return false;
    const reference = this.#publicationReferences.get(evidence.evidenceId);
    return (
      reference !== undefined && (await this.#internal.authorizeForPublication(reference, evidence))
    );
  }

  async authorizeCandidateForPublication(candidate: EvidenceCandidate): Promise<boolean> {
    const evidence = [...this.#publicationEvidence.values()].find(
      (item) =>
        item.sourceId === candidate.causal.source.sourceId &&
        item.sourceRevision === candidate.causal.source.revision &&
        item.sourceHash === candidate.causal.source.contentHash &&
        item.deckVersion === candidate.causal.deckVersion &&
        item.manifestHash === candidate.causal.manifestHash,
    );
    return evidence !== undefined && (await this.authorizeEvidenceForPublication(evidence));
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
    let principal: RecommendationPrincipalContext | null;
    try {
      principal = await this.#contexts.resolve(accountSessionId);
    } catch {
      principal = null;
    }
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
    const externalEvidence = this.#retrieveExternal(request.data, deadlineAtMs, signal);

    const embedded = await this.#model(
      "embedding",
      { task: "EMBED_RETRIEVAL_QUERY", query: request.data.query },
      embeddingOutputSchema,
      trustedContext,
    );
    if (!embedded.ok) {
      await externalEvidence;
      return abstain(modelReason(embedded.errorCode), startedAtMs, this.#now());
    }

    const references = await this.#internal.retrieve(
      accountSessionId,
      request.data,
      embedded.output.vector,
    );
    // Each materialization re-authorizes its own reference, so they are independent.
    const materializations = await Promise.all(
      references.map(async (reference) => ({
        reference,
        materialized: await this.#internal.materialize(reference),
      })),
    );
    const evidence: RetrievedEvidence[] = [];
    const referenceByEvidenceId = new Map<string, AuthorizedEvidenceReference>();
    for (const { reference, materialized } of materializations) {
      if (materialized.outcome === "MATERIALIZED") {
        evidence.push(materialized.evidence);
        referenceByEvidenceId.set(materialized.evidence.evidenceId, reference);
      }
    }
    // The model sees only the first MAX_MODEL_EVIDENCE entries and the internal set is placed
    // ahead of the external one, so once internal retrieval has filled those slots the external
    // branch can no longer reach the model input, the deterministic reconciliation or the selected
    // evidence. Waiting on it here would spend budget the model stages need for nothing, so it is
    // awaited only while the internal set is still short of those slots.
    if (evidence.length < MAX_MODEL_EVIDENCE) {
      evidence.push(...(await externalEvidence));
    } else {
      // Its own child deadline bounds it; marking it handled keeps a late failure from surfacing
      // as an unhandled rejection.
      void externalEvidence.catch(() => undefined);
    }
    if (signal.aborted) return abstain("DEADLINE_EXCEEDED", startedAtMs, deadlineAtMs);
    if (evidence.length === 0) return abstain("INSUFFICIENT_EVIDENCE", startedAtMs, this.#now());

    const modelEvidence = evidence.slice(0, MAX_MODEL_EVIDENCE);
    const aliasedEvidence = modelEvidence.map((item, index) => ({
      alias: `e${index + 1}`,
      evidence: item,
    }));
    const rerankData = aliasedEvidence.map((item) => ({
      evidenceId: item.alias,
      content: item.evidence.content.slice(0, MAX_MODEL_CONTENT_CHARACTERS),
    }));
    const generationData = rerankData.slice(0, 1);
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
      startedAtMs +
      HEDGE_SCHEDULE_BUDGET_MS -
      TERMINAL_DEADLINE_GUARD_MS -
      pairStartedAtMs -
      HEDGE_VERIFIER_RESERVE_MS;
    const hedgeAtMs = (
      slot: "rerank" | "llm" | "verifier",
      startedAtMs: number,
      budgetMs: number,
    ): number | null => {
      const offset = budgetMs - HEDGE_TYPICAL_CALL_MS[slot];
      // Not even one typical call fits, so a duplicate cannot finish either: run the slot alone.
      if (offset <= 0) return null;
      // Waiting past the point where no call has ever settled cannot avoid the duplicate, so the
      // delay would only cost the duplicate runway it needs. Such a slot starts its duplicate at
      // once; a slot whose delay genuinely avoids duplicates keeps waiting.
      const deferrable = offset >= HEDGE_FAST_PATH_MS[slot];
      return startedAtMs + (deferrable ? offset : 0);
    };
    const [reranked, structured] = await Promise.all([
      this.#hedgedModel(
        "rerank",
        { task: "RERANK_EVIDENCE", query: request.data.query, untrustedData: rerankData },
        rerankOutputSchema,
        trustedContext,
        hedgeAtMs("rerank", pairStartedAtMs, pairBudgetMs),
      ),
      this.#hedgedModel(
        "llm",
        {
          task: "CREATE_STRUCTURED_RECOMMENDATION",
          constraints: {
            maySelectTools: false,
            maySelectUrls: false,
            mayAuthorize: false,
            mayPublish: false,
          },
          query: request.data.query,
          untrustedData: generationData,
        },
        StructuredRecommendationSchema,
        trustedContext,
        hedgeAtMs("llm", pairStartedAtMs, pairBudgetMs),
      ),
    ]);
    if (!reranked.ok) return abstain(modelReason(reranked.errorCode), startedAtMs, this.#now());
    if (!structured.ok) return abstain(modelReason(structured.errorCode), startedAtMs, this.#now());
    const evidenceByAlias = new Map(aliasedEvidence.map((item) => [item.alias, item.evidence]));
    const evidenceById = new Map(evidence.map((item) => [item.evidenceId, item]));
    const orderedAliases = new Set(reranked.output.orderedEvidenceIds);
    const ordered = reranked.output.orderedEvidenceIds
      .map((id) => evidenceByAlias.get(id))
      .filter((item): item is RetrievedEvidence => item !== undefined);
    const selectedAliases = structured.output.evidenceIds;
    if (
      ordered.length === 0 ||
      selectedAliases.some((alias) => !orderedAliases.has(alias) || !evidenceByAlias.has(alias))
    ) {
      return abstain("INSUFFICIENT_EVIDENCE", startedAtMs, this.#now());
    }
    const canonicalStructured = StructuredRecommendationSchema.parse({
      ...structured.output,
      evidenceIds: selectedAliases.map((alias) => evidenceByAlias.get(alias)?.evidenceId),
    });
    const deterministic = reconcileEvidence(canonicalStructured, ordered);
    if (deterministic.outcome === "MISMATCH") {
      this.#stageObserver?.observeReconciliation?.({
        category: deterministic.category,
        value: deterministic.value,
      });
      return abstain("DETERMINISTIC_MISMATCH", startedAtMs, this.#now());
    }
    const selected = canonicalStructured.evidenceIds
      .map((id) => evidenceById.get(id))
      .filter((item): item is RetrievedEvidence => item !== undefined);
    if (selected.length === 0) return abstain("INSUFFICIENT_EVIDENCE", startedAtMs, this.#now());

    // The verifier is the last serial stage, so whatever budget the pair left is all it has.
    // Three runs in the cohort probe had it cancelled mid-flight, which is the same isolated slow
    // call the other two slots already guard against.
    const verifierStartedAtMs = this.#now();
    const verified = await this.#hedgedModel(
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
        startedAtMs + HEDGE_SCHEDULE_BUDGET_MS - TERMINAL_DEADLINE_GUARD_MS - verifierStartedAtMs,
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
    for (const item of selected) {
      const reference = referenceByEvidenceId.get(item.evidenceId);
      if (
        reference !== undefined &&
        !(await this.#internal.authorizeForPublication(reference, item))
      ) {
        return abstain("UNAUTHORIZED", startedAtMs, this.#now());
      }
    }
    const completedAtMs = this.#now();
    if (completedAtMs >= deadlineAtMs || signal.aborted) {
      return abstain("DEADLINE_EXCEEDED", startedAtMs, deadlineAtMs);
    }
    for (const item of selected) {
      const reference = referenceByEvidenceId.get(item.evidenceId);
      if (reference !== undefined) {
        this.#publicationReferences.set(item.evidenceId, reference);
        this.#publicationEvidence.set(item.evidenceId, item);
      }
    }
    return RecommendationOutcomeSchema.parse({
      outcome: "RECOMMEND",
      recommendation: canonicalStructured,
      evidence: selected,
      completedAtMs,
      latencyMs: completedAtMs - startedAtMs,
    });
  }

  async #retrieveExternal(
    request: z.infer<typeof RetrievalRequestSchema>,
    parentDeadlineAtMs: number,
    parentSignal: AbortSignal,
  ): Promise<RetrievedEvidence[]> {
    if (
      this.#externalSearch === undefined ||
      this.#externalFetch === undefined ||
      parentSignal.aborted
    ) {
      return [];
    }
    const externalSearch = this.#externalSearch;
    const externalFetch = this.#externalFetch;
    const controller = new AbortController();
    const deadlineAtMs = Math.min(parentDeadlineAtMs, this.#now() + EXTERNAL_BRANCH_DEADLINE_MS);
    let resolveDeadline: (evidence: RetrievedEvidence[]) => void = () => undefined;
    const deadline = new Promise<RetrievedEvidence[]>((resolve) => {
      resolveDeadline = resolve;
    });
    const expire = () => {
      controller.abort("external search deadline exceeded");
      resolveDeadline([]);
    };
    const abortFromParent = () => {
      controller.abort(parentSignal.reason);
      resolveDeadline([]);
    };
    parentSignal.addEventListener("abort", abortFromParent, { once: true });
    const removeDeadline = this.#scheduler.schedule(deadlineAtMs, expire);
    if (parentSignal.aborted) abortFromParent();
    const external = (async (): Promise<RetrievedEvidence[]> => {
      let candidates: readonly SearchCandidate[];
      try {
        candidates = await externalSearch.search(request.query, controller.signal);
      } catch {
        return [];
      }
      // Candidate fetches are independent origin reads under one shared branch deadline, so
      // they run together and are collapsed back in candidate order for a deterministic set.
      const fetched = await Promise.all(
        candidates.slice(0, request.maxResults).map(async (candidate) => {
          if (controller.signal.aborted) return null;
          try {
            const result = await externalFetch.fetchCandidate(candidate, {
              deckVersion: request.deckVersion,
              manifestHash: request.manifestHash,
              deadlineAtMs,
              signal: controller.signal,
            });
            return result.outcome === "FETCHED" ? result.evidence : null;
          } catch {
            // A provider or origin failure is an internal-only degradation path.
            return null;
          }
        }),
      );
      return fetched.filter((item): item is RetrievedEvidence => item !== null);
    })();
    try {
      return await Promise.race([external, deadline]);
    } finally {
      removeDeadline();
      parentSignal.removeEventListener("abort", abortFromParent);
      controller.abort("external search complete");
    }
  }

  /**
   * Runs one model slot with at most ONE duplicate in flight, inside the caller's existing
   * deadline and against the same model, schema and trusted context. The duplicate starts only
   * while the primary is still pending at `hedgeAtMs`, so a slot that settles at its usual
   * latency never doubles provider load. This is not a retry: a primary that settles with an
   * error is reported as-is and never causes a new call to be started.
   */
  async #hedgedModel<Output>(
    capability: "rerank" | "llm" | "verifier",
    input: unknown,
    schema: z.ZodType<Output>,
    context: ReturnType<typeof createTrustedModelContext>,
    hedgeAtMs: number | null,
  ): Promise<
    Readonly<{ ok: true; output: Output }> | Readonly<{ ok: false; errorCode: ModelErrorCode }>
  > {
    const primary = this.#model(capability, input, schema, context);
    if (hedgeAtMs === null) return await primary;

    let removeTrigger: () => void = () => undefined;
    const triggered = new Promise<"HEDGE">((resolve) => {
      removeTrigger = this.#scheduler.schedule(hedgeAtMs, () => resolve("HEDGE"));
    });
    const primaryArm = primary.then((result) => ({ from: "PRIMARY" as const, result }));
    // Marks the arm handled so a losing rejection is never reported as unhandled; the awaited
    // reference below still surfaces a genuine throw exactly as it did before hedging existed.
    void primaryArm.catch(() => undefined);
    let first: Awaited<typeof primaryArm> | "HEDGE";
    try {
      first = await Promise.race([primaryArm, triggered]);
    } finally {
      removeTrigger();
    }
    if (first !== "HEDGE") return first.result;

    this.#stageObserver?.observeHedge?.({ stage: capability, outcome: "STARTED" });
    const hedgeArm = this.#model(capability, input, schema, context).then((result) => ({
      from: "HEDGE" as const,
      result,
    }));
    void hedgeArm.catch(() => undefined);
    const settled = await Promise.race([primaryArm, hedgeArm]);
    if (settled.result.ok) {
      this.#stageObserver?.observeHedge?.({
        stage: capability,
        outcome: settled.from === "HEDGE" ? "HEDGE_WON" : "PRIMARY_WON",
      });
      return settled.result;
    }
    const other = await (settled.from === "PRIMARY" ? hedgeArm : primaryArm);
    this.#stageObserver?.observeHedge?.({
      stage: capability,
      outcome: other.result.ok
        ? other.from === "HEDGE"
          ? "HEDGE_WON"
          : "PRIMARY_WON"
        : "BOTH_FAILED",
    });
    return other.result.ok ? other.result : settled.result;
  }

  async #model<Output>(
    capability: "embedding" | "rerank" | "llm" | "verifier",
    input: unknown,
    schema: z.ZodType<Output>,
    context: ReturnType<typeof createTrustedModelContext>,
  ): Promise<
    Readonly<{ ok: true; output: Output }> | Readonly<{ ok: false; errorCode: ModelErrorCode }>
  > {
    const result = await this.#router.invoke({ capability, input }, context);
    if (!result.ok) {
      this.#stageObserver?.observe({
        stage: capability,
        outcome: "FAILED",
        latencyMs: result.metadata.latencyMs,
        errorCode: result.error.code,
      });
      return { ok: false, errorCode: result.error.code };
    }
    const parsed = schema.safeParse(result.output);
    if (!parsed.success) {
      this.#stageObserver?.observe({
        stage: capability,
        outcome: "FAILED",
        latencyMs: result.metadata.latencyMs,
        errorCode: "provider_error",
      });
      return { ok: false, errorCode: "provider_error" };
    }
    this.#stageObserver?.observe({
      stage: capability,
      outcome: "SUCCESS",
      latencyMs: result.metadata.latencyMs,
    });
    return { ok: true, output: parsed.data };
  }
}

function modelReason(
  errorCode: ModelErrorCode,
): "MODEL_FAILURE" | "BUDGET_EXCEEDED" | "DEADLINE_EXCEEDED" {
  if (errorCode === "budget_exceeded" || errorCode === "quota_exceeded") return "BUDGET_EXCEEDED";
  if (errorCode === "deadline_exceeded" || errorCode === "cancelled") return "DEADLINE_EXCEEDED";
  return "MODEL_FAILURE";
}

function abstain(
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
