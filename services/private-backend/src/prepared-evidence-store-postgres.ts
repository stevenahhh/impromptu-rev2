import {
  createPreparedEvidenceStore,
  PreparedEvidenceSnapshotError,
  type PreparedEvidenceStore,
  restorePreparedEvidenceStore,
  snapshotPreparedEvidenceStore,
} from "./prepared-evidence.ts";

export type PostgresStateSql = <Rows = readonly Record<string, unknown>[]>(
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
) => PromiseLike<Rows>;

export class PreparedEvidenceStateConflictError extends Error {
  readonly code = "PREPARED_EVIDENCE_STATE_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "PreparedEvidenceStateConflictError";
  }
}

export interface PreparedEvidencePersistence {
  readonly store: PreparedEvidenceStore;
  persist(): Promise<void>;
}

type StateRow = Readonly<{ revision: number | string; snapshot: unknown }>;

function revisionNumber(value: number | string): number {
  const revision = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new PreparedEvidenceSnapshotError("private database revision is invalid");
  }
  return revision;
}

/**
 * Order-insensitive deep JSON comparison: PostgreSQL's jsonb does not preserve object key
 * order, so a snapshot read back from the database must compare equal to an equivalent
 * in-memory snapshot regardless of key order.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Adopts the winner's committed truth in place, keeping the shared store object identity. */
function replaceStoreContents(target: PreparedEvidenceStore, source: PreparedEvidenceStore): void {
  target.accountSessions.clear();
  for (const [key, value] of source.accountSessions) target.accountSessions.set(key, value);
  target.presentations.clear();
  for (const [key, value] of source.presentations) target.presentations.set(key, value);
}

/** Loads one named coordinator state and returns a CAS-backed persistence callback. */
export async function createPostgresPreparedEvidencePersistence(
  sql: PostgresStateSql,
  options: { readonly stateKey?: string } = {},
): Promise<PreparedEvidencePersistence> {
  const stateKey = options.stateKey ?? "default";
  const rows = await sql<readonly StateRow[]>`
    SELECT revision, snapshot
    FROM private_app.prepared_evidence_state
    WHERE state_key = ${stateKey}
  `;
  const row = rows[0];
  let store = createPreparedEvidenceStore();
  let revision = 0;
  if (row !== undefined) {
    const restored = restorePreparedEvidenceStore(row.snapshot);
    if (restored.outcome !== "RESTORED") {
      throw new PreparedEvidenceSnapshotError("private database snapshot failed validation");
    }
    store = restored.store;
    revision = revisionNumber(row.revision);
  }

  let writeQueue = Promise.resolve();
  const write = async (): Promise<void> => {
    /**
     * One committed-state read can race one write; the loop only re-reads after a CAS miss, and
     * every branch below either adopts the winner's revision or throws, so three attempts bound
     * only the pathological row-vanished case.
     */
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = snapshotPreparedEvidenceStore(store);
      const rows = await sql<readonly Readonly<{ revision: number | string }>[]>`
      WITH updated AS (
        UPDATE private_app.prepared_evidence_state AS state
        SET revision = state.revision + 1,
            snapshot = ${snapshot}::jsonb,
            updated_at = transaction_timestamp()
        WHERE state.state_key = ${stateKey}
          AND state.revision = ${revision}
          AND ${revision} > 0
        RETURNING state.revision
      ), inserted AS (
        INSERT INTO private_app.prepared_evidence_state (
          state_key,
          revision,
          snapshot
        )
        SELECT ${stateKey}, 1, ${snapshot}::jsonb
        WHERE ${revision} = 0
          AND NOT EXISTS (SELECT 1 FROM updated)
        ON CONFLICT (state_key) DO NOTHING
        RETURNING revision
      )
      SELECT revision FROM updated
      UNION ALL
      SELECT revision FROM inserted
    `;
      const next = rows[0];
      if (next !== undefined) {
        revision = revisionNumber(next.revision);
        return;
      }
      // The compare-and-swap missed: another writer moved the row. Re-read the winner before
      // deciding anything - deciding from the stale revision is what used to poison every later
      // write (and therefore every sign-in) until process restart.
      const current = await sql<readonly StateRow[]>`
      SELECT revision, snapshot
      FROM private_app.prepared_evidence_state
      WHERE state_key = ${stateKey}
    `;
      const winner = current[0];
      if (winner === undefined) {
        // The row vanished out from under this instance; restart from the initial-insert path.
        revision = 0;
        continue;
      }
      if (canonicalJson(winner.snapshot) === canonicalJson(snapshot)) {
        // The winner committed byte-identical content - a concurrent redundant persist. Adopt
        // its revision instead of failing the caller over a no-op.
        revision = revisionNumber(winner.revision);
        return;
      }
      // Genuine divergence: another instance owns different committed state. Surface it, never
      // clobbering the winner and never silently dropping our own mutation - but adopt the
      // winner's committed truth so this instance keeps serving from the authoritative snapshot
      // instead of failing every future write on a stale revision.
      const restored = restorePreparedEvidenceStore(winner.snapshot);
      if (restored.outcome !== "RESTORED") {
        throw new PreparedEvidenceSnapshotError("private database snapshot failed validation");
      }
      replaceStoreContents(store, restored.store);
      revision = revisionNumber(winner.revision);
      throw new PreparedEvidenceStateConflictError(
        `private prepared-evidence state ${stateKey} diverged from committed state`,
      );
    }
    throw new PreparedEvidenceStateConflictError(
      `private prepared-evidence state ${stateKey} could not be written after repeated conflicts`,
    );
  };

  return {
    store,
    persist() {
      const pending = writeQueue.then(write);
      writeQueue = pending.catch(() => {});
      return pending;
    },
  };
}
