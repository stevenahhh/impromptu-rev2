import { describe, expect, test } from "bun:test";
import {
  type QaExchangeAppendResult,
  type QaExchangeIngestInput,
  type QaExchangeItem,
  QaExchangeLedger,
} from "../src/qa/qa-exchange-ledger.ts";
import type {
  AppendSlideVisitInput,
  CompareAndSetSessionReportStateInput,
  SessionReportPrincipal,
  SessionReportRepository,
  SessionReportState,
  SlideVisit,
} from "../src/report/postgres-session-report-repository.ts";
import {
  SessionReportFinalizedError,
  SessionReportStateConflictError,
} from "../src/report/postgres-session-report-repository.ts";
import { SessionReportFinalizer } from "../src/report/session-report-finalizer.ts";

const principal: SessionReportPrincipal = {
  tenantId: "tenant-owner",
  presentationSessionId: "presentation-alpha",
  ownerSubject: "account-owner",
};

const answeredDefense: QaExchangeItem["defense"] = {
  outcome: "ANSWERED",
  answerText: "데이터 근거를 인용해 답변했습니다",
  citations: [{ kind: "DECK_SLIDE", slideOrdinal: 3 }],
};

class RecordingSink {
  readonly appended: QaExchangeItem[] = [];
  nextResults: QaExchangeAppendResult[] = [];

  async recordQaExchange(
    _principal: SessionReportPrincipal,
    exchange: QaExchangeItem,
  ): Promise<QaExchangeAppendResult> {
    const appended = structuredClone(exchange);
    this.appended.push(appended);
    const next = this.nextResults.shift();
    return next ?? { outcome: "APPENDED", exchange: appended };
  }
}

class MemoryReportRepository implements SessionReportRepository {
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
        this.visits.filter((visit) => visit.publicSlideKey === input.publicSlideKey).length + 1,
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

function ingestInput(overrides: Partial<QaExchangeIngestInput> = {}): QaExchangeIngestInput {
  return {
    tenantId: principal.tenantId,
    presentationSessionId: principal.presentationSessionId,
    ownerSubject: principal.ownerSubject,
    askedAtMs: 120,
    question: "이번 분기 유지율은 어떻게 확인했나요?",
    origin: "TYPED",
    defense: answeredDefense,
    ...overrides,
  };
}

describe("qa exchange ledger ingest seam", () => {
  test("assigns an exchange id when absent and records the mapped outcome through the sink", async () => {
    const sink = new RecordingSink();
    const ledger = new QaExchangeLedger(sink);

    const receipt = await ledger.ingest(ingestInput());

    expect(receipt.outcome).toBe("ACCEPTED");
    if (receipt.outcome !== "ACCEPTED") throw receipt;
    expect(receipt.duplicate).toBe(false);
    expect(receipt.exchangeId.startsWith("qa-")).toBe(true);
    expect(sink.appended.length).toBe(1);
    expect(sink.appended[0]?.exchangeId).toBe(receipt.exchangeId);
    expect(sink.appended[0]?.defense).toEqual(answeredDefense);
    expect(sink.appended[0]?.origin).toBe("TYPED");
  });

  test("accepts a supplied exchange id and reports the repeat as a duplicate", async () => {
    const sink = new RecordingSink();
    sink.nextResults.push({
      outcome: "APPENDED",
      exchange: {
        exchangeId: "qa-fixed-1",
        askedAtMs: 120,
        question: "q",
        origin: "TYPED",
        defense: answeredDefense,
      },
    });
    sink.nextResults.push({
      outcome: "DUPLICATE",
      exchange: {
        exchangeId: "qa-fixed-1",
        askedAtMs: 120,
        question: "q",
        origin: "TYPED",
        defense: answeredDefense,
      },
    });
    const ledger = new QaExchangeLedger(sink);

    const first = await ledger.ingest(ingestInput({ exchangeId: "qa-fixed-1" }));
    const second = await ledger.ingest(ingestInput({ exchangeId: "qa-fixed-1" }));

    expect(first.outcome).toBe("ACCEPTED");
    if (first.outcome !== "ACCEPTED") throw first;
    expect(first.exchangeId).toBe("qa-fixed-1");
    expect(second.outcome).toBe("ACCEPTED");
    if (second.outcome !== "ACCEPTED") throw second;
    expect(second.duplicate).toBe(true);
    expect(sink.appended.length).toBe(2);
    expect(sink.appended.every((exchange) => exchange.exchangeId === "qa-fixed-1")).toBe(true);
  });

  test("a genuine re-ask without an explicit id gets a FRESH id, even for byte-identical text", async () => {
    // Post-rule equivalent of the retired 30-second-window dedupe: identical questions are
    // distinct exchanges. Wall-clock buckets are forbidden; only an explicit caller-supplied
    // idempotency key may ever request deduplication.
    const sink = new RecordingSink();
    const ledger = new QaExchangeLedger(sink);

    const first = await ledger.ingest(ingestInput());
    const second = await ledger.ingest(ingestInput());

    expect(first.outcome).toBe("ACCEPTED");
    if (first.outcome !== "ACCEPTED") throw first;
    expect(second.outcome).toBe("ACCEPTED");
    if (second.outcome !== "ACCEPTED") throw second;
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(false);
    expect(second.exchangeId).not.toBe(first.exchangeId);
    // Both genuinely reached the durable seam — nothing was short-circuited locally.
    expect(sink.appended.length).toBe(2);
    expect(new Set(sink.appended.map((exchange) => exchange.exchangeId)).size).toBe(2);
  });

  test("an unexpected sink failure propagates instead of being swallowed", async () => {
    const failure = new Error("exchange store unavailable");
    const failingSink = new QaExchangeLedger({
      async recordQaExchange(): Promise<QaExchangeAppendResult> {
        throw failure;
      },
    });

    expect(failingSink.ingest(ingestInput())).rejects.toBe(failure);
  });

  test("an ingest landing after endSession is ACCEPTED, persisted exactly once, and readable in the finalized report", async () => {
    const repository = new MemoryReportRepository();
    const finalizer = new SessionReportFinalizer(repository);
    const ledger = new QaExchangeLedger(finalizer);
    finalizer.recordAcceptedSlideSet({
      principal,
      presentationSessionEpoch: 1,
      sequence: 1,
      publicSlideKey: "A",
      acceptedOffsetMs: 0,
      producerId: "cmd-a-1",
    });
    // Ending the talk finalizes the report synchronously inside the end flow.
    const end = await finalizer.endSession({
      principal,
      endedOffsetMs: 1_000,
      finalizedAtMs: 10_000,
      preparedEvidence: { label: "준비된 근거", items: [] },
    });
    expect((await end.finalization).outcome).toBe("FINALIZED");

    const late = await ledger.ingest(ingestInput());
    // The post-talk rule: an owner-checked ask after the talk is over is RECORDED, not refused.
    expect(late.outcome).toBe("ACCEPTED");
    if (late.outcome !== "ACCEPTED") throw late;
    expect(late.duplicate).toBe(false);
    const retried = await ledger.ingest(ingestInput({ exchangeId: late.exchangeId }));
    expect(retried.outcome === "ACCEPTED" && retried.duplicate).toBe(true);
    expect(repository.exchanges.length).toBe(1);

    const report = await new SessionReportFinalizer(repository).readFinalizedReport(principal, {
      label: "준비된 근거",
      items: [],
    });
    expect(report?.qaDefense?.exchanges.map((exchange) => exchange.exchangeId)).toEqual([
      late.exchangeId,
    ]);
  });
});
