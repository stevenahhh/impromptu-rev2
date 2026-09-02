import type { QaDefenseOutcome, QaExchangeItem } from "../../src/qa/qa-exchange-ledger.ts";
import type {
  AppendSlideVisitInput,
  CompareAndSetSessionReportStateInput,
  SessionReportRepository,
  SessionReportState,
  SlideVisit,
} from "../../src/report/postgres-session-report-repository.ts";
import {
  SessionReportFinalizedError,
  SessionReportStateConflictError,
} from "../../src/report/postgres-session-report-repository.ts";

/**
 * In-memory `SessionReportRepository` encoding the POST-rule contract under test: report state
 * stays immutable after finalization (the CAS refuses any later write) while Q&A exchanges are
 * their own durable record that keeps appending across finalization. Used by route-level wiring
 * tests where the real HTTP dispatch meets the real finalizer and ledger.
 */
export class MemorySessionReportRepository implements SessionReportRepository {
  readonly visits: SlideVisit[] = [];
  readonly exchanges: QaExchangeItem[] = [];
  state: SessionReportState | null = null;

  async appendSlideVisit(input: AppendSlideVisitInput) {
    const duplicate = this.visits.find((visit) => visit.producerId === input.producerId);
    if (duplicate !== undefined) return { outcome: "DUPLICATE" as const, visit: duplicate };
    if (this.state?.finalizedAtMs !== null && this.state !== null) {
      throw new SessionReportFinalizedError("finalized");
    }
    const visit: SlideVisit = {
      presentationSessionEpoch: input.presentationSessionEpoch,
      seq: input.seq,
      publicSlideKey: input.publicSlideKey,
      occurrenceSeq:
        this.visits.filter((row) => row.publicSlideKey === input.publicSlideKey).length + 1,
      enteredOffsetMs: input.enteredOffsetMs,
      leftOffsetMs: input.leftOffsetMs,
      producerId: input.producerId,
    };
    this.visits.push(visit);
    return { outcome: "APPENDED" as const, visit };
  }

  async compareAndSetState(input: CompareAndSetSessionReportStateInput) {
    if (this.state?.finalizedAtMs !== null && this.state !== null) {
      throw new SessionReportFinalizedError("finalized");
    }
    const revision = this.state?.revision ?? 0;
    if (revision !== input.expectedRevision) {
      throw new SessionReportStateConflictError("stale");
    }
    this.state = {
      ownerSubject: input.ownerSubject,
      revision: revision + 1,
      speechSummary: input.speechSummary,
      wordCount: input.wordCount,
      speakingDurationMs: input.speakingDurationMs,
      coachingAggregate: structuredClone(input.coachingAggregate),
      finalizedAtMs: input.finalizedAtMs,
      reportVersion: input.finalizedAtMs !== null ? 2 : (this.state?.reportVersion ?? 1),
    };
    return structuredClone(this.state);
  }

  async appendQaExchange(input: Parameters<SessionReportRepository["appendQaExchange"]>[0]) {
    const duplicate = this.exchanges.find((exchange) => exchange.exchangeId === input.exchangeId);
    if (duplicate !== undefined) return { outcome: "DUPLICATE" as const, exchange: duplicate };
    const exchange: QaExchangeItem = {
      exchangeId: input.exchangeId,
      askedAtMs: input.askedAtMs,
      question: input.question,
      origin: input.origin,
      defense: structuredClone(input.defense),
    };
    this.exchanges.push(exchange);
    return { outcome: "APPENDED" as const, exchange };
  }

  async readSlideVisits(): Promise<readonly SlideVisit[]> {
    return structuredClone(this.visits);
  }

  async readQaExchanges(): Promise<readonly QaExchangeItem[]> {
    return structuredClone(this.exchanges);
  }

  async readForOwner(): Promise<SessionReportState | null> {
    return this.state === null ? null : structuredClone(this.state);
  }
}

export function sampleAnsweredDefense(): QaDefenseOutcome {
  return {
    outcome: "ANSWERED",
    answerText: "슬라이드 3의 지표로 답변했습니다",
    citations: [{ kind: "DECK_SLIDE", slideOrdinal: 3 }],
  };
}
