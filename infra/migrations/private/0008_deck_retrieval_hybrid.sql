SET ROLE impromptu_owner;

ALTER TABLE private_app.deck_retrieval_chunks
  ADD COLUMN search_vector tsvector
    GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED;

CREATE INDEX deck_retrieval_search_vector_idx
  ON private_app.deck_retrieval_chunks
  USING GIN (search_vector);

ALTER TABLE private_app.deck_retrieval_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_app.deck_retrieval_chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON private_app.deck_retrieval_chunks
  AS PERMISSIVE FOR ALL TO private_app
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
