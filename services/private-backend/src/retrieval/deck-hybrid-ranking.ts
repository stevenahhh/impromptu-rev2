import type { RetrievalRow } from "./deck-retrieval-model.ts";
import type { AnnCandidate } from "./internal-retrieval.ts";

export const RRF_K = 60;

export function reciprocalRankFusion(
  lexical: readonly RetrievalRow[],
  dense: readonly RetrievalRow[],
): readonly AnnCandidate[] {
  const fused = new Map<
    string,
    { row: RetrievalRow; score: number; seenRetrievers: Set<"LEXICAL" | "DENSE"> }
  >();
  const addRanked = (rows: readonly RetrievalRow[], retriever: "LEXICAL" | "DENSE") => {
    const seenKeys = new Set<string>();
    for (const [offset, row] of rows.entries()) {
      const key = retrievalDedupeKey(row);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const existing = fused.get(key);
      if (existing === undefined) {
        fused.set(key, {
          row,
          score: 1 / (RRF_K + offset + 1),
          seenRetrievers: new Set([retriever]),
        });
      } else if (!existing.seenRetrievers.has(retriever)) {
        existing.score += 1 / (RRF_K + offset + 1);
        existing.seenRetrievers.add(retriever);
        if (row.object_id.localeCompare(existing.row.object_id) < 0) existing.row = row;
      }
    }
  };
  addRanked(lexical, "LEXICAL");
  addRanked(dense, "DENSE");

  return [...fused.values()]
    .map(({ row, score }) => ({
      tenantId: row.tenant_id,
      objectId: row.object_id,
      score,
      indexedSourceRevision: row.source_revision,
      indexedSourceHash: row.source_hash,
      indexedDeckVersion: row.deck_version,
      indexedManifestHash: row.manifest_hash,
      indexedAuthorizationVersion: row.authorization_version,
    }))
    .sort((left, right) => right.score - left.score || left.objectId.localeCompare(right.objectId));
}

function retrievalDedupeKey(row: RetrievalRow): string {
  const chunkIndex = new URLSearchParams(row.anchor).get("chunk") ?? row.anchor;
  // source_id is the manifest's stable identity for the slide represented by slide_key.
  return [row.tenant_id, row.deck_version, row.source_revision, row.source_id, chunkIndex].join(
    "\0",
  );
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number | null {
  if (left.length === 0 || left.length !== right.length) return null;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) return null;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
