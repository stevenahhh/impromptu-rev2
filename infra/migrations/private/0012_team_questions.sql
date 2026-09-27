SET ROLE impromptu_owner;

-- Question-only teammate grants and the owner's private question inbox (plan task 8).
-- A grant is session-scoped and revocable: the owner targets one teammate account and the
-- teammate may append bounded question text only while the grant is live. The invitation
-- token itself is never stored; only its SHA-256 digest is persisted, and redeeming it is
-- a one-use acceptance recorded on the row. Grants and questions confer no read authority
-- over decks, reports, playback, or other tenants' rows.

CREATE TABLE private_app.team_question_grants (
  tenant_id uuid NOT NULL,
  session_id uuid NOT NULL,
  grant_id text NOT NULL CHECK (grant_id ~ '^tqg_[0-9a-f]{32}$'),
  owner_account_id text NOT NULL
    REFERENCES private_app.accounts(account_id) ON DELETE CASCADE,
  teammate_account_id text NOT NULL
    REFERENCES private_app.accounts(account_id) ON DELETE CASCADE,
  teammate_username text NOT NULL CHECK (length(teammate_username) BETWEEN 1 AND 64),
  invitation_digest text NOT NULL CHECK (invitation_digest ~ '^[0-9a-f]{64}$'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  revocation_revision bigint NOT NULL DEFAULT 1 CHECK (revocation_revision >= 1),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, grant_id),
  UNIQUE (invitation_digest),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, session_id)
    REFERENCES private_app.presentation_sessions(tenant_id, session_id) ON DELETE CASCADE,
  CHECK (owner_account_id <> teammate_account_id),
  CHECK (accepted_at IS NULL OR accepted_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (expires_at > created_at)
);

CREATE INDEX team_question_grants_teammate_idx
  ON private_app.team_question_grants (teammate_account_id);

CREATE TABLE private_app.team_questions (
  tenant_id uuid NOT NULL,
  session_id uuid NOT NULL,
  question_id text NOT NULL CHECK (question_id ~ '^tqq_[0-9a-f]{32}$'),
  grant_id text NOT NULL,
  submitted_by_account_id text NOT NULL
    REFERENCES private_app.accounts(account_id) ON DELETE CASCADE,
  question text NOT NULL CHECK (length(question) BETWEEN 1 AND 2000),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  question_seq bigint NOT NULL GENERATED ALWAYS AS IDENTITY,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, question_id),
  UNIQUE (tenant_id, grant_id, idempotency_key),
  FOREIGN KEY (tenant_id, session_id)
    REFERENCES private_app.presentation_sessions(tenant_id, session_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, grant_id)
    REFERENCES private_app.team_question_grants(tenant_id, grant_id) ON DELETE CASCADE
);

CREATE INDEX team_questions_inbox_idx
  ON private_app.team_questions (tenant_id, session_id, question_seq);

ALTER TABLE private_app.team_question_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_app.team_question_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE private_app.team_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_app.team_questions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON private_app.team_question_grants
  AS PERMISSIVE FOR ALL TO private_app
  USING (tenant_id::text = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id::text = nullif(current_setting('app.tenant_id', true), ''));

-- Narrow targeted-identity exception (not generic cross-tenant SELECT): before the owner's
-- tenant context exists, a teammate resolves only the exact grant aimed at the account its
-- authenticated session resolved to. Visibility is pinned to app.actor_account_id, which the
-- service sets from the session's own account id inside the transaction. All writes still
-- pass through tenant_isolation WITH CHECK under the owner tenant context.
CREATE POLICY teammate_target ON private_app.team_question_grants
  AS PERMISSIVE FOR SELECT TO private_app
  USING (teammate_account_id = nullif(current_setting('app.actor_account_id', true), ''));

CREATE POLICY tenant_isolation ON private_app.team_questions
  AS PERMISSIVE FOR ALL TO private_app
  USING (tenant_id::text = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id::text = nullif(current_setting('app.tenant_id', true), ''));

CREATE POLICY owner_retention ON private_app.team_question_grants
  AS PERMISSIVE FOR ALL TO impromptu_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_retention ON private_app.team_questions
  AS PERMISSIVE FOR ALL TO impromptu_owner USING (true) WITH CHECK (true);

REVOKE ALL PRIVILEGES ON TABLE private_app.team_question_grants FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE private_app.team_questions FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE private_app.team_question_grants TO private_app;
GRANT SELECT, INSERT ON TABLE private_app.team_questions TO private_app;
