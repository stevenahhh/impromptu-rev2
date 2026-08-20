# PostgreSQL backup and recovery runbook

This runbook backs up and restores the three-database security topology without merging catalogs or granting cross-role access:

| Database | Backup purpose | Runtime role |
| --- | --- | --- |
| `postgres` | cluster migration ledger and bootstrap metadata | no application runtime access |
| `impromptu_private` | private sessions, prepared evidence, accounts, and publication outbox | `private_app` |
| `impromptu_projection` | public projection state, publication inbox, and receipts | `projection_app` |

Use PostgreSQL 17 client tools against PostgreSQL 17 servers. Run all commands from a non-projected operations host. URLs and dump files contain sensitive operational information; never place them in shell history, application logs, or an unencrypted artifact store.

## Required variables

Provision a backup login that can read every database and dump role definitions. It must not be an application role.

```sh
export BACKUP_ROOT="/secure/impromptu/$(date -u +%Y%m%dT%H%M%SZ)"
export BACKUP_BOOTSTRAP_URL='postgresql://backup@db.example/postgres'
export BACKUP_PRIVATE_URL='postgresql://backup@db.example/impromptu_private'
export BACKUP_PROJECTION_URL='postgresql://backup@db.example/impromptu_projection'
mkdir -m 0700 -p "$BACKUP_ROOT"
```

Supply passwords through an approved secret provider or a mode-0600 `PGPASSFILE`, not URL literals in production.

## Backup

For a logically aligned recovery point, pause private mutations and the publication dispatcher before starting. PostgreSQL cannot provide one transaction snapshot across the private and projection databases. Keep Stage on an approved public fallback until all three dumps finish. If an aligned point is not required, online dumps remain transaction-consistent within each individual database and the durable outbox/inbox handoff remains replayable.

1. Record server and client versions:

   ```sh
   psql "$BACKUP_BOOTSTRAP_URL" -XAtc 'SELECT version()' > "$BACKUP_ROOT/server-version.txt"
   pg_dump --version > "$BACKUP_ROOT/client-version.txt"
   ```

2. Dump cluster roles. Role definitions are cluster-wide rather than database-local, so this adjunct is required to recreate the role boundary before restoring the three `pg_dump` archives:

   ```sh
   pg_dumpall --dbname="$BACKUP_BOOTSTRAP_URL" --globals-only --no-role-passwords \
     > "$BACKUP_ROOT/cluster-globals.sql"
   ```

   Login passwords are intentionally excluded and must be reprovisioned from the secret manager after restore.

3. Create one custom-format archive per database:

   ```sh
   pg_dump "$BACKUP_BOOTSTRAP_URL" --format=custom --create --clean --if-exists \
     --file="$BACKUP_ROOT/postgres.dump"
   pg_dump "$BACKUP_PRIVATE_URL" --format=custom --create --clean --if-exists \
     --file="$BACKUP_ROOT/impromptu_private.dump"
   pg_dump "$BACKUP_PROJECTION_URL" --format=custom --create --clean --if-exists \
     --file="$BACKUP_ROOT/impromptu_projection.dump"
   ```

4. Generate integrity metadata, encrypt the directory with the approved backup system, upload it to retention-controlled storage, and then resume writes:

   ```sh
   (cd "$BACKUP_ROOT" && shasum -a 256 \
     cluster-globals.sql postgres.dump impromptu_private.dump impromptu_projection.dump \
     > SHA256SUMS)
   chmod 0600 "$BACKUP_ROOT"/*
   ```

A backup is incomplete until the encrypted off-host copy and its retention policy are confirmed. Do not delete the previous known-restorable generation merely because a new upload completed.

## Restore

Restore into an isolated PostgreSQL 17 cluster first. Never test a restore over the production cluster.

1. Stop application services and the publication dispatcher. Point `RESTORE_ADMIN_URL` at a maintenance database such as `template1` using a privileged restore identity:

   ```sh
   export RESTORE_ADMIN_URL='postgresql://restore-admin@replacement-db/template1'
   cd /secure/restore/selected-generation
   shasum -a 256 -c SHA256SUMS
   ```

