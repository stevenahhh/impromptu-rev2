# Production deployment runbook

## Scope

`compose.production.yaml` deploys one PostgreSQL 17 cluster, the private backend, projection
gateway, Presenter Console, and public Stage. All container host ports bind to loopback; only
a separately configured HTTPS reverse proxy exposes the two browser surfaces. Bun services and
PostgreSQL remain on internal Compose networks.

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
- DNS and TLS termination for Console, Stage, and the server-side private API.
- Persistent storage for the PostgreSQL and deck artifact volumes and an encrypted backup destination.
- Outbound image access to Docker Hub, `ghcr.io`, and Python package indexes during builds.
- A reachable 768-dimensional HTTPS embedding endpoint. The Compose file does not start one.
- If microphone transcription is required, an ffmpeg binary, a pinned whisper.cpp CLI, and its
  model inside the backend container. The current backend image does not include them.
  The empty paths in `.env.example` disable the audio adapter; audio routes fail closed.

For a single-VM deployment, `infra/deploy/Caddyfile` supplies the missing HTTPS edge. Point
three DNS names at the VM: Console, Stage, and the authenticated private API. Set
`CONSOLE_PUBLIC_ORIGIN`, `STAGE_PUBLIC_ORIGIN`, and `CONSOLE_PRIVATE_API_ORIGIN` in `.env` to
their exact `https://` origins. On the VM, configure Caddy's `CONSOLE_PUBLIC_HOST`,
`STAGE_PUBLIC_HOST`, `PRIVATE_API_PUBLIC_HOST` (hostnames without a scheme), and
`ACME_EMAIL`, then validate with `caddy validate --config infra/deploy/Caddyfile --adapter
caddyfile`. Permit inbound TCP 80 and 443 only; Caddy obtains certificates and proxies
Console to loopback 4173, Stage to loopback 4174, and the private API to loopback 3001.
The private API edge denies `/internal/*`; gateway 3002 and PostgreSQL are never public.
The Stage container keeps `/v1` on the Stage origin for its Strict session cookie,
unbuffered SSE, and WebSocket. Keep the VM's Caddy certificate state on persistent storage.

## Secrets and configuration

1. Copy `.env.example` to `.env`.
2. Replace every `change-me` value. Generate independent values; do not reuse a database password.
3. Restrict database passwords to URL-safe `A-Z`, `a-z`, `0-9`, `_`, and `-`. Compose embeds them in
   PostgreSQL URLs.
4. Set the Console and Stage origins to their exact public HTTPS origins. For
   `CONSOLE_PRIVATE_API_ORIGIN` prefer the internal `http://private-backend:3001` Compose service
   name, which is allowed only for that server-side hop inside the application network; the
   externally routed form still requires HTTPS via the private API virtual host, which proxies to
   loopback `PRIVATE_BACKEND_PUBLISH_PORT` and denies `/internal/*`. The Stage virtual host
   reaches the projection gateway through the Stage container's same-origin `/v1` proxy; do not
   publish gateway port 3002.
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
the identifiers provisioned by that provider (`.env.example` pins a separate verifier model).
The backend binds each adapter ID to its exact origin and injects only that slot's secret.
OpenCode Go requires a paid subscription; the example credentials and local embedding endpoint
do not constitute a free, working model setup.

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
The Stage image serves immutable Vite output through unprivileged Nginx, which also proxies `/v1`
to the projection gateway. API, SSE, asset, and WebSocket traffic therefore all reach the browser
on `STAGE_PUBLIC_ORIGIN` itself, and `STAGE_PUBLIC_API_ORIGIN` is left unset.

This is a correctness requirement, not a preference. The gateway issues the audience display its
session as a `SameSite=Strict` cookie, and a browser discards such a cookie when it arrives on a
cross-site response, so a Stage bundle pointed at a gateway on a different registrable domain
loses its session the moment it is issued and every later snapshot and event request is rejected —
with no error on the presenter's side. Any edge or CDN placed in front of Stage must keep `/v1` on
the same host as the page, forward the WebSocket upgrade headers, leave `text/event-stream`
responses unbuffered and uncompressed, and allow an idle read of at least 60 seconds. The gateway
emits a comment ping every 20 seconds so a quiet stretch of the talk does not look idle.

Terminate HTTP/2 for `STAGE_PUBLIC_ORIGIN` at that edge. Serving Stage from one origin puts the
page, its assets, the event stream and the WebSocket in a single connection pool, and HTTP/1.1
caps a pool at six connections per origin while the event stream holds one open for the length of
the talk.

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
# The Stage public API is same-origin at /v1; no STAGE_PUBLIC_API_ORIGIN is configured.
# The gateway health route is internal, not exposed on a separate browser origin.
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
