import { describe, expect, test } from "bun:test";
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

class MemoryReportRepository implements SessionReportRepository {
  readonly visits: SlideVisit[] = [];
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
    };
    return structuredClone(this.state);
  }

  async readSlideVisits() {
    return structuredClone(this.visits);
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
});
