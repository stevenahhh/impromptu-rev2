import type { RetrievalRequestSchema, RetrievedEvidence } from "@impromptu/contracts/retrieval";
import type { DeadlineScheduler } from "@impromptu/model-router";
import type { z } from "zod";
import type { SafeExternalEvidenceFetcher, SearchCandidate } from "../retrieval/external-fetch.ts";
import type { ExternalSearchBoundary } from "../retrieval/external-search.ts";
import type {
  AuthorizedEvidenceReference,
  InternalRetrievalService,
} from "../retrieval/internal-retrieval.ts";
import { MAX_MODEL_EVIDENCE } from "./recommendation-model-slots.ts";

const EXTERNAL_BRANCH_DEADLINE_MS = 1_800;

/** Starts the external branch beside embedding: with no external boundary configured, or a
 * parent signal that is already aborted, it resolves immediately and yields nothing. */
export function startExternalEvidenceBranch(dependencies: {
  readonly externalSearch?: ExternalSearchBoundary | undefined;
  readonly externalFetch?: Pick<SafeExternalEvidenceFetcher, "fetchCandidate"> | undefined;
  readonly request: z.infer<typeof RetrievalRequestSchema>;
  readonly parentDeadlineAtMs: number;
  readonly parentSignal: AbortSignal;
  readonly now: () => number;
  readonly scheduler: DeadlineScheduler;
}): Promise<RetrievedEvidence[]> {
  if (
    dependencies.externalSearch === undefined ||
    dependencies.externalFetch === undefined ||
    dependencies.parentSignal.aborted
  ) {
    return Promise.resolve([]);
  }
  return retrieveExternalEvidence({
    externalSearch: dependencies.externalSearch,
    externalFetch: dependencies.externalFetch,
    request: dependencies.request,
    parentDeadlineAtMs: dependencies.parentDeadlineAtMs,
    parentSignal: dependencies.parentSignal,
    now: dependencies.now,
    scheduler: dependencies.scheduler,
  });
}

/** Runs the external search-and-fetch branch under its own child deadline and abort wiring. */
export function retrieveExternalEvidence(dependencies: {
  readonly externalSearch: ExternalSearchBoundary;
  readonly externalFetch: Pick<SafeExternalEvidenceFetcher, "fetchCandidate">;
  readonly request: z.infer<typeof RetrievalRequestSchema>;
  readonly parentDeadlineAtMs: number;
  readonly parentSignal: AbortSignal;
  readonly now: () => number;
  readonly scheduler: DeadlineScheduler;
}): Promise<RetrievedEvidence[]> {
  const { externalSearch, externalFetch, request, now, scheduler } = dependencies;
  const parentDeadlineAtMs = dependencies.parentDeadlineAtMs;
  const parentSignal = dependencies.parentSignal;
  const controller = new AbortController();
  const deadlineAtMs = Math.min(parentDeadlineAtMs, now() + EXTERNAL_BRANCH_DEADLINE_MS);
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
  const removeDeadline = scheduler.schedule(deadlineAtMs, expire);
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
  return (async () => {
    try {
      return await Promise.race([external, deadline]);
    } finally {
      removeDeadline();
      parentSignal.removeEventListener("abort", abortFromParent);
      controller.abort("external search complete");
    }
  })();
}

export interface AssembledRetrieval {
  readonly evidence: RetrievedEvidence[];
  readonly referenceByEvidenceId: Map<string, AuthorizedEvidenceReference>;
}

/**
 * Fans out internal retrieval, materializes each reference, and appends the external branch's
 * evidence after the internal set so candidate ordering stays deterministic.
 */
export async function assembleRetrievedEvidence(dependencies: {
  readonly internal: InternalRetrievalService;
  readonly accountSessionId: string;
  readonly request: z.infer<typeof RetrievalRequestSchema>;
  readonly queryVector: readonly number[];
  readonly externalPromise: Promise<RetrievedEvidence[]>;
}): Promise<AssembledRetrieval> {
  const references = await dependencies.internal.retrieve(
    dependencies.accountSessionId,
    dependencies.request,
    dependencies.queryVector,
  );
  // Each materialization re-authorizes its own reference, so they are independent.
  const materializations = await Promise.all(
    references.map(async (reference) => ({
      reference,
      materialized: await dependencies.internal.materialize(reference),
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
    evidence.push(...(await dependencies.externalPromise));
  } else {
    // Its own child deadline bounds it; marking it handled keeps a late failure from surfacing
    // as an unhandled rejection.
    void dependencies.externalPromise.catch(() => undefined);
  }
  return { evidence, referenceByEvidenceId };
}
