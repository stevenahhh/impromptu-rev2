import type { Sql } from "postgres";

const MAX_SUMMARY_LENGTH = 4_000;
const MAX_PRODUCER_ID_LENGTH = 200;
const MAX_SLIDE_KEY_LENGTH = 512;
const FORBIDDEN_AGGREGATE_KEYS = new Set([
  "transcript",
  "transcript_text",
  "transcripttext",
  "raw_audio",
  "rawaudio",
  "audio",
  "partial",
]);

export type ReportAggregateValue =
  | null
  | string
  | number
  | boolean
  | readonly ReportAggregateValue[]
  | Readonly<{ readonly [key: string]: ReportAggregateValue }>;

export type SessionReportPrincipal = Readonly<{
  tenantId: string;
  presentationSessionId: string;
  ownerSubject: string;
}>;

export type SlideVisit = Readonly<{
  presentationSessionEpoch: number;
  seq: number;
  publicSlideKey: string;
  occurrenceSeq: number;
  enteredOffsetMs: number;
  leftOffsetMs: number;
  producerId: string;
}>;

export type AppendSlideVisitInput = SessionReportPrincipal &
  Readonly<{
    presentationSessionEpoch: number;
    seq: number;
    publicSlideKey: string;
    enteredOffsetMs: number;
    leftOffsetMs: number;
    producerId: string;
  }>;

export type SessionReportState = Readonly<{
  ownerSubject: string;
  revision: number;
  speechSummary: string;
  wordCount: number;
  speakingDurationMs: number;
  coachingAggregate: unknown;
  finalizedAtMs: number | null;
}>;

export type CompareAndSetSessionReportStateInput = SessionReportPrincipal &
  Readonly<{
    expectedRevision: number;
    speechSummary: string;
    wordCount: number;
    speakingDurationMs: number;
    coachingAggregate: Readonly<Record<string, ReportAggregateValue>>;
    finalizedAtMs: number | null;
  }>;

export class SessionReportStateConflictError extends Error {
  readonly code = "SESSION_REPORT_STATE_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "SessionReportStateConflictError";
  }
}

export class SessionReportFinalizedError extends Error {
  readonly code = "SESSION_REPORT_FINALIZED";

  constructor(message: string) {
    super(message);
    this.name = "SessionReportFinalizedError";
  }
}

export class SessionReportAccessDeniedError extends Error {
  readonly code = "SESSION_REPORT_ACCESS_DENIED";

  constructor(message: string) {
    super(message);
    this.name = "SessionReportAccessDeniedError";
  }
}

type VisitRow = Readonly<{
  presentation_session_epoch: number | string;
  seq: number | string;
  public_slide_key: string;
  occurrence_seq: number | string;
  entered_offset_ms: number | string;
  left_offset_ms: number | string;
  producer_id: string;
}>;

type StateRow = Readonly<{
  owner_subject: string;
  revision: number | string;
  speech_summary: string;
  word_count: number | string;
  speaking_duration_ms: number | string;
  coaching_aggregate: unknown;
  finalized_at: Date | null;
}>;

export interface SessionReportRepository {
  appendSlideVisit(
    input: AppendSlideVisitInput,
  ): Promise<
    | Readonly<{ outcome: "APPENDED"; visit: SlideVisit }>
    | Readonly<{ outcome: "DUPLICATE"; visit: SlideVisit }>
  >;
  compareAndSetState(input: CompareAndSetSessionReportStateInput): Promise<SessionReportState>;
  readSlideVisits(principal: SessionReportPrincipal): Promise<readonly SlideVisit[]>;
  readForOwner(principal: SessionReportPrincipal): Promise<SessionReportState | null>;
}

function safeInteger(value: number | string, column: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`session report ${column} is not a safe integer`);
  }
  return parsed;
}

function nonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
}

function positiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
}

function boundedText(value: string, field: string, maximum: number): void {
  if (value.length === 0 || value.length > maximum) {
    throw new RangeError(`${field} must contain between 1 and ${maximum} characters`);
  }
}

