import { cosineSimilarity, reciprocalRankFusion } from "./deck-hybrid-ranking.ts";
import type {
  HybridRetrievalDiagnosticObserver,
  LexicalRetrievalRow,
  RetrievalRow,
} from "./deck-retrieval-model.ts";
import type { AnnCandidate, AuthorizedAnnIndex } from "./internal-retrieval.ts";
import type { TenantScopedPostgresRepository } from "./tenant-scoped-postgres-repository.ts";

const MAX_RETRIEVER_CANDIDATES = 20;

export interface HybridSearchDependencies {
  readonly repository: TenantScopedPostgresRepository;
  readonly retrievalDiagnostics: HybridRetrievalDiagnosticObserver | undefined;
}

export async function searchAuthorizedCandidates(
  deps: HybridSearchDependencies,
  input: Parameters<AuthorizedAnnIndex["search"]>[0],
): Promise<readonly AnnCandidate[]> {
  if (input.authorizedObjectIds.length === 0) return [];
  const authorizedIds = [...new Set(input.authorizedObjectIds)].sort();

  // This common RLS read must succeed before either retriever is allowed to contribute.
  const rows = await deps.repository.transaction(
    input.tenantId,
    async (sql) =>
      sql<readonly RetrievalRow[]>`
        SELECT *
        FROM private_app.deck_retrieval_chunks
        WHERE tenant_id = ${input.tenantId}
          AND object_id IN ${sql(authorizedIds)}
      `,
  );
  if (
    rows.length !== authorizedIds.length ||
    rows.some((row) => row.tenant_id !== input.tenantId || !authorizedIds.includes(row.object_id))
  ) {
    throw new Error("Authorized retrieval revision set changed before candidate generation");
  }

  let lexicalRows: readonly LexicalRetrievalRow[] = [];
  try {
    lexicalRows = await deps.repository.transaction(
      input.tenantId,
      async (sql) =>
        sql<readonly LexicalRetrievalRow[]>`
          WITH lexical AS (
            SELECT *,
              ts_rank_cd(search_vector, plainto_tsquery('simple', ${input.query})) AS lexical_score
            FROM private_app.deck_retrieval_chunks
            WHERE tenant_id = ${input.tenantId}
              AND object_id IN ${sql(authorizedIds)}
          )
          SELECT * FROM lexical
          WHERE lexical_score > 0
          ORDER BY lexical_score DESC, object_id ASC
          LIMIT ${MAX_RETRIEVER_CANDIDATES}
        `,
    );
  } catch (error) {
    deps.retrievalDiagnostics?.observe({
      retriever: "LEXICAL",
      failure: "FTS_EXECUTION_FAILED",
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
  }

  const lexical = [...lexicalRows]
    .filter((row) => authorizedIds.includes(row.object_id))
    .sort(
      (left, right) =>
        right.lexical_score - left.lexical_score || left.object_id.localeCompare(right.object_id),
    )
    .slice(0, MAX_RETRIEVER_CANDIDATES);

  let dense: readonly RetrievalRow[] = [];
  if (
    input.queryVector.length === 0 ||
    input.queryVector.some((value) => !Number.isFinite(value))
  ) {
    deps.retrievalDiagnostics?.observe({
      retriever: "DENSE",
      failure: "EMBEDDING_FAILED",
      errorType: "InvalidQueryEmbedding",
    });
  } else {
    dense = rows
      .flatMap((row) => {
        const score = cosineSimilarity(input.queryVector, row.embedding);
        return score === null ? [] : [{ row, score }];
      })
      .sort(
        (left, right) =>
          right.score - left.score || left.row.object_id.localeCompare(right.row.object_id),
      )
      .slice(0, MAX_RETRIEVER_CANDIDATES)
      .map(({ row }) => row);
  }

  return reciprocalRankFusion(lexical, dense).slice(0, input.limit);
}
