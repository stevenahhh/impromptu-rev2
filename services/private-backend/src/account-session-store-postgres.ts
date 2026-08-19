import { AccountSessionSchema } from "@impromptu/contracts/private";
import type { Sql } from "postgres";
import type { AccountSessionStore } from "./account-session-store.ts";

type AccountSessionRow = Readonly<{
  account_session_id: string;
  account_id: string;
  actor_id: string;
  expires_at_ms: number;
  revoked_at_ms: number | null;
}>;

function epochMilliseconds(value: number, column: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`account_sessions.${column} is not a valid epoch millisecond timestamp`);
  }
  return value;
}

/** PostgreSQL-backed account session store. The account_sessions table intentionally has no RLS. */
export function createPostgresAccountSessionStore(sql: Sql): AccountSessionStore {
  return {
    async create(session, createdAtMs) {
      await sql`
        INSERT INTO private_app.account_sessions (
          account_session_id,
          account_id,
          actor_id,
          created_at,
          expires_at,
          revoked_at
        ) VALUES (
          ${session.accountSessionId},
          ${session.accountId},
          ${session.actorId},
          ${new Date(createdAtMs)},
          ${new Date(session.expiresAtMs)},
          ${session.revokedAtMs === null ? null : new Date(session.revokedAtMs)}
        )
      `;
    },

    async read(accountSessionId) {
      const rows = await sql<readonly AccountSessionRow[]>`
        SELECT
          account_session_id,
          account_id,
          actor_id,
          (EXTRACT(EPOCH FROM expires_at) * 1000)::double precision AS expires_at_ms,
          (EXTRACT(EPOCH FROM revoked_at) * 1000)::double precision AS revoked_at_ms
        FROM private_app.account_sessions
        WHERE account_session_id = ${accountSessionId}
        LIMIT 1
      `;
      const row = rows[0];
      if (row === undefined) return null;
      return AccountSessionSchema.parse({
        accountSessionId: row.account_session_id,
        accountId: row.account_id,
        actorId: row.actor_id,
        expiresAtMs: epochMilliseconds(row.expires_at_ms, "expires_at"),
        revokedAtMs:
          row.revoked_at_ms === null ? null : epochMilliseconds(row.revoked_at_ms, "revoked_at"),
      });
    },

    async revoke(accountSessionId, revokedAtMs) {
      await sql`
        UPDATE private_app.account_sessions
        SET revoked_at = ${new Date(revokedAtMs)}
        WHERE account_session_id = ${accountSessionId}
      `;
    },
  };
}
