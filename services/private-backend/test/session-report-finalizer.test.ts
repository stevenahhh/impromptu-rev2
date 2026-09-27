import { describe, expect, test } from "bun:test";
import type { QaDefenseOutcome, QaExchangeItem } from "../src/qa/qa-exchange-ledger.ts";
import {
  createFinalizedSessionReportReadRouteHandler,
  createSessionReportRouteHandler,
} from "../src/report/http.ts";
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
import {
  type PreparedEvidenceReportSnapshot,
  type SessionReport,
  SessionReportFinalizer,
} from "../src/report/session-report-finalizer.ts";

const principal: SessionReportPrincipal = {
  tenantId: "tenant-owner",
  presentationSessionId: "presentation-alpha",
  ownerSubject: "account-owner",
};

const preparedEvidence: PreparedEvidenceReportSnapshot = {
  label: "준비된 근거",
  items: [
    {
      evidenceId: "evidence-1",
      sourceId: "source-product-metrics",
      sourceUrl: "https://example.test/evidence",
      provenance: "CURATED_PREAPPROVED",
    },
  ],
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve() {
      resolvePromise?.();
    },
  };
}

const answeredDefense: QaDefenseOutcome = {
  outcome: "ANSWERED",
  answerText: "슬라이드 3의 지표로 답변했습니다",
  citations: [{ kind: "DECK_SLIDE", slideOrdinal: 3 }],
};

class MemoryReportRepository implements SessionReportRepository {
  readonly visits: SlideVisit[] = [];
  readonly exchanges: QaExchangeItem[] = [];
  state: SessionReportState | null = null;
  finalizedCasGate: Promise<void> | null = null;
  finalizedCasFailure: Error | null = null;

  async appendSlideVisit(input: AppendSlideVisitInput) {
    const duplicate = this.visits.find((visit) => visit.producerId === input.producerId);
    if (duplicate !== undefined) return { outcome: "DUPLICATE" as const, visit: duplicate };
    if (this.state?.finalizedAtMs !== null && this.state !== null) {
      throw new SessionReportFinalizedError("finalized");
    }
    const occurrenceSeq =
      this.visits.filter((visit) => visit.publicSlideKey === input.publicSlideKey).length + 1;
    const visit: SlideVisit = {
      presentationSessionEpoch: input.presentationSessionEpoch,
      seq: input.seq,
      publicSlideKey: input.publicSlideKey,
      occurrenceSeq,
      enteredOffsetMs: input.enteredOffsetMs,
      leftOffsetMs: input.leftOffsetMs,
      producerId: input.producerId,
    };
    this.visits.push(visit);
    this.visits.sort((left, right) => left.seq - right.seq);
    return { outcome: "APPENDED" as const, visit };
  }

