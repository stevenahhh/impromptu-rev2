/**
 * Provisions the relational prerequisites the session-report tables require.
 *
 * `slide_visits` and `session_report_state` are keyed by `(tenant_id, session_id)` and carry a
 * foreign key into `presentation_sessions`, which in turn references `tenants` — all `uuid`. The
 * rest of the product identifies an account as `account_<...>` and a presentation as `ps_<hex>`,
 * and nothing ever wrote a `tenants` or `presentation_sessions` row. The result was that ending a
 * presentation failed with `invalid input syntax for type uuid`, so no report could ever be
 * finalized for any account.
 *
 * This adapter closes that gap in one place: it maps the product's identifiers onto the schema's
 * uuid identity and makes the owning rows exist before the first write, leaving authentication,
 * the presentation lifecycle and the report repository itself untouched.
 */
import { createHash } from "node:crypto";

import type { Sql } from "postgres";

import type {
  AppendSlideVisitInput,
  CompareAndSetSessionReportStateInput,
  SessionReportPrincipal,
  SessionReportRepository,
} from "./postgres-session-report-repository.ts";

const TENANT_NAMESPACE = "impromptu.tenant.account";
const SESSION_NAMESPACE = "impromptu.session.presentation";
const HEX_32 = /^[0-9a-f]{32}$/i;

function uuidFromHex(hex: string): string {
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function digestUuid(namespace: string, value: string): string {
  return uuidFromHex(
    createHash("sha256").update(`${namespace}:${value}`).digest("hex").slice(0, 32),
  );
}

/**
 * One account owns exactly one tenant, which is the model the rest of the service already assumes
 * by passing the account id wherever a tenant is wanted. Deriving the uuid keeps that mapping
 * stable across restarts and redeployments without a lookup table, and the tenant row records the
 * originating account id so the relationship stays legible in the database.
 */
export function tenantUuidForAccount(accountId: string): string {
  return digestUuid(TENANT_NAMESPACE, accountId);
}

/**
 * `ps_<32 hex>` carries exactly the 128 bits a uuid holds, so it is re-encoded rather than
 * hashed: the session's identity survives intact and stays recognisable in the database. Any
 * other shape falls back to a derived uuid.
 */
export function presentationSessionUuid(presentationSessionId: string): string {
  const body = presentationSessionId.startsWith("ps_")
    ? presentationSessionId.slice(3)
    : presentationSessionId;
  return HEX_32.test(body)
    ? uuidFromHex(body.toLowerCase())
    : digestUuid(SESSION_NAMESPACE, presentationSessionId);
}

export function createProvisionedSessionReportRepository(
  sql: Sql,
  inner: SessionReportRepository,
): SessionReportRepository {
  const provisioned = new Set<string>();

  const withUuidIdentity = <Input extends SessionReportPrincipal>(input: Input): Input => ({
    ...input,
    tenantId: tenantUuidForAccount(input.tenantId),
    presentationSessionId: presentationSessionUuid(input.presentationSessionId),
  });

  const ensureOwningRows = async (
    principal: SessionReportPrincipal,
    presentationSessionEpoch: number,
  ): Promise<void> => {
    const tenantId = tenantUuidForAccount(principal.tenantId);
    const sessionId = presentationSessionUuid(principal.presentationSessionId);
    const key = `${tenantId}:${sessionId}`;
    if (provisioned.has(key)) return;

    await sql.begin(async (transactionSql) => {
      // Row-level security admits a write only for the tenant in scope, and that includes the
      // tenant's own row, so the scope is established before either insert.
      await transactionSql`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      await transactionSql`
        INSERT INTO private_app.tenants (tenant_id, display_name)
        VALUES (${tenantId}::uuid, ${principal.tenantId})
        ON CONFLICT (tenant_id) DO NOTHING
      `;
      await transactionSql`
        INSERT INTO private_app.presentation_sessions (
          tenant_id,
          session_id,
          owner_subject,
          presentation_session_epoch,
          deck_storage_uri
        )
        VALUES (
          ${tenantId}::uuid,
          ${sessionId}::uuid,
          ${principal.ownerSubject},
          ${presentationSessionEpoch},
          ${`deck://${principal.presentationSessionId}`}
        )
        ON CONFLICT (tenant_id, session_id) DO NOTHING
      `;
    });
    // Cached only after the transaction commits, so a failed provision is retried rather than
    // remembered as done.
    provisioned.add(key);
  };

  return {
    async appendSlideVisit(input: AppendSlideVisitInput) {
      await ensureOwningRows(input, input.presentationSessionEpoch);
      return await inner.appendSlideVisit(withUuidIdentity(input));
    },
    async compareAndSetState(input: CompareAndSetSessionReportStateInput) {
      // State can be written for a session that recorded no visits, so the owning rows are
      // ensured here too. An epoch already recorded by a visit is kept by ON CONFLICT.
      await ensureOwningRows(input, 1);
      return await inner.compareAndSetState(withUuidIdentity(input));
    },
    async readSlideVisits(principal: SessionReportPrincipal) {
      return await inner.readSlideVisits(withUuidIdentity(principal));
    },
    async readForOwner(principal: SessionReportPrincipal) {
      return await inner.readForOwner(withUuidIdentity(principal));
    },
  };
}
