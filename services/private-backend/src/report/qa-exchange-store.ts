/**
 * Q&A defense exchange persistence: idempotent appends keyed by exchange id into their own durable
 * record, plus per-session reads in ask order.
 *
 * APPENDS ARE NOT GATED ON REPORT FINALIZATION. The exchange log is its own record:
 * `private_app.qa_exchanges`, scoped by tenant RLS policies and owner-checked per transaction
 * against `private_app.presentation_sessions`. It is deliberately NOT part of the session report's
 * compare-and-swap state, so a presenter who opens Q&A after pressing end — the only way Q&A ever
 * opens — keeps recording exchanges while the finalized report row stays immutable.
 */
import type { Sql } from "postgres";

import type {
  AppendQaExchangeInput,
  QaExchangeAppendResult,
  QaExchangeItem,
} from "../qa/qa-exchange-ledger.ts";
import type { SessionReportPrincipal } from "./postgres-session-report-repository.ts";
import { SessionReportStateConflictError } from "./session-report-access-errors.ts";
import {
  assertOwner,
  establishTenant,
  type QaExchangeRow,
  qaExchangeFromRow,
} from "./session-report-table-codecs.ts";

export function createQaExchangeStore(sql: Sql): Readonly<{
  appendQaExchange(input: AppendQaExchangeInput): Promise<QaExchangeAppendResult>;
  readQaExchanges(principal: SessionReportPrincipal): Promise<readonly QaExchangeItem[]>;
}> {
  return {
    async appendQaExchange(input: AppendQaExchangeInput): Promise<QaExchangeAppendResult> {
      return await sql.begin(async (transactionSql) => {
        await establishTenant(transactionSql, input.tenantId);
        await assertOwner(transactionSql, input);

        const duplicateRows = await transactionSql<readonly QaExchangeRow[]>`
          SELECT
            exchange_id,
            asked_offset_ms,
            question,
            origin,
            defense_payload
          FROM private_app.qa_exchanges
          WHERE tenant_id = ${input.tenantId}::uuid
            AND session_id = ${input.presentationSessionId}::uuid
            AND exchange_id = ${input.exchangeId}
        `;
        const duplicate = duplicateRows[0];
        if (duplicate !== undefined) {
          const exchange = qaExchangeFromRow(duplicate);
          if (
            exchange.askedAtMs !== input.askedAtMs ||
            exchange.question !== input.question ||
            exchange.origin !== input.origin ||
            JSON.stringify(exchange.defense) !== JSON.stringify(input.defense)
          ) {
            throw new SessionReportStateConflictError(
              `qa exchange id ${input.exchangeId} was reused with different content`,
            );
          }
          return { outcome: "DUPLICATE" as const, exchange };
        }

        const insertedRows = await transactionSql<readonly QaExchangeRow[]>`
          INSERT INTO private_app.qa_exchanges (
            tenant_id,
            session_id,
            exchange_id,
            asked_offset_ms,
            question,
            origin,
            defense_payload
          ) VALUES (
            ${input.tenantId}::uuid,
            ${input.presentationSessionId}::uuid,
            ${input.exchangeId},
            ${input.askedAtMs},
            ${input.question},
            ${input.origin},
            ${transactionSql.json(input.defense)}::jsonb
          )
          ON CONFLICT (tenant_id, session_id, exchange_id) DO NOTHING
          RETURNING
            exchange_id,
            asked_offset_ms,
            question,
            origin,
            defense_payload
        `;
        const inserted = insertedRows[0];
        if (inserted === undefined) {
          throw new SessionReportStateConflictError(
            `qa exchange id ${input.exchangeId} raced with a concurrent writer`,
          );
        }
        return { outcome: "APPENDED" as const, exchange: qaExchangeFromRow(inserted) };
      });
    },

    async readQaExchanges(principal: SessionReportPrincipal): Promise<readonly QaExchangeItem[]> {
      return await sql.begin(async (transactionSql) => {
        await establishTenant(transactionSql, principal.tenantId);
        await assertOwner(transactionSql, principal);
        const rows = await transactionSql<readonly QaExchangeRow[]>`
          SELECT
            exchange_id,
            asked_offset_ms,
            question,
            origin,
            defense_payload
          FROM private_app.qa_exchanges
          WHERE tenant_id = ${principal.tenantId}::uuid
            AND session_id = ${principal.presentationSessionId}::uuid
          ORDER BY ask_seq
        `;
        return rows.map(qaExchangeFromRow);
      });
    },
  };
}