  async compareAndSetState(input: CompareAndSetSessionReportStateInput) {
    if (input.finalizedAtMs !== null && this.finalizedCasGate !== null) {
      await this.finalizedCasGate;
    }
    if (input.finalizedAtMs !== null && this.finalizedCasFailure !== null) {
      const failure = this.finalizedCasFailure;
      this.finalizedCasFailure = null;
      throw failure;
    }
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

  async readSlideVisits() {
    return structuredClone(this.visits);
  }

  async readQaExchanges(): Promise<readonly QaExchangeItem[]> {
    return structuredClone(this.exchanges);
  }

  async readForOwner() {
    return this.state === null ? null : structuredClone(this.state);
  }
}

function recordVisits(finalizer: SessionReportFinalizer): void {
  finalizer.recordAcceptedSlideSet({
    principal,
    presentationSessionEpoch: 1,
    sequence: 1,
    publicSlideKey: "A",
    acceptedOffsetMs: 0,
    producerId: "cmd-a-1",
  });
  finalizer.recordAcceptedSlideSet({
    principal,
    presentationSessionEpoch: 1,
    sequence: 2,
    publicSlideKey: "B",
    acceptedOffsetMs: 300,
    producerId: "cmd-b-1",
  });
  finalizer.recordAcceptedSlideSet({
    principal,
    presentationSessionEpoch: 1,
    sequence: 3,
    publicSlideKey: "A",
    acceptedOffsetMs: 600,
    producerId: "cmd-a-2",
  });
}

/** Everything a finalized report owns EXCEPT the additive qaDefense section. */
function talkView(report: SessionReport): Omit<SessionReport, "qaDefense"> {
  const { qaDefense: _section, ...talk } = report;
  return talk;
}

describe("owner-only asynchronous session report finalization", () => {
  test("returns 202 before finalization and reproduces byte-equivalent derived-only JSON after restart", async () => {
    const repository = new MemoryReportRepository();
    const releaseFinalCas = deferred();
    repository.finalizedCasGate = releaseFinalCas.promise;
    const finalizer = new SessionReportFinalizer(repository);
    recordVisits(finalizer);

    const rawBodySentinel = "원문-본문-절대-리포트에-포함하지-않음";
    finalizer.recordFinal(principal, {
      finalSegmentId: "final-1",
      transcript: {
        text: rawBodySentinel,
        durationMs: 500,
        words: [
          { text: "원문", startMs: 0, endMs: 100 },
          { text: "본문", startMs: 200, endMs: 500 },
        ],
      },
      coaching: {
        cueCount: 1,
        currentWordsPerMinute: 120,
        previousWordsPerMinute: null,
      },
    });

    const ownerResolver = {
      async resolve(input: { accountId: string; presentationSessionId: string }) {
        return input.accountId === principal.ownerSubject &&
          input.presentationSessionId === principal.presentationSessionId
          ? principal
          : null;
      },
    };
    const handler = createSessionReportRouteHandler(
      finalizer,
      ownerResolver,
      {
        async resolve() {
          return preparedEvidence;
        },
      },
      {
        async resolve() {
          return {
            endedOffsetMs: 1_000,
            finalizedAtMs: 10_000,
            preparedEvidence,
          };
        },
      },
    );

    const endResponse = await handler(
      new Request(
        `https://private.test/v1/presentation-sessions/${principal.presentationSessionId}/end`,
        {
          method: "POST",
        },
      ),
      principal.ownerSubject,
    );
    expect(endResponse?.status).toBe(202);
    expect(repository.state?.finalizedAtMs).toBeNull();

    releaseFinalCas.resolve();
    const accepted = await finalizer.endSession({
      principal,
      endedOffsetMs: 1_000,
      finalizedAtMs: 10_000,
      preparedEvidence,
    });
    const completion = await accepted.finalization;
    expect(completion.outcome).toBe("FINALIZED");
    if (completion.outcome !== "FINALIZED") throw completion.error;

    expect(completion.report.slideVisits.map((visit) => visit.occurrenceSequence)).toEqual([
      1, 1, 2,
    ]);
    expect(completion.report.slideVisits.map((visit) => visit.dwellMs)).toEqual([300, 300, 400]);

    const beforeRestart = JSON.stringify(completion.report);
    const restarted = new SessionReportFinalizer(repository);
    const afterRestartReport = await restarted.readFinalizedReport(principal, preparedEvidence);
    const afterRestart = JSON.stringify(afterRestartReport);
    expect(afterRestart).toBe(beforeRestart);

    const forbidden = [rawBodySentinel, "transcript", "silence", "사용한 근거"];
    for (const value of forbidden) expect(beforeRestart.toLowerCase()).not.toContain(value);
    expect(beforeRestart).toContain("준비된 근거");
    expect(completion.report.speech).toEqual({
      derivedSummary: "1개 최종 발화에서 2개 단어를 집계했습니다.",
      wordCount: 2,
      speakingDurationMs: 400,
      timingAggregate: { finalCount: 1, measuredFinalCount: 1 },
      coachingAggregate: {
        cueCount: 1,
        latestCurrentWordsPerMinute: 120,
        latestPreviousWordsPerMinute: null,
      },
    });
  });

  test("retries idempotently after a crash between the initial CAS and materialization", async () => {
    const repository = new MemoryReportRepository();
    repository.finalizedCasFailure = new Error("injected process crash");
    const firstProcess = new SessionReportFinalizer(repository);
    recordVisits(firstProcess);
    firstProcess.recordFinal(principal, {
      finalSegmentId: "final-before-crash",
      transcript: {
        text: "이 원문은 재시작에도 저장되지 않습니다",
        durationMs: 200,
        words: [{ text: "단어", startMs: 20, endMs: 120 }],
      },
    });

    const firstEnd = await firstProcess.endSession({
      principal,
      endedOffsetMs: 1_000,
      finalizedAtMs: 10_000,
      preparedEvidence,
    });
    expect((await firstEnd.finalization).outcome).toBe("FAILED");
    expect(repository.state?.finalizedAtMs).toBeNull();

    const restartedProcess = new SessionReportFinalizer(repository);
    const retry = await restartedProcess.endSession({
      principal,
      endedOffsetMs: 1_000,
      finalizedAtMs: 10_000,
      preparedEvidence,
    });
    const result = await retry.finalization;
    expect(result.outcome).toBe("FINALIZED");
    if (result.outcome !== "FINALIZED") throw result.error;
    expect(result.report.slideVisits.map((visit) => visit.dwellMs)).toEqual([300, 300, 400]);
    expect(result.report.speech.wordCount).toBe(1);
  });

  test("a finalized report contains the labeled 질의응답 section with exchanges in ask order", async () => {
    const repository = new MemoryReportRepository();
    const finalizer = new SessionReportFinalizer(repository);

    const first = await finalizer.recordQaExchange(principal, {
      exchangeId: "qa-exchange-first",
      askedAtMs: 150,
      question: "경쟁사 대비 차별점은 무엇인가요?",
      origin: "SPOKEN",
      defense: answeredDefense,
    });
    expect(first.outcome).toBe("APPENDED");
    // An in-flight retry of the same exchange must not be written twice.
    const retried = await finalizer.recordQaExchange(principal, {
      exchangeId: "qa-exchange-first",
      askedAtMs: 150,
      question: "경쟁사 대비 차별점은 무엇인가요?",
      origin: "SPOKEN",
      defense: answeredDefense,
    });
    expect(retried.outcome).toBe("DUPLICATE");
    const second = await finalizer.recordQaExchange(principal, {
      exchangeId: "qa-exchange-second",
      askedAtMs: 90,
      question: "유지율 근거를 어디서 확인할 수 있나요?",
      origin: "TYPED",
      defense: {
        outcome: "ABSTAINED",
        abstainReason: "검증된 근거가 없어 답변을 보류했습니다",
        retryable: false,
      },
    });
    expect(second.outcome).toBe("APPENDED");

    const end = await finalizer.endSession({
      principal,
      endedOffsetMs: 1_000,
      finalizedAtMs: 10_000,
      preparedEvidence,
    });
    const completion = await end.finalization;
    expect(completion.outcome).toBe("FINALIZED");
    if (completion.outcome !== "FINALIZED") throw completion.error;

    expect(completion.report.reportVersion).toBe(2);
    expect(completion.report.qaDefense?.label).toBe("질의응답");
    // Ask order is arrival order, not asked-at order: first-in wins deterministically.
    expect(completion.report.qaDefense?.exchanges.map((exchange) => exchange.exchangeId)).toEqual([
      "qa-exchange-first",
      "qa-exchange-second",
    ]);
    expect(completion.report.qaDefense?.exchanges[1]?.defense).toEqual({
      outcome: "ABSTAINED",
      abstainReason: "검증된 근거가 없어 답변을 보류했습니다",
      retryable: false,
    });

    const beforeRestart = JSON.stringify(completion.report);
    const restarted = new SessionReportFinalizer(repository);
    const afterRestart = await restarted.readFinalizedReport(principal, preparedEvidence);
    expect(JSON.stringify(afterRestart)).toBe(beforeRestart);
    expect(beforeRestart).toContain("질의응답");
  });

  test("a persisted v1 report still reads back without the qaDefense section", async () => {
    const repository = new MemoryReportRepository();
    repository.state = {
      ownerSubject: principal.ownerSubject,
      revision: 7,
      speechSummary: "요약",
      wordCount: 3,
      speakingDurationMs: 10,
      coachingAggregate: {
        timing: { finalCount: 1, measuredFinalCount: 1 },
        coaching: {
          cueCount: 0,
          latestCurrentWordsPerMinute: null,
          latestPreviousWordsPerMinute: null,
        },
      },
      finalizedAtMs: 5_000,
      reportVersion: 1,
    };
    const finalizer = new SessionReportFinalizer(repository);

    const report = await finalizer.readFinalizedReport(principal, preparedEvidence);

    expect(report).not.toBeNull();
    if (report === null) throw new Error("report missing");
    expect(report.reportVersion).toBe(1);
    expect("qaDefense" in report).toBe(false);
  });

  test("rechecks the presentation owner and rejects a same-tenant non-owner with 403", async () => {
    const repository = new MemoryReportRepository();
    const finalizer = new SessionReportFinalizer(repository);
    const accepted = await finalizer.endSession({
      principal,
      endedOffsetMs: 0,
      finalizedAtMs: 10_000,
      preparedEvidence,
    });
    expect((await accepted.finalization).outcome).toBe("FINALIZED");

    const handler = createFinalizedSessionReportReadRouteHandler(
      finalizer,
      {
        async resolve({ accountId, presentationSessionId }) {
          return accountId === principal.ownerSubject &&
            presentationSessionId === principal.presentationSessionId
            ? principal
            : null;
        },
      },
      {
        async resolve() {
          return preparedEvidence;
        },
      },
    );
    const response = await handler(
      new Request(
        `https://private.test/v1/presentation-sessions/${principal.presentationSessionId}/report`,
      ),
      "account-same-tenant-non-owner",
    );
    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({ error: "report_forbidden" });
  });

  test("a post-talk exchange appends after finalization, shows up when the report is read, and leaves the finalized talk data byte-identical", async () => {
    const repository = new MemoryReportRepository();
    const finalizer = new SessionReportFinalizer(repository);
    recordVisits(finalizer);
    // The presenter presses end; the report lane finalizes synchronously inside that flow.
    const end = await finalizer.endSession({
      principal,
      endedOffsetMs: 1_000,
      finalizedAtMs: 10_000,
      preparedEvidence,
    });
    const completion = await end.finalization;
    expect(completion.outcome).toBe("FINALIZED");
    if (completion.outcome !== "FINALIZED") throw completion.error;
    const beforeTalk = JSON.stringify(talkView(completion.report));

    const late = await finalizer.recordQaExchange(principal, {
      exchangeId: "qa-after-end-1",
      askedAtMs: 12_000,
      question: "발표가 끝난 뒤의 질문",
      origin: "TYPED",
      defense: answeredDefense,
    });
    expect(late.outcome).toBe("APPENDED");
    // Idempotency holds across finalization: same id writes once.
    const retried = await finalizer.recordQaExchange(principal, {
      exchangeId: "qa-after-end-1",
      askedAtMs: 12_000,
      question: "발표가 끝난 뒤의 질문",
      origin: "TYPED",
      defense: answeredDefense,
    });
    expect(retried.outcome).toBe("DUPLICATE");
    expect(repository.exchanges.length).toBe(1);

    const reread = await finalizer.readFinalizedReport(principal, preparedEvidence);
    expect(reread).not.toBeNull();
    if (reread === null) throw new Error("finalized report missing after post-talk append");
    expect(reread.qaDefense?.label).toBe("질의응답");
    expect(reread.qaDefense?.exchanges.map((exchange) => exchange.exchangeId)).toEqual([
      "qa-after-end-1",
    ]);
    expect(reread.finalizedAtMs).toBe(10_000);
    expect(JSON.stringify(talkView(reread))).toBe(beforeTalk);
  });
});

describe("pending report recovery through the read route", () => {
  const ownerResolver = {
    async resolve(input: { accountId: string; presentationSessionId: string }) {
      return input.accountId === principal.ownerSubject &&
        input.presentationSessionId === principal.presentationSessionId
        ? principal
        : null;
    },
  };
  const reportGet = () =>
    new Request(
      `https://private.test/v1/presentation-sessions/${principal.presentationSessionId}/report`,
    );
  const endPost = () =>
    new Request(
      `https://private.test/v1/presentation-sessions/${principal.presentationSessionId}/end`,
      { method: "POST" },
    );

  function recoveringRoute(finalizer: SessionReportFinalizer, ended: boolean, withResolver = true) {
    return createSessionReportRouteHandler(
      finalizer,
      ownerResolver,
      {
        async resolve() {
          return preparedEvidence;
        },
      },
      {
        async resolve() {
          return { endedOffsetMs: 100, finalizedAtMs: 9_000, preparedEvidence };
        },
        ...(withResolver
          ? {
              // Mirrors the bootstrap resolver: a context only exists once the lifecycle
              // actually ended, so a live talk's report can never be finalized by a read.
              async resolveEnded() {
                return ended
                  ? { endedOffsetMs: 100, finalizedAtMs: 9_000, preparedEvidence }
                  : null;
              },
            }
          : {}),
      },
    );
  }

  test("a read on an ended but unfinalized session re-drives finalization and answers the report", async () => {
    const repository = new MemoryReportRepository();
    // The pending row the crashed end left behind: derived state persisted, finalized_at null.
    repository.state = {
      ownerSubject: principal.ownerSubject,
      revision: 4,
      speechSummary: "요약",
      wordCount: 3,
      speakingDurationMs: 10,
      coachingAggregate: {
        timing: { finalCount: 1, measuredFinalCount: 1 },
        coaching: {
          cueCount: 0,
          latestCurrentWordsPerMinute: null,
          latestPreviousWordsPerMinute: null,
        },
      },
      finalizedAtMs: null,
      reportVersion: 1,
    };
    const route = recoveringRoute(new SessionReportFinalizer(repository), true);

    const response = await route(reportGet(), principal.ownerSubject);

    expect(response?.status).toBe(200);
    const body = (await response?.json()) as { report: SessionReport };
    expect(body.report.presentationSessionId).toBe(principal.presentationSessionId);
    expect(body.report.finalizedAtMs).toBe(9_000);
    expect(body.report.reportVersion).toBe(2);
    expect(repository.state?.finalizedAtMs).toBe(9_000);

    // The next read is the plain finalized path: no second end mutation, revision untouched.
    const revision = repository.state?.revision;
    const again = await route(reportGet(), principal.ownerSubject);
    expect(again?.status).toBe(200);
    expect(repository.state?.revision).toBe(revision);
  });

  test("a read recovers an end whose asynchronous finalization failed", async () => {
    const repository = new MemoryReportRepository();
    repository.finalizedCasFailure = new Error("injected crash after the pending row landed");
    const finalizer = new SessionReportFinalizer(repository);
    const route = recoveringRoute(finalizer, true);

    const accepted = await finalizer.endSession({
      principal,
      endedOffsetMs: 100,
      finalizedAtMs: 9_000,
      preparedEvidence,
    });
    expect((await accepted.finalization).outcome).toBe("FAILED");
    expect(repository.state?.finalizedAtMs).toBeNull();

    const response = await route(reportGet(), principal.ownerSubject);

    expect(response?.status).toBe(200);
    const body = (await response?.json()) as { report: SessionReport };
    expect(body.report.finalizedAtMs).toBe(9_000);
    // One pending CAS plus exactly one recovered finalizing CAS.
    expect(repository.state?.revision).toBe(2);
  });

  test("a read that meets an in-flight finalization joins it instead of starting a second end", async () => {
    const repository = new MemoryReportRepository();
    const gate = deferred();
    repository.finalizedCasGate = gate.promise;
    let casCalls = 0;
    const originalCas = repository.compareAndSetState.bind(repository);
    repository.compareAndSetState = async (input) => {
      casCalls += 1;
      return await originalCas(input);
    };
    const finalizer = new SessionReportFinalizer(repository);
    const route = recoveringRoute(finalizer, true);

    const endResponse = await route(endPost(), principal.ownerSubject);
    expect(endResponse?.status).toBe(202);

    const readPromise = route(reportGet(), principal.ownerSubject);
    gate.resolve();
    const read = await readPromise;

    expect(read?.status).toBe(200);
    // The pending-row CAS and the single finalizing CAS; the read joined the same lane.
    expect(casCalls).toBe(2);
  });

  test("a read on a live session stays pending and never drives finalization", async () => {
    const repository = new MemoryReportRepository();
    const route = recoveringRoute(new SessionReportFinalizer(repository), false);

    const response = await route(reportGet(), principal.ownerSubject);

    expect(response?.status).toBe(202);
    expect(await response?.json()).toEqual({ status: "pending" });
    expect(repository.state).toBeNull();
  });

  test("a route wired without a recovery resolver keeps answering pending", async () => {
    const repository = new MemoryReportRepository();
    const route = recoveringRoute(new SessionReportFinalizer(repository), true, false);

    const response = await route(reportGet(), principal.ownerSubject);

    expect(response?.status).toBe(202);
    expect(await response?.json()).toEqual({ status: "pending" });
    expect(repository.state).toBeNull();
  });
});
