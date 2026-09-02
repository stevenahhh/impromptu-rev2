/**
 * Derived-only CAS row for session reports: revision-guarded saves, a finalizing write that also
 * stamps the report DTO contract version, and owner-scoped reads.
 */
import type { Sql } from "postgres";

import type {
  CompareAndSetSessionReportStateInput,
  SessionReportPrincipal,
  SessionReportState,
} from "./postgres-session-report-repository.ts";
import {
  SessionReportFinalizedError,
  SessionReportStateConflictError,
} from "./session-report-access-errors.ts";
import {
  aggregateJson,
  assertOwner,
  establishTenant,
  nonNegativeInteger,
  type StateRow,
  stateFromRow,
  validSummary,
} from "./session-report-table-codecs.ts";

export function createDerivedSessionReportStateStore(sql: Sql): Readonly<{
  compareAndSetState(input: CompareAndSetSessionReportStateInput): Promise<SessionReportState>;
  readForOwner(principal: SessionReportPrincipal): Promise<SessionReportState | null>;
}> {
  return {
    async compareAndSetState(input) {
      nonNegativeInteger(input.expectedRevision, "expectedRevision");
      validSummary(input.speechSummary);
      nonNegativeInteger(input.wordCount, "wordCount");
      nonNegativeInteger(input.speakingDurationMs, "speakingDurationMs");
      if (input.finalizedAtMs !== null) nonNegativeInteger(input.finalizedAtMs, "finalizedAtMs");
      const coachingAggregate = aggregateJson(input.coachingAggregate);

      return await sql.begin(async (transactionSql) => {
        await establishTenant(transactionSql, input.tenantId);
        await assertOwner(transactionSql, input);
        const updatedRows = await transactionSql<readonly StateRow[]>`
          UPDATE private_app.session_report_state
          SET revision = revision + 1,
              speech_summary = ${input.speechSummary},
              word_count = ${input.wordCount},
              speaking_duration_ms = ${input.speakingDurationMs},
              coaching_aggregate = ${transactionSql.json(coachingAggregate)}::jsonb,
              finalized_at = ${input.finalizedAtMs === null ? null : new Date(input.finalizedAtMs)},
              report_version = CASE WHEN ${input.finalizedAtMs === null} THEN report_version ELSE 2 END,
              updated_at = transaction_timestamp()
          WHERE tenant_id = ${input.tenantId}::uuid
            AND session_id = ${input.presentationSessionId}::uuid
            AND owner_subject = ${input.ownerSubject}
            AND revision = ${input.expectedRevision}
            AND finalized_at IS NULL
          RETURNING
            owner_subject,
            revision,
            speech_summary,
            word_count,
            speaking_duration_ms,
            coaching_aggregate,
            finalized_at,
            report_version
        `;
        const updated = updatedRows[0];
        if (updated !== undefined) return stateFromRow(updated);

        if (input.expectedRevision === 0) {
          const insertedRows = await transactionSql<readonly StateRow[]>`
            INSERT INTO private_app.session_report_state (
              tenant_id,
              session_id,
              owner_subject,
              revision,
              speech_summary,
              word_count,
              speaking_duration_ms,
              coaching_aggregate,
              finalized_at,
              report_version
            ) VALUES (
              ${input.tenantId}::uuid,
              ${input.presentationSessionId}::uuid,
              ${input.ownerSubject},
              1,
              ${input.speechSummary},
              ${input.wordCount},
              ${input.speakingDurationMs},
              ${transactionSql.json(coachingAggregate)}::jsonb,
              ${input.finalizedAtMs === null ? null : new Date(input.finalizedAtMs)},
              ${input.finalizedAtMs === null ? 1 : 2}
            )
            ON CONFLICT (tenant_id, session_id) DO NOTHING
            RETURNING
              owner_subject,
              revision,
              speech_summary,
              word_count,
              speaking_duration_ms,
              coaching_aggregate,
              finalized_at,
              report_version
          `;
          const inserted = insertedRows[0];
          if (inserted !== undefined) return stateFromRow(inserted);
        }

        const stateRows = await transactionSql<readonly { finalized_at: Date | null }[]>`
          SELECT finalized_at
          FROM private_app.session_report_state
          WHERE tenant_id = ${input.tenantId}::uuid
            AND session_id = ${input.presentationSessionId}::uuid
            AND owner_subject = ${input.ownerSubject}
        `;
        if (stateRows[0]?.finalized_at !== null && stateRows[0] !== undefined) {
          throw new SessionReportFinalizedError("session report state is finalized");
        }
        throw new SessionReportStateConflictError("session report state revision is stale");
      });
    },

    async readForOwner(principal) {
      return await sql.begin(async (transactionSql) => {
        await establishTenant(transactionSql, principal.tenantId);
        await assertOwner(transactionSql, principal);
        const rows = await transactionSql<readonly StateRow[]>`
          SELECT
            owner_subject,
            revision,
            speech_summary,
            word_count,
            speaking_duration_ms,
            coaching_aggregate,
            finalized_at,
            report_version
          FROM private_app.session_report_state
          WHERE tenant_id = ${principal.tenantId}::uuid
            AND session_id = ${principal.presentationSessionId}::uuid
            AND owner_subject = ${principal.ownerSubject}
        `;
        const row = rows[0];
        return row === undefined ? null : stateFromRow(row);
      });
    },
  };
}
