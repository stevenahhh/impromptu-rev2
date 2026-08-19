import type { AccountSession } from "@impromptu/contracts/private";

export interface AccountSessionStore {
  create(session: AccountSession, createdAtMs: number): Promise<void>;
  read(accountSessionId: string): Promise<AccountSession | null>;
  revoke(accountSessionId: string, revokedAtMs: number): Promise<void>;
}

export function createInMemoryAccountSessionStore(
  sessions: Map<string, AccountSession> = new Map(),
): AccountSessionStore {
  return {
    async create(session) {
      sessions.set(session.accountSessionId, session);
    },

    async read(accountSessionId) {
      return sessions.get(accountSessionId) ?? null;
    },

    async revoke(accountSessionId, revokedAtMs) {
      const session = sessions.get(accountSessionId);
      if (session === undefined) return;
      sessions.set(accountSessionId, { ...session, revokedAtMs });
    },
  };
}
