SET ROLE impromptu_owner;

-- Authentication occurs before tenant context is established, so these tables
-- intentionally have no tenant_id, RLS, or tenant isolation policy. They are
-- an authentication boundary rather than tenant-owned data.
CREATE TABLE private_app.accounts (
  account_id text PRIMARY KEY,
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  disabled_at timestamptz
);

CREATE UNIQUE INDEX accounts_username_lower_idx
  ON private_app.accounts (lower(username));

CREATE TABLE private_app.account_sessions (
  account_session_id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES private_app.accounts(account_id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX account_sessions_expires_at_idx
  ON private_app.account_sessions (expires_at);

GRANT USAGE ON SCHEMA private_app TO private_app;
GRANT SELECT, INSERT, UPDATE ON private_app.accounts TO private_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON private_app.account_sessions TO private_app;
