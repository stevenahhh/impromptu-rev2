/**
 * Thin ingest seam for presentation Q&A defense exchanges.
 *
 * A route maps one audience question plus its model outcome into an ingest call here; the ledger
 * mints a FRESH random exchange id for every ingest lacking an explicit one — a repeated identical
 * question is a genuine second ask and is recorded as a distinct exchange — and honors a
 * caller-SUPPLIED id only when the caller deliberately passes an idempotency key. The ledger
 * validates the closed persisted shape and delegates the durable write to the session report finalizer so ordering stays serialized per session. The
 * exchange log is an owner-checked durable record of its own and appends regardless of report
 * finalization. No HTTP, no model calls: the wire contract lives above this seam.
 */

export type QaExchangeOrigin = "TYPED" | "SPOKEN";

export type QaCitation =
  | Readonly<{ kind: "DECK_SLIDE"; slideOrdinal: number }>
  | Readonly<{ kind: "REFERENCE_DOCUMENT"; documentTitle: string; chunkOrdinal: number }>
  | Readonly<{ kind: "EXTERNAL_SOURCE"; url: string }>;

export type QaDefenseOutcome =
  | Readonly<{ outcome: "ANSWERED"; answerText: string; citations: readonly QaCitation[] }>
  | Readonly<{ outcome: "ABSTAINED"; abstainReason: string; retryable: boolean }>;

export type QaExchangeItem = Readonly<{
  exchangeId: string;
  askedAtMs: number;
  question: string;
  origin: QaExchangeOrigin;
  defense: QaDefenseOutcome;
}>;

export type AppendQaExchangeInput = Readonly<{
  tenantId: string;
  presentationSessionId: string;
  ownerSubject: string;
}> &
  QaExchangeItem;

export type QaExchangeAppendResult =
  | Readonly<{ outcome: "APPENDED"; exchange: QaExchangeItem }>
  | Readonly<{ outcome: "DUPLICATE"; exchange: QaExchangeItem }>;

export const QA_DEFENSE_REPORT_LABEL = "질의응답";

const MAX_EXCHANGE_ID_LENGTH = 200;
const MAX_QUESTION_LENGTH = 4_000;
const MAX_ANSWER_TEXT_LENGTH = 8_000;
const MAX_ABSTAIN_REASON_LENGTH = 500;
const MAX_CITATIONS = 20;
const MAX_URL_LENGTH = 2_048;
const MAX_DOCUMENT_TITLE_LENGTH = 512;
const MAX_SERIALIZED_DEFENSE_LENGTH = 16_384;

function boundedText(value: string, field: string, maximum: number): void {
  if (value.length === 0 || value.length > maximum) {
    throw new RangeError(`${field} must contain between 1 and ${maximum} characters`);
  }
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

export function parseQaCitation(value: unknown): QaCitation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RangeError("citation must be an object");
  }
  const citation = value as Record<string, unknown>;
  switch (citation.kind) {
    case "DECK_SLIDE":
      positiveInteger(citation.slideOrdinal as number, "citations.slideOrdinal");
      return { kind: "DECK_SLIDE", slideOrdinal: citation.slideOrdinal as number };
    case "REFERENCE_DOCUMENT": {
      boundedText(
        citation.documentTitle as string,
        "citations.documentTitle",
        MAX_DOCUMENT_TITLE_LENGTH,
      );
      nonNegativeInteger(citation.chunkOrdinal as number, "citations.chunkOrdinal");
      return {
        kind: "REFERENCE_DOCUMENT",
        documentTitle: citation.documentTitle as string,
        chunkOrdinal: citation.chunkOrdinal as number,
      };
    }
    case "EXTERNAL_SOURCE":
      boundedText(citation.url as string, "citations.url", MAX_URL_LENGTH);
      return { kind: "EXTERNAL_SOURCE", url: citation.url as string };
    default:
      throw new RangeError(
        "citation kind must be DECK_SLIDE, REFERENCE_DOCUMENT or EXTERNAL_SOURCE",
      );
  }
}

