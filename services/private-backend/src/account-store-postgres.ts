import type { Sql } from "postgres";
import type { AccountRecord, AccountStore } from "./account-directory.ts";

type AccountRow = Readonly<{
  account_id: string;
  username: string;
  password_hash: string;
  created_at_ms: number;
  disabled_at_ms: number | null;
}>;

function epochMilliseconds(value: number, column: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`accounts.${column} is not a valid epoch millisecond timestamp`);
  }
  return value;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

/** PostgreSQL-backed authentication store. The accounts table intentionally has no RLS. */
export function createPostgresAccountStore(sql: Sql): AccountStore {
  return {
    async readByUsername(username) {
      const rows = await sql<readonly AccountRow[]>`
        SELECT
          account_id,
          username,
          password_hash,
          (EXTRACT(EPOCH FROM created_at) * 1000)::double precision AS created_at_ms,
          (EXTRACT(EPOCH FROM disabled_at) * 1000)::double precision AS disabled_at_ms
        FROM private_app.accounts
        WHERE lower(username) = lower(${username})
        LIMIT 1
      `;
      const row = rows[0];
      if (row === undefined) return null;
      return {
        accountId: row.account_id,
        username: row.username,
        passwordHash: row.password_hash,
        createdAtMs: epochMilliseconds(row.created_at_ms, "created_at"),
        disabledAtMs:
          row.disabled_at_ms === null ? null : epochMilliseconds(row.disabled_at_ms, "disabled_at"),
      };
    },

    async insert(record: AccountRecord) {
      try {
        await sql`
          INSERT INTO private_app.accounts (
            account_id,
            username,
            password_hash,
            created_at,
            disabled_at
          ) VALUES (
            ${record.accountId},
            ${record.username},
            ${record.passwordHash},
            ${new Date(record.createdAtMs)},
            ${record.disabledAtMs === null ? null : new Date(record.disabledAtMs)}
          )
        `;
        return "INSERTED";
      } catch (error) {
        if (isUniqueViolation(error)) return "USERNAME_TAKEN";
        throw error;
      }
    },
  };
}
