SET ROLE impromptu_owner;

CREATE TABLE private_app.deck_retrieval_chunks (
  tenant_id text NOT NULL,
  object_id text NOT NULL,
  source_id text NOT NULL,
  source_revision text NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  deck_version text NOT NULL,
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  title text NOT NULL,
  anchor text NOT NULL,
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 2000),
  embedding double precision[] NOT NULL CHECK (cardinality(embedding) BETWEEN 1 AND 8192),
  authorization_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, object_id)
);

CREATE INDEX deck_retrieval_scope_idx
  ON private_app.deck_retrieval_chunks (
    tenant_id,
    deck_version,
    manifest_hash,
    authorization_version
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON private_app.deck_retrieval_chunks TO private_app;
