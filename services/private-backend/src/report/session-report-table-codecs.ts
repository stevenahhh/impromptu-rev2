/**
 * Row codecs, value validators and tenant scoping shared by the session report stores. Everything
 * here is pure except the two `Sql`-scoped helpers at the bottom.
 */
import type { Sql } from "postgres";

import { parseQaDefensePayload, type QaExchangeItem } from "../qa/qa-exchange-ledger.ts";
import type { SessionReportPrincipal } from "./postgres-session-report-repository.ts";
import { SessionReportAccessDeniedError } from "./session-report-access-errors.ts";

export const MAX_SUMMARY_LENGTH = 4_000;
export const MAX_PRODUCER_ID_LENGTH = 200;
export const MAX_SLIDE_KEY_LENGTH = 512;

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

export type VisitRow = Readonly<{
  presentation_session_epoch: number | string;
  seq: number | string;
  public_slide_key: string;
  occurrence_seq: number | string;
  entered_offset_ms: number | string;
  left_offset_ms: number | string;
  producer_id: string;
}>;

export type StateRow = Readonly<{
  owner_subject: string;
  revision: number | string;
  speech_summary: string;
  word_count: number | string;
  speaking_duration_ms: number | string;
  coaching_aggregate: unknown;
  finalized_at: Date | null;
  report_version: number | string;
}>;

export type QaExchangeRow = Readonly<{
  exchange_id: string;
  asked_offset_ms: number | string;
  question: string;
  origin: string;
  defense_payload: unknown;
}>;

export function safeInteger(value: number | string, column: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`session report ${column} is not a safe integer`);
  }
  return parsed;
}

export function nonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
}

export function positiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
}

export function boundedText(value: string, field: string, maximum: number): void {
  if (value.length === 0 || value.length > maximum) {
    throw new RangeError(`${field} must contain between 1 and ${maximum} characters`);
  }
}

export function validSummary(value: string): void {
  if (value.length > MAX_SUMMARY_LENGTH) {
    throw new RangeError(`speechSummary must contain at most ${MAX_SUMMARY_LENGTH} characters`);
  }
}

export function aggregateJson(
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

export function visitFromRow(row: VisitRow): {
  presentationSessionEpoch: number;
  seq: number;
  publicSlideKey: string;
  occurrenceSeq: number;
  enteredOffsetMs: number;
  leftOffsetMs: number;
  producerId: string;
} {
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

export function stateFromRow(row: StateRow): {
  ownerSubject: string;
  revision: number;
  speechSummary: string;
  wordCount: number;
  speakingDurationMs: number;
  coachingAggregate: unknown;
  finalizedAtMs: number | null;
  reportVersion: number;
} {
  const reportVersion = safeInteger(row.report_version, "report_version");
  if (reportVersion < 1) throw new Error("session report report_version is invalid");
  return {
    ownerSubject: row.owner_subject,
    revision: safeInteger(row.revision, "revision"),
    speechSummary: row.speech_summary,
    wordCount: safeInteger(row.word_count, "word_count"),
    speakingDurationMs: safeInteger(row.speaking_duration_ms, "speaking_duration_ms"),
    coachingAggregate: row.coaching_aggregate,
    finalizedAtMs: row.finalized_at === null ? null : row.finalized_at.getTime(),
    reportVersion,
  };
}

export function qaExchangeFromRow(row: QaExchangeRow): QaExchangeItem {
  if (row.origin !== "TYPED" && row.origin !== "SPOKEN") {
    throw new Error("qa exchange origin is invalid");
  }
  if (typeof row.defense_payload !== "object" || row.defense_payload === null) {
    throw new Error("qa exchange defense payload is invalid");
  }
  return {
    exchangeId: row.exchange_id,
    askedAtMs: safeInteger(row.asked_offset_ms, "asked_offset_ms"),
    question: row.question,
    origin: row.origin,
    defense: parseQaDefensePayload(row.defense_payload),
  };
}

export async function establishTenant(sql: Sql, tenantId: string): Promise<void> {
  await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
}

export async function assertOwner(sql: Sql, principal: SessionReportPrincipal): Promise<void> {
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
