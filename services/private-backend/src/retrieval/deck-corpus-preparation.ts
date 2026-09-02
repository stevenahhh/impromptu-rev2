import { readdir } from "node:fs/promises";
import type { RetrievalRequest } from "@impromptu/contracts/retrieval";
import { type DeckArtifactScan, scanDeckArtifacts } from "./deck-artifact-scan.ts";
import { insertChunkRow } from "./deck-chunk-writes.ts";
import {
  AUTHORIZATION_VERSION,
  DECK_CORPUS_KIND,
  type DeckAccessAuthority,
  type DeckEmbeddingPort,
  type DeckIndexLogEvent,
  type DeckIndexLogger,
  type RetrievalRow,
} from "./deck-retrieval-model.ts";
import type { RetrievalPrincipal } from "./internal-retrieval.ts";
import type { TenantScopedPostgresRepository } from "./tenant-scoped-postgres-repository.ts";

const EMPTY_SCAN: DeckArtifactScan = {
  pendingRows: new Map(),
  matchingArtifactCount: 0,
  skippedArtifactCount: 0,
  skippedSlideCount: 0,
  extractableChunkCount: 0,
};

/**
 * Bound on simultaneous chunk embedding calls inside one preparation. The embedding endpoint
 * serves concurrent queries without degrading (a 20-way burst stayed under ~300ms per call),
 * so overlapping calls shorten the advisory-locked critical section that every concurrent
 * first-wave recommendation waits behind: serially embedding a 44-chunk deck took ~13.5s,
 * which alone exceeded the whole recommendation budget twenty times over.
 */
const EMBEDDING_CONCURRENCY = 8;

export interface DeckCorpusPreparationDependencies {
  readonly repository: TenantScopedPostgresRepository;
  readonly artifactRoot: string;
  readonly embedding: DeckEmbeddingPort;
  readonly access: DeckAccessAuthority;
  readonly logger: DeckIndexLogger | undefined;
}

/** Embeds one chunk and validates the provider's answer before it can enter the corpus. */
async function embedChunk(
  embedding: DeckEmbeddingPort,
  content: string,
  principal: RetrievalPrincipal,
): Promise<number[]> {
  const vector = [...(await embedding.embed(content, principal))];
  if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error("Deck embedding provider returned an invalid vector");
  }
  return vector;
}

