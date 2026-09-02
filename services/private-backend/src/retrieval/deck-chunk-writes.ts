import type { Sql } from "postgres";
import { DECK_CORPUS_KIND, type RetrievalRow } from "./deck-retrieval-model.ts";

type ChunkInsertRow = RetrievalRow & Readonly<{ corpus_kind?: string }>;

export async function insertChunkRow(sql: Sql, row: ChunkInsertRow): Promise<void> {
  await sql`
    INSERT INTO private_app.deck_retrieval_chunks (
      tenant_id, object_id, source_id, source_revision, source_hash,
      deck_version, manifest_hash, title, anchor, content, embedding,
      authorization_version, corpus_kind
    ) VALUES (
      ${row.tenant_id}, ${row.object_id}, ${row.source_id}, ${row.source_revision},
      ${row.source_hash}, ${row.deck_version}, ${row.manifest_hash}, ${row.title},
      ${row.anchor}, ${row.content}, ${sql.array(row.embedding)}::double precision[],
      ${row.authorization_version}, ${row.corpus_kind ?? DECK_CORPUS_KIND}
    )
    -- object_id is a hash of this chunk's scope and content, so a conflicting row IS this
    -- chunk: re-indexing it must refresh what can legitimately change (its embedding, after
    -- a model or extraction change) instead of failing the whole preparation. Without this a
    -- deck whose rows survived under an earlier manifest aborted every concurrent first-wave
    -- recommendation with a primary-key violation, leaving the corpus empty and the presenter
    -- with no evidence at all.
    ON CONFLICT (tenant_id, object_id) DO UPDATE SET
      source_id = EXCLUDED.source_id,
      source_revision = EXCLUDED.source_revision,
      source_hash = EXCLUDED.source_hash,
      deck_version = EXCLUDED.deck_version,
      manifest_hash = EXCLUDED.manifest_hash,
      title = EXCLUDED.title,
      anchor = EXCLUDED.anchor,
      content = EXCLUDED.content,
      embedding = EXCLUDED.embedding,
      authorization_version = EXCLUDED.authorization_version,
      corpus_kind = EXCLUDED.corpus_kind
  `;
}
