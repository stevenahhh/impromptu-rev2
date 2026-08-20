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
  const write = async () => {
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
    if (next === undefined) {
      throw new PreparedEvidenceStateConflictError(
        `private prepared-evidence state ${stateKey} was changed by another instance`,
      );
    }
    revision = revisionNumber(next.revision);
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
