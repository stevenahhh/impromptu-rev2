import { describe, expect, test } from "bun:test";
import { AccountSessionSchema } from "@impromptu/contracts/private";
import {
  createPreparedEvidenceStore,
  snapshotPreparedEvidenceStore,
} from "../src/prepared-evidence.ts";
import {
  createPostgresPreparedEvidencePersistence,
  type PostgresStateSql,
  PreparedEvidenceStateConflictError,
} from "../src/prepared-evidence-store-postgres.ts";

/**
 * Emulates exactly the SQL the persistence issues against private_app.prepared_evidence_state,
 * including the compare-and-swap semantics of the UPDATE/INSERT CTE: a write whose expected
 * revision no longer matches updates nothing and returns no rows.
 */
function fakeStateSql() {
  type Row = { revision: number; snapshot: unknown };
  let row: Row | undefined;
  const sql = ((first: unknown, ...values: unknown[]) => {
    if (!Array.isArray(first) || !Object.hasOwn(first, "raw")) return first;
    const query = (first as unknown as TemplateStringsArray).join("?").replace(/\s+/g, " ").trim();
    if (query.startsWith("SELECT revision, snapshot")) {
      return Promise.resolve(
        row === undefined ? [] : [{ revision: row.revision, snapshot: row.snapshot }],
      );
    }
    if (query.startsWith("WITH updated AS")) {
      const pendingSnapshot = values[0];
      const expected = Number(values[2]);
      if (row !== undefined && row.revision === expected && expected > 0) {
        row.revision += 1;
        row.snapshot = pendingSnapshot;
        return Promise.resolve([{ revision: row.revision }]);
      }
      if (expected === 0 && row === undefined) {
        row = { revision: 1, snapshot: pendingSnapshot };
        return Promise.resolve([{ revision: 1 }]);
      }
      return Promise.resolve([]);
    }
    throw new Error(`Unexpected SQL: ${query}`);
  }) as unknown as PostgresStateSql;
  Object.assign(sql, {
    raw: Symbol("raw"),
    /** Directly moves the committed row the way a second backend instance would. */
    commitExternalWrite(snapshot: unknown): void {
      row = { revision: (row?.revision ?? 0) + 1, snapshot };
    },
    currentRow(): Row | undefined {
      return row === undefined ? undefined : { ...row };
    },
  });
  return sql as unknown as PostgresStateSql & {
    commitExternalWrite(snapshot: unknown): void;
    currentRow(): { revision: number; snapshot: unknown } | undefined;
  };
}

function session(id: string) {
  return AccountSessionSchema.parse({
    accountSessionId: `account_session_${id}`,
    accountId: "account_alpha",
    actorId: "actor_alpha",
    expiresAtMs: 10_000,
    revokedAtMs: null,
  });
}

describe("prepared-evidence state persistence under concurrent writers", () => {
  test("a losing compare-and-swap adopts committed truth and does not poison later writes", async () => {
    // Two backend instances sharing one state key is the split-brain this CAS exists to catch.
    // The loser used to keep its stale revision forever, so every later persist - including
    // every sign-in's - failed until process restart. It must surface the conflict once and
    // then serve from the winner's committed snapshot.
    const sql = fakeStateSql();
    sql.commitExternalWrite(
      snapshotPreparedEvidenceStore(
        (() => {
          const store = createPreparedEvidenceStore();
          store.accountSessions.set("session-external", session("external000000000"));
          return store;
        })(),
      ),
    );
    const persistence = await createPostgresPreparedEvidencePersistence(sql);

    // A rival instance commits divergent state behind our backs after we loaded.
    sql.commitExternalWrite(
      snapshotPreparedEvidenceStore(
        (() => {
          const store = createPreparedEvidenceStore();
          store.accountSessions.set("session-rival", session("rival00000000000"));
          return store;
        })(),
      ),
    );

    persistence.store.accountSessions.set("session-local", session("local0000000000"));
    const conflict = new Promise<unknown>((resolve) => {
      void persistence.persist().catch(resolve);
    });
    expect(await conflict).toBeInstanceOf(PreparedEvidenceStateConflictError);

    // Fail closed: our divergent mutation was discarded in favour of committed truth...
    expect(persistence.store.accountSessions.has("session-local")).toBe(false);
    // The adopted snapshot re-keys sessions by their persisted accountSessionId.
    expect(persistence.store.accountSessions.has("account_session_rival00000000000")).toBe(true);

    // ...and the next genuine mutation persists cleanly instead of conflicting forever.
    persistence.store.accountSessions.set("session-later", session("later00000000000"));
    await persistence.persist();
    const row = sql.currentRow();
    expect(row?.revision).toBe(3);
    expect(JSON.stringify(row?.snapshot)).toContain("account_session_later00000000000");
    expect(JSON.stringify(row?.snapshot)).not.toContain("session-local");
  });

  test("a redundant concurrent write of identical content resolves without failing", async () => {
    const sql = fakeStateSql();
    const seedStore = createPreparedEvidenceStore();
    seedStore.accountSessions.set("session-shared", session("shared000000000"));
    const sharedSnapshot = snapshotPreparedEvidenceStore(seedStore);
    sql.commitExternalWrite(sharedSnapshot);
    const persistence = await createPostgresPreparedEvidencePersistence(sql);
    sql.commitExternalWrite(sharedSnapshot); // winner advances the revision, content identical

    await persistence.persist(); // must adopt the winner's revision instead of throwing

    expect(sql.currentRow()?.revision).toBe(2);
  });
});
