// The qaDefense section of a finalized session report: its closed view type and parser.
//
// Source of truth is the private backend's finalized report DTO
// (services/private-backend/src/report/session-report-dto.ts), which materializes persisted
// exchanges verbatim from the ledger (services/private-backend/src/qa/qa-exchange-ledger.ts).
// So this section carries the LEDGER field names — defense.answerText and defense.abstainReason —
// which intentionally differ from the live Q&A wire contract's `answer` / `reason`.

import { externalSourceUrl } from "./private-transport";

export type QaDefenseOriginView = "TYPED" | "SPOKEN";

export type QaDefenseCitationReportView =
  | Readonly<{ kind: "DECK_SLIDE"; slideOrdinal: number }>
  | Readonly<{ kind: "REFERENCE_DOCUMENT"; documentTitle: string; chunkOrdinal: number }>
  | Readonly<{ kind: "EXTERNAL_SOURCE"; url: string }>;

export type QaDefenseOutcomeReportView =
  | Readonly<{
      outcome: "ANSWERED";
      answerText: string;
      citations: readonly QaDefenseCitationReportView[];
    }>
  | Readonly<{ outcome: "ABSTAINED"; abstainReason: string; retryable: boolean }>;

export type QaDefenseExchangeReportView = Readonly<{
  exchangeId: string;
  askedAtMs: number;
  question: string;
  origin: QaDefenseOriginView;
  defense: QaDefenseOutcomeReportView;
}>;

/**
 * A present-but-unreadable section degrades to UNREADABLE instead of poisoning its whole
 * report: an otherwise valid v2 report must still render everything else.
 */
export type QaDefenseSectionReportView =
  | Readonly<{
      status: "READY";
      label: string;
      exchanges: readonly QaDefenseExchangeReportView[];
    }>
  | Readonly<{ status: "UNREADABLE" }>;

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function citation(value: unknown): QaDefenseCitationReportView | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case "DECK_SLIDE":
      // Slide ordinals are 1-based on the backend ledger.
      return typeof record.slideOrdinal === "number" &&
        Number.isSafeInteger(record.slideOrdinal) &&
        record.slideOrdinal > 0
        ? { kind: "DECK_SLIDE", slideOrdinal: record.slideOrdinal }
        : null;
    case "REFERENCE_DOCUMENT":
      return nonEmptyString(record.documentTitle) && nonNegativeInteger(record.chunkOrdinal)
        ? {
            kind: "REFERENCE_DOCUMENT",
            documentTitle: record.documentTitle,
            chunkOrdinal: record.chunkOrdinal,
          }
        : null;
    case "EXTERNAL_SOURCE": {
      const url = externalSourceUrl(record.url);
      return url === null ? null : { kind: "EXTERNAL_SOURCE", url };
    }
    default:
      return null;
  }
}

function defense(value: unknown): QaDefenseOutcomeReportView | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.outcome === "ANSWERED") {
    if (!nonEmptyString(record.answerText) || !Array.isArray(record.citations)) return null;
    const parsedCitations = record.citations.map(citation);
    if (parsedCitations.some((entry) => entry === null)) return null;
    return {
      outcome: "ANSWERED",
      answerText: record.answerText,
      citations: parsedCitations as readonly QaDefenseCitationReportView[],
    };
  }
  if (record.outcome === "ABSTAINED") {
    return nonEmptyString(record.abstainReason) && typeof record.retryable === "boolean"
      ? {
          outcome: "ABSTAINED",
          abstainReason: record.abstainReason,
          retryable: record.retryable,
        }
      : null;
  }
  return null;
}

function exchange(value: unknown): QaDefenseExchangeReportView | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !nonEmptyString(record.exchangeId) ||
    !nonNegativeInteger(record.askedAtMs) ||
    !nonEmptyString(record.question) ||
    (record.origin !== "TYPED" && record.origin !== "SPOKEN")
  ) {
    return null;
  }
  const parsedDefense = defense(record.defense);
  if (parsedDefense === null) return null;
  return {
    exchangeId: record.exchangeId,
    askedAtMs: record.askedAtMs,
    question: record.question,
    origin: record.origin,
    defense: parsedDefense,
  };
}

/**
 * Closed parse of the whole section: anything unknown or malformed yields UNREADABLE rather than
 * a partially-trusted object. Absence of the key means a v1-shaped report and returns undefined
 * so no degraded marker is rendered for older reports.
 */
export function qaDefenseSection(value: unknown): QaDefenseSectionReportView | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { status: "UNREADABLE" };
  }
  const record = value as Record<string, unknown>;
  // An empty exchanges list stays READY: a v2 talk that drew no audience question still ships
  // the labeled section from the backend finalizer.
  if (record.label !== "질의응답" || !Array.isArray(record.exchanges)) {
    return { status: "UNREADABLE" };
  }
  const parsed = record.exchanges.map(exchange);
  if (parsed.some((entry) => entry === null)) return { status: "UNREADABLE" };
  return {
    status: "READY",
    label: "질의응답",
    exchanges: parsed as readonly QaDefenseExchangeReportView[],
  };
}