2. Restore role definitions before database objects:

   ```sh
   psql "$RESTORE_ADMIN_URL" -X -v ON_ERROR_STOP=1 -f cluster-globals.sql
   ```

   Reprovision login passwords for `migration`, `private_app`, `projection_app`, `publication_dispatcher`, and `retention_worker` from the secret manager. Preserve `impromptu_owner` as `NOLOGIN` and preserve all `NOINHERIT`, `NOBYPASSRLS`, database `CONNECT`, and `TEMPORARY` restrictions.

3. Restore each database separately. `--create` recreates the original database names and ownership. Use one job unless restore testing has established a safe higher value for the target:

   ```sh
   pg_restore --dbname="$RESTORE_ADMIN_URL" --create --clean --if-exists postgres.dump
   pg_restore --dbname="$RESTORE_ADMIN_URL" --create --clean --if-exists impromptu_private.dump
   pg_restore --dbname="$RESTORE_ADMIN_URL" --create --clean --if-exists impromptu_projection.dump
   ```

4. Run the repository migration runner against the restored databases. An exact-current backup must report every migration as `SKIP`; an older supported backup may apply only newer, checksum-valid migrations:

   ```sh
   BOOTSTRAP_DATABASE_URL='postgresql://migration-admin@replacement-db/postgres' \
   PRIVATE_MIGRATION_DATABASE_URL='postgresql://migration@replacement-db/impromptu_private' \
   PROJECTION_MIGRATION_DATABASE_URL='postgresql://migration@replacement-db/impromptu_projection' \
     sh infra/database/migrate.sh
   ```

## Recovery verification

Do not send traffic to the replacement cluster until every check passes.

1. Verify archive and migration integrity:

   ```sh
   psql 'postgresql://restore-admin@replacement-db/postgres' -XAtc \
     "SELECT count(*), bool_and(checksum ~ '^[0-9a-f]{64}$') FROM _migrations.applied_migrations"
   psql 'postgresql://restore-admin@replacement-db/impromptu_private' -XAtc \
     "SELECT count(*), bool_and(checksum ~ '^[0-9a-f]{64}$') FROM _migrations.applied_migrations"
   psql 'postgresql://restore-admin@replacement-db/impromptu_projection' -XAtc \
     "SELECT count(*), bool_and(checksum ~ '^[0-9a-f]{64}$') FROM _migrations.applied_migrations"
   ```

2. Compare pre-backup and restored row counts for all application tables. At minimum include private prepared-evidence state and undelivered outbox rows, plus projection gateway state and publication inbox rows. Investigate every difference rather than accepting approximate counts.

3. Verify role isolation with the restored runtime credentials:

   - `private_app` connects only to `impromptu_private` and cannot connect to `postgres` or `impromptu_projection`;
   - `projection_app` connects only to `impromptu_projection`, cannot read `public_projection.gateway_state` directly, and can execute only the narrow gateway read/write functions;
   - `publication_dispatcher` retains only private outbox claim/update and projection dispatch-function access;
   - neither runtime role can assume `impromptu_owner`, create large objects, or inspect the other application database.

4. Start one private-backend and one projection-gateway instance against the isolated cluster. Confirm both load their PostgreSQL snapshots, an authoritative Stage snapshot contains no expired/retracted card, and one absolute slide command produces its matching Stage-applied receipt.

5. Start a second instance of each service. Exercise one mutation at a time through the load balancer and confirm stale state writers fail with `PREPARED_EVIDENCE_STATE_CONFLICT` rather than overwriting a newer revision.

6. Resume the publication dispatcher and confirm every undelivered private outbox row reaches `APPLIED` or `DUPLICATE`; verify no dispatch key has conflicting content. Keep the replacement isolated if any row remains ambiguous.

Record the backup generation, SHA-256 manifest, PostgreSQL versions, migration output, row-count comparison, role-isolation results, and application smoke-test receipts in the recovery ticket. Only then promote the replacement cluster and resume mutations.
