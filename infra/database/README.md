# Database migration harness

This harness starts one disposable PostgreSQL 17 cluster with three databases:

- `postgres`: bootstrap and cluster migration ledger only;
- `impromptu_private`: tenant-owned sessions, candidates, and publication outbox;
- `impromptu_projection`: public projection storage, closed views, and display receipts.

Keeping private and projection relations in separate databases means a `projection_app` connection has no private relation rows in `pg_catalog` from which to infer names or sizes. The role also lacks `CONNECT` and `TEMPORARY` on `postgres` and `impromptu_private`, cannot measure the private database, and cannot execute PostgreSQL large-object mutation functions.

## Run

Requirements: Bun, Docker Engine, and Docker Compose.

```bash
bun run test:db
bun run test:db:harness
bun run test:db:concurrent
```

The primary command tests fresh installation, migration-ledger reruns, checksum drift, transactional rollback after an interrupted migration, role escalation, catalog noninterference, tenant and projection RLS, audience-card lifecycle filtering, concurrent idempotent receipt writes, and concurrent publication dispatch deduplication.

The harness uses `docker compose up --wait`; it has no sleeps or timing-based polling. Every invocation generates a unique Compose project name. Teardown preserves the original test status, treats cleanup or resource-inspection failure as a failure when tests passed, and verifies that project-labeled containers, networks, and volumes are absent before printing success. The two additional commands exercise cleanup-failure handling and simultaneous worktree-safe projects.

The Compose password is local-test-only, no database port is published, and database storage is a `tmpfs`. Production credentials must be provisioned outside these migrations.

## Role and database boundary

| Role | Login | Intended database access |
| --- | --- | --- |
| `impromptu_owner` | No | Owns application databases and objects. |
| `migration` | Yes | Deployment-only access to both application databases; may assume the owner. |
| `private_app` | Yes | Private database only; cannot connect to the projection database. |
| `publication_dispatcher` | Yes | Claims the private outbox and calls the narrow projection dispatch function. |
| `projection_app` | Yes | Projection database only; reads closed views and calls the receipt function. |

`private_app` must set `app.tenant_id` with `SET LOCAL` inside each private transaction. Forced RLS returns no rows without a context and rejects rows for another tenant. This protects against missing or stale application query scoping; it does not make a compromised `private_app` credential untrusted, because that service role can choose its own transaction context.

## Cross-database publication consequence

PostgreSQL cannot atomically commit ordinary transactions across these databases. A publish transaction therefore writes a durable `private_app.publication_outbox` row in `impromptu_private`; `publication_dispatcher` claims a bounded batch, applies each closed public DTO through `public_projection.dispatch_publication`, and marks accepted rows delivered in the private transaction.

That is an at-least-once handoff: a private commit failure can repeat an already-applied event. The projection inbox atomically deduplicates the dispatch key and rejects key reuse with different content. `private_app` has neither projection database connectivity nor projection schema privileges; only the dispatcher function can accept publication writes.

## Migration runner

`infra/database/migrate.sh` accepts these required connection URLs:

```text
BOOTSTRAP_DATABASE_URL
PRIVATE_MIGRATION_DATABASE_URL
PROJECTION_MIGRATION_DATABASE_URL
```

It applies `infra/migrations/{cluster,private,projection}` in lexical order. Every applied filename and SHA-256 checksum is recorded in that database's `_migrations.applied_migrations` table. An unchanged rerun is a no-op; changed applied SQL fails before execution. Private and projection migrations execute with DDL and ledger insertion in one transaction. The cluster bootstrap contains `CREATE DATABASE`, so it cannot be transactional; its statements are idempotent to support recovery before its ledger row is written.

Migration rules:

- Cluster migrations run only through the bootstrap URL.
- Application migrations connect as `migration` and explicitly `SET ROLE impromptu_owner`.
- Never edit an applied migration; add the next ordered file.
- Revoke `PUBLIC` privileges before granting a runtime surface.
- Stage-facing reads belong in lifecycle-filtered `public_projection` views; writes require narrow, explicitly granted functions or the private publication path.
