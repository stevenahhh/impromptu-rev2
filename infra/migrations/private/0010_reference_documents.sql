SET ROLE impromptu_owner;

-- Presenter-uploaded reference documents for one presentation session. Their
-- extracted text chunks are stored in private_app.deck_retrieval_chunks with
-- corpus_kind = 'REFERENCE_DOCUMENT'; this table carries the listing metadata.
CREATE TABLE private_app.reference_documents (
  tenant_id text NOT NULL,
  document_id text NOT NULL CHECK (document_id ~ '^[0-9a-f]{64}$'),
  presentation_session_id text NOT NULL,
  filename text NOT NULL,
  content_type text NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length BETWEEN 1 AND 5242880),
  source_revision text NOT NULL CHECK (source_revision ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('INDEXED', 'EMPTY')),
  chunk_count integer NOT NULL CHECK (chunk_count >= 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, document_id)
);

CREATE INDEX reference_documents_scope_idx
  ON private_app.reference_documents (tenant_id, presentation_session_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON private_app.reference_documents TO private_app;

ALTER TABLE private_app.deck_retrieval_chunks
  ADD COLUMN corpus_kind text NOT NULL DEFAULT 'DECK_SLIDE'
    CHECK (corpus_kind IN ('DECK_SLIDE', 'REFERENCE_DOCUMENT'));
