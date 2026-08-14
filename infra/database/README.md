# Database migration harness

This harness starts one disposable PostgreSQL 17 cluster and validates the database boundary without any application service.

## Run

Requirements: Bun, Docker Engine, and Docker Compose.

```bash
bun run test:db
```

The command uses `docker compose up --wait`; it does not use sleeps or timing-based polling. It applies the role bootstrap migration as `impromptu_bootstrap`, applies later migrations through `migration`, seeds fixtures through `private_app`, and connects directly as `projection_app` for allow/deny checks. The container, network, and temporary data directory are removed on exit.

The Compose password is local-test-only, the database port is not published, and storage is a `tmpfs`. Production credentials must be provisioned outside these migrations.

## Role boundary

| Role | Login | Purpose |
| --- | --- | --- |
| `impromptu_owner` | No | Owns the database and all application objects. |
| `migration` | Yes | Deployment-only principal allowed to assume `impromptu_owner`. |
| `private_app` | Yes | Reads and writes private state and projection base tables. |
| `projection_app` | Yes | Reads public views and calls the narrow display-receipt function. |

`projection_app` has no `USAGE` privilege on `private_app`, no private-table grants, no grants on public projection base tables, and no membership in `private_app`. The runtime test proves each denial against PostgreSQL rather than inferring isolation from migration text.

## Migration contract

- `0001_roles.sql` is the bootstrap-superuser migration and targets the `impromptu` database.
- Every later migration runs as `migration` and must explicitly `SET ROLE impromptu_owner` before creating objects.
- New schemas and objects must revoke `PUBLIC` privileges before granting a runtime surface.
- Stage-facing reads belong in closed `public_projection` views; writes require a narrowly scoped function with an explicit grant.
