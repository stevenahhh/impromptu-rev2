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
import type {
  AuthorizedEvidenceReference,
  InternalRetrievalService,
} from "../retrieval/internal-retrieval.ts";
import { reconcileEvidence } from "./deterministic-evidence.ts";

const TERMINAL_DEADLINE_GUARD_MS = 500;

const embeddingOutputSchema = z
  .object({ vector: z.array(z.number().finite()).min(1).max(8_192) })
  .strict();
const rerankOutputSchema = z
  .object({ orderedEvidenceIds: z.array(z.string().min(1)).max(20) })
  .strict();

export interface RecommendationPrincipalContext {
  readonly tenantId: string;
  readonly principalId: string;
  readonly policyVersion: string;
}

export interface RecommendationContextAuthority {
  resolve(accountSessionId: string): Promise<RecommendationPrincipalContext | null>;
}

export interface ExternalSearchBoundary {
  search(query: string, signal: AbortSignal): Promise<readonly SearchCandidate[]>;
}

export class PrivateRecommendationPipeline {
  readonly #router: Pick<ServerModelRouter, "invoke">;
  readonly #contexts: RecommendationContextAuthority;
  readonly #internal: InternalRetrievalService;
  readonly #externalSearch: ExternalSearchBoundary | undefined;
  readonly #externalFetch: SafeExternalEvidenceFetcher | undefined;
  readonly #now: () => number;
  readonly #scheduler: DeadlineScheduler;
  readonly #publicationReferences = new Map<string, AuthorizedEvidenceReference>();
  readonly #publicationEvidence = new Map<string, RetrievedEvidence>();

  constructor(dependencies: {
    readonly router: Pick<ServerModelRouter, "invoke">;
    readonly contexts: RecommendationContextAuthority;
    readonly internal: InternalRetrievalService;
    readonly externalSearch?: ExternalSearchBoundary;
    readonly externalFetch?: SafeExternalEvidenceFetcher;
    readonly now?: () => number;
    readonly scheduler?: DeadlineScheduler;
  }) {
    this.#router = dependencies.router;
    this.#contexts = dependencies.contexts;
    this.#internal = dependencies.internal;
    this.#externalSearch = dependencies.externalSearch;
    this.#externalFetch = dependencies.externalFetch;
    this.#now = dependencies.now ?? Date.now;
    this.#scheduler = dependencies.scheduler ?? new SystemDeadlineScheduler(this.#now);
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

    const embedded = await this.#model(
      "embedding",
      { task: "EMBED_RETRIEVAL_QUERY", query: request.data.query },
      embeddingOutputSchema,
      trustedContext,
    );
    if (!embedded.ok) return abstain(modelReason(embedded.errorCode), startedAtMs, this.#now());

    const references = await this.#internal.retrieve(
      accountSessionId,
      request.data,
      embedded.output.vector,
    );
    const evidence: RetrievedEvidence[] = [];
    const referenceByEvidenceId = new Map<string, AuthorizedEvidenceReference>();
    for (const reference of references) {
      const materialized = await this.#internal.materialize(reference);
      if (materialized.outcome === "MATERIALIZED") {
        evidence.push(materialized.evidence);
        referenceByEvidenceId.set(materialized.evidence.evidenceId, reference);
      }
    }
    if (
      this.#externalSearch !== undefined &&
      this.#externalFetch !== undefined &&
      !signal.aborted
    ) {
      let candidates: readonly SearchCandidate[] = [];
      try {
        candidates = await this.#externalSearch.search(request.data.query, signal);
      } catch {
        candidates = [];
      }
      for (const candidate of candidates.slice(0, request.data.maxResults)) {
        const fetched = await this.#externalFetch.fetchCandidate(candidate, {
          deckVersion: request.data.deckVersion,
          manifestHash: request.data.manifestHash,
          deadlineAtMs,
          signal,
        });
        if (fetched.outcome === "FETCHED") evidence.push(fetched.evidence);
      }
    }
    if (signal.aborted) return abstain("DEADLINE_EXCEEDED", startedAtMs, deadlineAtMs);
    if (evidence.length === 0) return abstain("INSUFFICIENT_EVIDENCE", startedAtMs, this.#now());

    const reranked = await this.#model(
      "rerank",
      {
        task: "RERANK_EVIDENCE",
        query: request.data.query,
        untrustedData: evidence.map((item) => ({
          evidenceId: item.evidenceId,
          content: item.content,
        })),
      },
      rerankOutputSchema,
      trustedContext,
    );
    if (!reranked.ok) return abstain(modelReason(reranked.errorCode), startedAtMs, this.#now());
    const evidenceById = new Map(evidence.map((item) => [item.evidenceId, item]));
    const ordered = reranked.output.orderedEvidenceIds
      .map((id) => evidenceById.get(id))
      .filter((item): item is RetrievedEvidence => item !== undefined)
      .slice(0, request.data.maxResults);
    if (ordered.length === 0) return abstain("INSUFFICIENT_EVIDENCE", startedAtMs, this.#now());

    const structured = await this.#model(
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
        untrustedData: ordered.map((item) => ({
          evidenceId: item.evidenceId,
          content: item.content,
        })),
      },
      StructuredRecommendationSchema,
      trustedContext,
    );
    if (!structured.ok) return abstain(modelReason(structured.errorCode), startedAtMs, this.#now());
    const deterministic = reconcileEvidence(structured.output, ordered);
    if (deterministic.outcome === "MISMATCH") {
      return abstain("DETERMINISTIC_MISMATCH", startedAtMs, this.#now());
    }

    const verified = await this.#model(
      "verifier",
      {
        task: "VERIFY_RECOMMENDATION",
        constraints: { untrustedEvidence: true, mayAuthorize: false, mayPublish: false },
        recommendation: structured.output,
        untrustedData: ordered.map((item) => ({
          evidenceId: item.evidenceId,
          content: item.content,
        })),
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

    const selected = structured.output.evidenceIds
      .map((id) => evidenceById.get(id))
      .filter((item): item is RetrievedEvidence => item !== undefined);
    if (selected.length === 0) return abstain("INSUFFICIENT_EVIDENCE", startedAtMs, this.#now());
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
      recommendation: structured.output,
      evidence: selected,
      completedAtMs,
      latencyMs: completedAtMs - startedAtMs,
    });
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
    if (!result.ok) return { ok: false, errorCode: result.error.code };
    const parsed = schema.safeParse(result.output);
    return parsed.success
      ? { ok: true, output: parsed.data }
      : { ok: false, errorCode: "provider_error" };
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