/** Maps items through an async task with at most `limit` calls in flight, preserving order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await task(item);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function prepareDeckCorpus(
  deps: DeckCorpusPreparationDependencies,
  principal: RetrievalPrincipal,
  request: RetrievalRequest,
): Promise<void> {
  const startedAtMs = Date.now();
  let indexedChunkCount = 0;
  // Zero counts until the artifact scan runs, mirroring the original counters' initial values
  // for any log emitted beforehand (authorization failures, unreadable artifact root).
  let scan: DeckArtifactScan = EMPTY_SCAN;
  const log = (
    outcome: DeckIndexLogEvent["outcome"],
    reason: DeckIndexLogEvent["reason"],
    error?: unknown,
  ) => {
    const errorType =
      error === undefined ? undefined : error instanceof Error ? error.name : "UnknownError";
    const errorMessage =
      error === undefined ? undefined : error instanceof Error ? error.message : String(error);
    deps.logger?.log({
      outcome,
      reason,
      durationMs: Math.max(0, Date.now() - startedAtMs),
      indexedChunkCount,
      matchingArtifactCount: scan.matchingArtifactCount,
      skippedArtifactCount: scan.skippedArtifactCount,
      skippedSlideCount: scan.skippedSlideCount,
      ...(errorType === undefined ? {} : { errorType }),
      ...(errorMessage === undefined ? {} : { errorMessage }),
    });
  };

  let authorized: boolean;
  try {
    authorized = await deps.access.authorize(principal, request);
  } catch (error) {
    log("FAILED", "ACCESS_CHECK_FAILED", error);
    throw error;
  }
  if (!authorized) {
    log("SKIPPED", "ACCESS_DENIED");
    return;
  }

  let artifactIds: readonly string[];
  try {
    artifactIds = await readdir(deps.artifactRoot);
  } catch (error) {
    log("FAILED", "ARTIFACT_ROOT_UNREADABLE", error instanceof Error ? error.name : "UnknownError");
    throw error;
  }

  try {
    scan = await scanDeckArtifacts(
      {
        artifactRoot: deps.artifactRoot,
        tenantId: principal.tenantId,
        deckVersion: request.deckVersion,
        manifestHash: request.manifestHash,
      },
      artifactIds,
    );
    if (scan.matchingArtifactCount === 0) {
      log("SKIPPED", "NO_MATCHING_MANIFEST");
      return;
    }

    // Reference-document chunks share this table but are owned by the upload flow; deck
    // preparation must reconcile and replace only its own slide-derived rows.
    const existingRows = await deps.repository.transaction(
      principal.tenantId,
      async (sql) =>
        sql<readonly Pick<RetrievalRow, "object_id" | "source_revision" | "source_hash">[]>`
          SELECT object_id, source_revision, source_hash
          FROM private_app.deck_retrieval_chunks
          WHERE tenant_id = ${principal.tenantId}
            AND deck_version = ${request.deckVersion}
            AND manifest_hash = ${request.manifestHash}
            AND authorization_version = ${AUTHORIZATION_VERSION}
            AND corpus_kind = ${DECK_CORPUS_KIND}
        `,
    );
    const unchanged =
      existingRows.length === scan.pendingRows.size &&
      existingRows.every((existing) => {
        const pending = scan.pendingRows.get(existing.object_id);
        return (
          pending?.source_revision === existing.source_revision &&
          pending.source_hash === existing.source_hash
        );
      });
    if (unchanged) {
      log("SKIPPED", scan.extractableChunkCount === 0 ? "NO_EXTRACTABLE_TEXT" : "ALREADY_INDEXED");
      return;
    }

    // The advisory lock must cover EMBEDDING as well as writing. Every slide of a freshly
    // uploaded deck asks for a recommendation at once, and each racer used to embed all its
    // chunks before even trying the lock, so N concurrent first requests duplicated the
    // whole provider run and burned their entire deadlines on redundant work while holding
    // nothing that late racers could observe. Holding the lock across embedding makes late
    // racers wait once and then see the winner's committed rows instead of repeating them.
    // A racer that finds this exact scope already written repeats no work; repeating its
    // work would only rewrite identical rows.
    let insertedChunkCount = 0;
    const written = await deps.repository.transaction(principal.tenantId, async (sql) => {
      await sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(
              ${`${principal.tenantId}:${request.deckVersion}:${request.manifestHash}:${DECK_CORPUS_KIND}`},
              0
            )
          )
        `;
      const current = await sql<readonly Pick<RetrievalRow, "object_id">[]>`
          SELECT object_id
          FROM private_app.deck_retrieval_chunks
          WHERE tenant_id = ${principal.tenantId}
            AND deck_version = ${request.deckVersion}
            AND manifest_hash = ${request.manifestHash}
            AND authorization_version = ${AUTHORIZATION_VERSION}
            AND corpus_kind = ${DECK_CORPUS_KIND}
        `;
      if (existingRows.length === 0 && current.length > 0) return false;
      if (current.length > 0) {
        await sql`
            DELETE FROM private_app.deck_retrieval_chunks
            WHERE tenant_id = ${principal.tenantId}
              AND deck_version = ${request.deckVersion}
              AND corpus_kind = ${DECK_CORPUS_KIND}
          `;
      }
      const pendingList = [...scan.pendingRows.values()];
      const vectors = await mapWithConcurrency(pendingList, EMBEDDING_CONCURRENCY, (pending) =>
        embedChunk(deps.embedding, pending.content, principal),
      );
      for (const [offset, row] of pendingList.entries()) {
        await insertChunkRow(sql, {
          ...row,
          embedding: vectors[offset] ?? [],
          corpus_kind: DECK_CORPUS_KIND,
        });
      }
      insertedChunkCount = pendingList.length;
      return true;
    });
    if (!written) {
      log("SKIPPED", "ALREADY_INDEXED");
      return;
    }
    indexedChunkCount = insertedChunkCount;
  } catch (error) {
    log("FAILED", "PREPARATION_FAILED", error);
    throw error;
  }

  if (scan.extractableChunkCount === 0) log("SKIPPED", "NO_EXTRACTABLE_TEXT");
  else log("INDEXED", "COMPLETED");
}