function validSummary(value: string): void {
  if (value.length > MAX_SUMMARY_LENGTH) {
    throw new RangeError(`speechSummary must contain at most ${MAX_SUMMARY_LENGTH} characters`);
  }
}

function aggregateJson(
  value: Readonly<Record<string, ReportAggregateValue>>,
): Readonly<Record<string, ReportAggregateValue>> {
  const seen = new Set<object>();
  const validate = (node: unknown): void => {
    if (node === null || typeof node === "string" || typeof node === "boolean") return;
    if (typeof node === "number") {
      if (!Number.isFinite(node))
        throw new RangeError("coachingAggregate must contain JSON values");
      return;
    }
    if (typeof node !== "object") {
      throw new RangeError("coachingAggregate must contain JSON values");
    }
    if (seen.has(node)) throw new RangeError("coachingAggregate must not contain cycles");
    seen.add(node);
    if (Array.isArray(node)) {
      for (const entry of node) validate(entry);
    } else {
      for (const [key, entry] of Object.entries(node)) {
        if (FORBIDDEN_AGGREGATE_KEYS.has(key.toLowerCase())) {
          throw new RangeError(`coachingAggregate must not contain ${key}`);
        }
        validate(entry);
      }
    }
    seen.delete(node);
  };
  validate(value);
  const serialized = JSON.stringify(value);
  if (serialized === undefined || serialized.length > 16_384) {
    throw new RangeError("coachingAggregate must be a JSON object no larger than 16384 characters");
  }
  return value;
}

function visitFromRow(row: VisitRow): SlideVisit {
  return {
    presentationSessionEpoch: safeInteger(
      row.presentation_session_epoch,
      "presentation_session_epoch",
    ),
    seq: safeInteger(row.seq, "seq"),
    publicSlideKey: row.public_slide_key,
    occurrenceSeq: safeInteger(row.occurrence_seq, "occurrence_seq"),
    enteredOffsetMs: safeInteger(row.entered_offset_ms, "entered_offset_ms"),
    leftOffsetMs: safeInteger(row.left_offset_ms, "left_offset_ms"),
    producerId: row.producer_id,
  };
}

function stateFromRow(row: StateRow): SessionReportState {
  return {
    ownerSubject: row.owner_subject,
    revision: safeInteger(row.revision, "revision"),
    speechSummary: row.speech_summary,
    wordCount: safeInteger(row.word_count, "word_count"),
    speakingDurationMs: safeInteger(row.speaking_duration_ms, "speaking_duration_ms"),
    coachingAggregate: row.coaching_aggregate,
    finalizedAtMs: row.finalized_at === null ? null : row.finalized_at.getTime(),
  };
}

async function establishTenant(sql: Sql, tenantId: string): Promise<void> {
  await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
}

async function assertOwner(sql: Sql, principal: SessionReportPrincipal): Promise<void> {
  const rows = await sql<readonly { session_id: string }[]>`
    SELECT session_id::text
    FROM private_app.presentation_sessions
    WHERE tenant_id = ${principal.tenantId}::uuid
      AND session_id = ${principal.presentationSessionId}::uuid
      AND owner_subject = ${principal.ownerSubject}
  `;
  if (rows[0] === undefined) {
    throw new SessionReportAccessDeniedError("presentation session is not owned by this subject");
  }
}

/** PostgreSQL repository for ordered slide visits and a per-session derived-only CAS row. */
export function createPostgresSessionReportRepository(sql: Sql): SessionReportRepository {
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
            finalized_at
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
              finalized_at
            ) VALUES (
              ${input.tenantId}::uuid,
              ${input.presentationSessionId}::uuid,
              ${input.ownerSubject},
              1,
              ${input.speechSummary},
              ${input.wordCount},
              ${input.speakingDurationMs},
              ${transactionSql.json(coachingAggregate)}::jsonb,
              ${input.finalizedAtMs === null ? null : new Date(input.finalizedAtMs)}
            )
            ON CONFLICT (tenant_id, session_id) DO NOTHING
            RETURNING
              owner_subject,
              revision,
              speech_summary,
              word_count,
              speaking_duration_ms,
              coaching_aggregate,
              finalized_at
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
            finalized_at
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
