import type { Sql } from "postgres";

import type {
  SessionReportPrincipal,
  SessionReportRepository,
} from "../../src/report/postgres-session-report-repository.ts";
import { SessionReportAccessDeniedError } from "../../src/report/postgres-session-report-repository.ts";
import { MemorySessionReportRepository } from "./memory-session-report-repository.ts";

export type ProvisionedOwnerRows = {
  readonly tenants: Map<string, string>;
  readonly sessions: Map<string, { readonly ownerSubject: string; readonly epoch: number }>;
};

/**
 * The `Sql` surface `createProvisionedSessionReportRepository` actually touches: `sql.begin` plus
 * the two INSERT ... ON CONFLICT DO NOTHING statements inside `ensureOwningRows`. The fake keeps
 * the inserted owner rows in maps so the repository wrapper below can reproduce the real stores'
 * `assertOwner` verdict without a database.
 */
export function fakeProvisioningSql(rows: ProvisionedOwnerRows): {
  readonly sql: Sql;
  readonly beginCount: () => number;
} {
  let begins = 0;
  const transaction = (strings: TemplateStringsArray, ...values: unknown[]): Promise<never[]> => {
    const text = strings.join("?");
    if (text.includes("INSERT INTO private_app.tenants")) {
      const tenantId = String(values[0]);
      if (!rows.tenants.has(tenantId)) rows.tenants.set(tenantId, String(values[1]));
      return Promise.resolve([]);
    }
    if (text.includes("INSERT INTO private_app.presentation_sessions")) {
      const tenantId = String(values[0]);
      const sessionId = String(values[1]);
      const key = `${tenantId}:${sessionId}`;
      if (!rows.sessions.has(key)) {
        rows.sessions.set(key, { ownerSubject: String(values[2]), epoch: Number(values[3]) });
      }
      return Promise.resolve([]);
    }
    // set_config and anything else resolve empty; the fake records no other statements.
    return Promise.resolve([]);
  };
  const sql = {
    async begin<T>(callback: (transactionSql: Sql) => Promise<T>): Promise<T> {
      begins += 1;
      return await callback(transaction as unknown as Sql);
    },
  } as unknown as Sql;
  return { sql, beginCount: () => begins };
}

/**
 * `SessionReportRepository` that denies exactly like `assertOwner` does against PostgreSQL: every
 * operation rejects with `SessionReportAccessDeniedError` unless a `presentation_sessions` row
 * exists for the principal's tenant/session with a matching `owner_subject`. Writes delegate to
 * the in-memory post-rule store so CAS, idempotency and finalization semantics stay real.
 */
export class OwnershipCheckedReportRepository implements SessionReportRepository {
  readonly #inner = new MemorySessionReportRepository();

  constructor(private readonly sessions: ProvisionedOwnerRows["sessions"]) {}

  #assertOwner(principal: SessionReportPrincipal): void {
    const row = this.sessions.get(`${principal.tenantId}:${principal.presentationSessionId}`);
    if (row === undefined || row.ownerSubject !== principal.ownerSubject) {
      throw new SessionReportAccessDeniedError("presentation session is not owned by this subject");
    }
  }

  async appendSlideVisit(input: Parameters<SessionReportRepository["appendSlideVisit"]>[0]) {
    this.#assertOwner(input);
    return await this.#inner.appendSlideVisit(input);
  }

  async compareAndSetState(input: Parameters<SessionReportRepository["compareAndSetState"]>[0]) {
    this.#assertOwner(input);
    return await this.#inner.compareAndSetState(input);
  }

  async appendQaExchange(input: Parameters<SessionReportRepository["appendQaExchange"]>[0]) {
    this.#assertOwner(input);
    return await this.#inner.appendQaExchange(input);
  }

  async readSlideVisits(principal: SessionReportPrincipal) {
    this.#assertOwner(principal);
    return await this.#inner.readSlideVisits();
  }

  async readQaExchanges(principal: SessionReportPrincipal) {
    this.#assertOwner(principal);
    return await this.#inner.readQaExchanges();
  }

  async readForOwner(principal: SessionReportPrincipal) {
    this.#assertOwner(principal);
    return await this.#inner.readForOwner();
  }
}