export function parseQaDefensePayload(value: unknown): QaDefenseOutcome {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RangeError("defense must be an object");
  }
  const defense = value as Record<string, unknown>;
  if (defense.outcome === "ANSWERED") {
    boundedText(defense.answerText as string, "defense.answerText", MAX_ANSWER_TEXT_LENGTH);
    if (!Array.isArray(defense.citations) || defense.citations.length > MAX_CITATIONS) {
      throw new RangeError(`defense.citations must hold at most ${MAX_CITATIONS} entries`);
    }
    const citations = defense.citations.map(parseQaCitation);
    return { outcome: "ANSWERED", answerText: defense.answerText as string, citations };
  }
  if (defense.outcome === "ABSTAINED") {
    boundedText(
      defense.abstainReason as string,
      "defense.abstainReason",
      MAX_ABSTAIN_REASON_LENGTH,
    );
    if (typeof defense.retryable !== "boolean") {
      throw new RangeError("defense.retryable must be a boolean");
    }
    return {
      outcome: "ABSTAINED",
      abstainReason: defense.abstainReason as string,
      retryable: defense.retryable,
    };
  }
  throw new RangeError("defense outcome must be ANSWERED or ABSTAINED");
}

/** Validates the full exchange draft; throws `RangeError` with the offending field on malformation. */
export function parseQaExchangeDraft(value: unknown): QaExchangeItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RangeError("exchange draft must be an object");
  }
  const draft = value as Record<string, unknown>;
  boundedText(draft.exchangeId as string, "exchangeId", MAX_EXCHANGE_ID_LENGTH);
  nonNegativeInteger(draft.askedAtMs as number, "askedAtMs");
  boundedText(draft.question as string, "question", MAX_QUESTION_LENGTH);
  if (draft.origin !== "TYPED" && draft.origin !== "SPOKEN") {
    throw new RangeError("origin must be TYPED or SPOKEN");
  }
  const serialized = JSON.stringify(draft.defense);
  if (typeof serialized !== "string" || serialized.length > MAX_SERIALIZED_DEFENSE_LENGTH) {
    throw new RangeError("defense payload is not serializable within the storage bound");
  }
  const defense = parseQaDefensePayload(draft.defense);
  return {
    exchangeId: draft.exchangeId as string,
    askedAtMs: draft.askedAtMs as number,
    question: draft.question as string,
    origin: draft.origin,
    defense,
  };
}

export function generateQaExchangeId(): string {
  // Random, not content-derived: two identical questions are TWO asks with distinct ids. A
  // deterministic hash of question text would recreate the retired time-bucket collision.
  return `qa-${crypto.randomUUID()}`;
}

/** Structural seam satisfied by `SessionReportFinalizer.recordQaExchange`; keeps this module HTTP-free. */
export interface QaExchangeSink {
  recordQaExchange(
    principal: Readonly<{
      tenantId: string;
      presentationSessionId: string;
      ownerSubject: string;
    }>,
    exchange: QaExchangeItem,
  ): Promise<QaExchangeAppendResult>;
}

export type QaExchangeIngestInput = Readonly<{
  tenantId: string;
  presentationSessionId: string;
  ownerSubject: string;
  /**
   * Absent ids are generated fresh per ingest (a repeated identical ask is a GENUINE second
   * exchange). Present ids are explicit CALLER-supplied idempotency keys, honored verbatim:
   * byte-equal retries dedupe at the store, differing content raises the typed conflict.
   */
  exchangeId?: string;
}> &
  Omit<QaExchangeItem, "exchangeId">;

export type QaExchangeIngestReceipt = Readonly<{
  outcome: "ACCEPTED";
  exchangeId: string;
  duplicate: boolean;
}>;

export class QaExchangeLedger {
  constructor(private readonly sink: QaExchangeSink) {}

  async ingest(input: QaExchangeIngestInput): Promise<QaExchangeIngestReceipt> {
    const exchange = parseQaExchangeDraft({
      exchangeId: input.exchangeId ?? generateQaExchangeId(),
      askedAtMs: input.askedAtMs,
      question: input.question,
      origin: input.origin,
      defense: input.defense,
    });
    const result = await this.sink.recordQaExchange(
      {
        tenantId: input.tenantId,
        presentationSessionId: input.presentationSessionId,
        ownerSubject: input.ownerSubject,
      },
      exchange,
    );
    return {
      outcome: "ACCEPTED",
      exchangeId: exchange.exchangeId,
      duplicate: result.outcome === "DUPLICATE",
    };
  }
}
