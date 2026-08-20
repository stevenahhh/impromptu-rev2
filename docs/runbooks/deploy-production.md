# Production deployment runbook

## Scope

`compose.production.yaml` deploys one PostgreSQL 17 cluster, the private backend, projection
gateway, Presenter Console, and public Stage. The private and public browser surfaces expose only
ports 4173 and 4174 by default. Bun services and PostgreSQL remain on internal Compose networks.

The database migrations preserve the repository's three-way boundary:

- `postgres`: bootstrap and migration ledger only;
- `impromptu_private`: private authority data, connected as `private_app`;
- `impromptu_projection`: public projection data and dispatcher functions, with
  `projection_app` and `publication_dispatcher` privileges.

Both Bun services persist coordinator state in PostgreSQL: private-backend connects only as
`private_app`, and projection-gateway connects only as `projection_app`. Public projection dispatch
continues to use the separate `publication_dispatcher` role. Do not point Stage or Console directly
at either database.

## Prerequisites

- Docker Engine with Compose v2 and at least 8 GiB available for the first build.
- DNS and TLS termination for Console, Stage, the server-side private API, and the public projection API.
- Persistent storage for the PostgreSQL and deck artifact volumes and an encrypted backup destination.
- Outbound image access to Docker Hub, `ghcr.io`, and Python package indexes during builds.

## Secrets and configuration

1. Copy `.env.example` to `.env`.
2. Replace every `change-me` value. Generate independent values; do not reuse a database password.
3. Restrict database passwords to URL-safe `A-Z`, `a-z`, `0-9`, `_`, and `-`. Compose embeds them in
   PostgreSQL URLs.
4. Set all four public/API origins to exact HTTPS origins without trailing slashes. Route the
   private API TLS virtual host to loopback `PRIVATE_BACKEND_PUBLISH_PORT`, and the projection API
   TLS virtual host to loopback `PROJECTION_GATEWAY_PUBLISH_PORT`. Never route the private backend
   through the Stage virtual host.
5. Rebuild Console or Stage whenever a build-time origin, service-worker cohort, or co-resident
   mode changes.
6. Keep `LIVE_PUBLICATION_GATE_STATE=BLOCKED` until the release approval gate has passed.

Required secrets are:

- `SERVICE_AUTH_TOKEN` (at least 32 random characters);
- `CONTROLLER_PASSWORD`;
- `CHAT_MODEL_API_KEY` (OpenCode Go; shared only by rerank, LLM, and verifier slots);
- `EMBEDDING_MODEL_API_KEY` (local TLS embedding server; never sent to the chat origin);
- `POSTGRES_BOOTSTRAP_PASSWORD`;
- `MIGRATION_DATABASE_PASSWORD`;
- `PRIVATE_DATABASE_PASSWORD`;
- `PROJECTION_DATABASE_PASSWORD`;
- `PUBLICATION_DISPATCHER_DATABASE_PASSWORD`;
- `RETENTION_DATABASE_PASSWORD`.

Set `CHAT_MODEL_BASE_URL=https://opencode.ai/zen/go/v1`. For local development, use
`EMBEDDING_MODEL_BASE_URL=https://127.0.0.1:8443/v1`, `EMBEDDING_MODEL=embeddinggemma`, and
`EMBEDDING_MODEL_API_KEY=local-embedding-token`; that model emits exactly 768 dimensions. Both base
URLs must remain credential-free HTTPS URLs and the embedding endpoint must provide real TLS.
`NODE_EXTRA_CA_CERTS=/Users/gahn/Library/Application Support/mkcert/rootCA.pem` is only for trusting
the mkcert endpoint during local macOS development. Do not put that workstation path in
`compose.production.yaml`; production may use a different embedding HTTPS origin and should use its
platform trust store. Set `RERANK_MODEL`, `LLM_MODEL`, and `VERIFIER_MODEL` to
`deepseek-v4-flash`. The backend binds each adapter ID to its exact origin and injects only that
slot's secret.

Store `.env` in the deployment host's secret store with owner-only permissions. Never commit it.
The bootstrap and migration credentials are deployment-only. Application containers receive only
their role-specific credentials: `private_app` for private-backend and `projection_app` for
projection-gateway.

## Build and preflight

From the repository root:

```sh
docker compose --env-file .env -f compose.production.yaml config --quiet
docker compose --env-file .env -f compose.production.yaml build --pull
```

The private-backend image includes Bun 1.3.14, Node 26 for isolated model adapters, Python 3.14,
uv, and LibreOffice Impress. The Console image uses Next.js standalone output and its generated
`server.js` launcher, which is the production equivalent of `next start` for standalone builds.
The Stage image serves immutable Vite output through unprivileged Nginx. Its production bundle
uses `STAGE_PUBLIC_API_ORIGIN` for API, SSE, asset, and WebSocket traffic; that origin must terminate
TLS and forward to the loopback-published projection gateway.

