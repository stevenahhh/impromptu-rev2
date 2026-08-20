SET ROLE impromptu_owner;

-- Service-wide coordinator state is loaded before a tenant request establishes
-- app.tenant_id, like the authentication tables added in 0004. It therefore
-- intentionally has no tenant RLS; it remains confined to the private database.
CREATE TABLE private_app.prepared_evidence_state (
  state_key text PRIMARY KEY CHECK (length(state_key) BETWEEN 1 AND 200),
  revision bigint NOT NULL CHECK (revision > 0),
  snapshot jsonb NOT NULL CHECK (
    jsonb_typeof(snapshot) = 'object'
    AND snapshot ->> 'stateKind' = 'PREPARED_EVIDENCE_COORDINATOR_SNAPSHOT'
  ),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

REVOKE ALL PRIVILEGES ON TABLE private_app.prepared_evidence_state FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE private_app.prepared_evidence_state TO private_app;
