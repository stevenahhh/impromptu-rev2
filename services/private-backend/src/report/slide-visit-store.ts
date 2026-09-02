/** Ordered slide-visit persistence for session reports: append-with-closure plus per-session reads. */
import type { Sql } from "postgres";

import type {
  AppendSlideVisitInput,
  SessionReportPrincipal,
  SlideVisit,
} from "./postgres-session-report-repository.ts";
import {
  SessionReportFinalizedError,
  SessionReportStateConflictError,
} from "./session-report-access-errors.ts";
import {
  assertOwner,
  boundedText,
  establishTenant,
  MAX_PRODUCER_ID_LENGTH,
  MAX_SLIDE_KEY_LENGTH,
  nonNegativeInteger,
  positiveInteger,
  safeInteger,
  type VisitRow,
  visitFromRow,
} from "./session-report-table-codecs.ts";

export function createSlideVisitStore(sql: Sql): Readonly<{
  appendSlideVisit(
    input: AppendSlideVisitInput,
  ): Promise<
    | Readonly<{ outcome: "APPENDED"; visit: SlideVisit }>
    | Readonly<{ outcome: "DUPLICATE"; visit: SlideVisit }>
  >;
  readSlideVisits(principal: SessionReportPrincipal): Promise<readonly SlideVisit[]>;
}> {
  return {
    async appendSlideVisit(input) {
      positiveInteger(input.presentationSessionEpoch, "presentationSessionEpoch");
      positiveInteger(input.seq, "seq");
      nonNegativeInteger(input.enteredOffsetMs, "enteredOffsetMs");
      nonNegativeInteger(input.leftOffsetMs, "leftOffsetMs");
      if (input.leftOffsetMs < input.enteredOffsetMs) {
        throw new RangeError("leftOffsetMs must be greater than or equal to enteredOffsetMs");
      }
      boundedText(input.publicSlideKey, "publicSlideKey", MAX_SLIDE_KEY_LENGTH);
      boundedText(input.producerId, "producerId", MAX_PRODUCER_ID_LENGTH);

      return await sql.begin(async (transactionSql) => {
        await establishTenant(transactionSql, input.tenantId);
        await assertOwner(transactionSql, input);
        await transactionSql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`${input.tenantId}:${input.presentationSessionId}`}, 0)
          )
        `;
        const duplicateRows = await transactionSql<readonly VisitRow[]>`
          SELECT
            presentation_session_epoch,
            seq,
            public_slide_key,
            occurrence_seq,
            entered_offset_ms,
            left_offset_ms,
            producer_id
          FROM private_app.slide_visits
          WHERE tenant_id = ${input.tenantId}::uuid
            AND session_id = ${input.presentationSessionId}::uuid
            AND producer_id = ${input.producerId}
        `;
        const duplicate = duplicateRows[0];
        if (duplicate !== undefined) {
          const visit = visitFromRow(duplicate);
          if (
            visit.presentationSessionEpoch !== input.presentationSessionEpoch ||
            visit.seq !== input.seq ||
            visit.publicSlideKey !== input.publicSlideKey ||
            visit.enteredOffsetMs !== input.enteredOffsetMs ||
            visit.leftOffsetMs !== input.leftOffsetMs
          ) {
            throw new SessionReportStateConflictError(
              `slide visit producer ${input.producerId} was reused with different content`,
            );
          }
          return { outcome: "DUPLICATE" as const, visit };
        }

        const finalizedRows = await transactionSql<readonly { finalized_at: Date | null }[]>`
          SELECT finalized_at
          FROM private_app.session_report_state
          WHERE tenant_id = ${input.tenantId}::uuid
            AND session_id = ${input.presentationSessionId}::uuid
        `;
        if (finalizedRows[0]?.finalized_at !== null && finalizedRows[0] !== undefined) {
          throw new SessionReportFinalizedError(
            "cannot append a slide visit after report finalization",
          );
        }
        const sequenceRows = await transactionSql<
          readonly { maximum_seq: number | string | null }[]
        >`
          SELECT max(seq) AS maximum_seq
          FROM private_app.slide_visits
          WHERE tenant_id = ${input.tenantId}::uuid
            AND session_id = ${input.presentationSessionId}::uuid
        `;
        const maximumSeq = sequenceRows[0]?.maximum_seq;
        if (
          maximumSeq !== null &&
          maximumSeq !== undefined &&
          input.seq <= safeInteger(maximumSeq, "seq")
        ) {
          throw new SessionReportStateConflictError(
            "slide visit seq must increase within a session",
          );
        }
        const occurrenceRows = await transactionSql<
          readonly { next_occurrence_seq: number | string }[]
        >`
          SELECT coalesce(max(occurrence_seq), 0) + 1 AS next_occurrence_seq
          FROM private_app.slide_visits
          WHERE tenant_id = ${input.tenantId}::uuid
            AND session_id = ${input.presentationSessionId}::uuid
            AND public_slide_key = ${input.publicSlideKey}
        `;
        const occurrence = occurrenceRows[0];
        if (occurrence === undefined)
          throw new Error("slide visit occurrence query returned no row");
        const occurrenceSeq = safeInteger(occurrence.next_occurrence_seq, "occurrence_seq");
        const insertedRows = await transactionSql<readonly VisitRow[]>`
          INSERT INTO private_app.slide_visits (
            tenant_id,
            session_id,
            presentation_session_epoch,
            seq,
            public_slide_key,
            occurrence_seq,
            entered_offset_ms,
            left_offset_ms,
            producer_id
          ) VALUES (
            ${input.tenantId}::uuid,
            ${input.presentationSessionId}::uuid,
            ${input.presentationSessionEpoch},
            ${input.seq},
            ${input.publicSlideKey},
            ${occurrenceSeq},
            ${input.enteredOffsetMs},
            ${input.leftOffsetMs},
            ${input.producerId}
          )
          RETURNING
            presentation_session_epoch,
            seq,
            public_slide_key,
            occurrence_seq,
            entered_offset_ms,
            left_offset_ms,
            producer_id
        `;
        const inserted = insertedRows[0];
        if (inserted === undefined) throw new Error("slide visit insert returned no row");
        return { outcome: "APPENDED" as const, visit: visitFromRow(inserted) };
      });
    },

    async readSlideVisits(principal) {
      return await sql.begin(async (transactionSql) => {
        await establishTenant(transactionSql, principal.tenantId);
        await assertOwner(transactionSql, principal);
        const rows = await transactionSql<readonly VisitRow[]>`
          SELECT
            presentation_session_epoch,
            seq,
            public_slide_key,
            occurrence_seq,
            entered_offset_ms,
            left_offset_ms,
            producer_id
          FROM private_app.slide_visits
          WHERE tenant_id = ${principal.tenantId}::uuid
            AND session_id = ${principal.presentationSessionId}::uuid
          ORDER BY seq
        `;
        return rows.map(visitFromRow);
      });
    },
  };
}
