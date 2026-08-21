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

const TERMINAL_DEADLINE_GUARD_MS = 500;
const EXTERNAL_BRANCH_DEADLINE_MS = 1_800;
const MAX_MODEL_EVIDENCE = 2;
const MAX_MODEL_CONTENT_CHARACTERS = 700;

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

export interface RecommendationStageObserver {
  observe(event: RecommendationModelStageEvent): void;
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
    const deadlineAtMs = startedAtMs + 5_000;
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
    evidence.push(...(await externalEvidence));
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
    const [reranked, structured] = await Promise.all([
      this.#model(
        "rerank",
        { task: "RERANK_EVIDENCE", query: request.data.query, untrustedData: rerankData },
        rerankOutputSchema,
        trustedContext,
      ),
      this.#model(
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
      return abstain("DETERMINISTIC_MISMATCH", startedAtMs, this.#now());
    }
    const selected = canonicalStructured.evidenceIds
      .map((id) => evidenceById.get(id))
      .filter((item): item is RetrievedEvidence => item !== undefined);
    if (selected.length === 0) return abstain("INSUFFICIENT_EVIDENCE", startedAtMs, this.#now());

    const verified = await this.#model(
      "verifier",
      {
        task: "VERIFY_RECOMMENDATION",
        constraints: { untrustedEvidence: true, mayAuthorize: false, mayPublish: false },
        recommendation: structured.output,
        untrustedData: generationData.filter((item) => selectedAliases.includes(item.evidenceId)),
      },
      VerifierModelOutputSchema,
      trustedContext,
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