## Deploy

```sh
docker compose --env-file .env -f compose.production.yaml up -d --remove-orphans
docker compose --env-file .env -f compose.production.yaml ps
```

Startup ordering is strict: PostgreSQL health, one-shot migrations, projection-gateway health,
private-backend health, then browser surfaces. A failed `database-migrate` container prevents the
application from starting. Inspect it rather than bypassing it:

```sh
docker compose --env-file .env -f compose.production.yaml logs database-migrate
```

The migration runner is checksum-protected and safe to rerun with unchanged migration files.
Never edit an applied migration.

## Health and smoke checks

All HTTP containers expose `/health`:

```sh
set -a; . ./.env; set +a
curl --fail --silent --show-error "${CONSOLE_PUBLIC_ORIGIN}/health"
curl --fail --silent --show-error "${STAGE_PUBLIC_ORIGIN}/health"
curl --fail --silent --show-error "${CONSOLE_PRIVATE_API_ORIGIN}/health"
curl --fail --silent --show-error "${STAGE_PUBLIC_API_ORIGIN}/health"
docker compose --env-file .env -f compose.production.yaml exec private-backend \
  bun -e "const r=await fetch('http://127.0.0.1:3001/health'); console.log(r.status); process.exit(r.ok?0:1)"
docker compose --env-file .env -f compose.production.yaml exec projection-gateway \
  bun -e "const r=await fetch('http://127.0.0.1:3002/health'); console.log(r.status); process.exit(r.ok?0:1)"
```

Then perform a browser smoke test:

1. Sign in to Console with the configured bootstrap controller.
2. Upload a sample PDF and wait for rendering to complete.
3. Open Stage from Console and approve the display binding.
4. Change slides and verify Stage reconciliation and receipt delivery.
5. Confirm no private transcript, candidate, or credential appears in Stage network responses.

## Logs and operational checks

```sh
docker compose --env-file .env -f compose.production.yaml logs --since 15m \
  private-backend projection-gateway console stage
docker compose --env-file .env -f compose.production.yaml ps --format json
```

Treat repeated render deadlines, persisted-state validation failures, database readiness failures,
migration checksum failures, rate-limit saturation, or service-auth 401/403 responses as deployment
failures. The optional `LOGIN_*_RATE_LIMIT_*` and `PROJECTION_*_RATE_LIMIT_*` settings must be
positive finite numbers. Keep `PRIVATE_PREPARED_EVIDENCE_STATE_KEY` and
`PROJECTION_GATEWAY_STATE_KEY` at `default` for a normal deployment; CAS rejects multiple active
writers for the same key. Do not rotate `SERVICE_AUTH_TOKEN` on one Bun service at a time; update
both and recreate them together.

## Backup and restore

Back up PostgreSQL and the durable deck artifact volume before every release:

```sh
docker compose --env-file .env -f compose.production.yaml exec -T postgres \
  pg_dumpall --username impromptu_bootstrap > "impromptu-postgres-$(date +%Y%m%d%H%M%S).sql"
docker run --rm \
  -v impromptu-production_deck-artifacts:/source:ro \
  -v "$PWD/backups:/backup" alpine:3.22 \
  tar -C /source -czf /backup/deck-artifacts.tgz .
```

Prepared-evidence state for both authorities is included in the role-separated PostgreSQL dumps;
there are no filesystem state snapshots to restore.

For a restore, stop application containers, restore PostgreSQL and the deck volume to an isolated host,
run `database-migrate`, verify all `/health` endpoints, and complete the browser smoke test before
switching traffic.

## Upgrade and rollback

1. Back up data and record the current `IMAGE_TAG`.
2. Set a new immutable image tag and run the build/preflight commands.
3. Run `up -d --remove-orphans` and complete health and browser smoke checks.
4. If application checks fail and no forward-only migration blocks rollback, restore the previous
   `IMAGE_TAG` and recreate the four application containers.
5. If a migration changed durable data, do not run an older binary against the new schema. Restore
   the pre-deployment database/volume backups or deploy a forward fix.

```sh
docker compose --env-file .env -f compose.production.yaml up -d --no-deps --force-recreate \
  projection-gateway private-backend console stage
```

## Shutdown

```sh
docker compose --env-file .env -f compose.production.yaml down
```

Do not add `--volumes` during routine shutdown. That flag deletes PostgreSQL, staged uploads, and
rendered deck artifacts.
