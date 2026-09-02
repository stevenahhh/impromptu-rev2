import type { QaExchangeAppendResult } from "../qa/qa-exchange-ledger.ts";
import {
  applyFinalTranscript,
  derivedSpeechSummary,
  emptyAggregate,
  type FinalTranscriptAggregateInput,
  type MutableDerivedAggregate,
  nonNegativeInteger,
  parseStoredAggregate,
  storedAggregate,
} from "./final-transcript-aggregate.ts";
import type {
  SessionReportPrincipal,
  SessionReportRepository,
  SessionReportState,
} from "./postgres-session-report-repository.ts";
import { SerializedQaExchangeRecorder } from "./serialized-qa-recorder.ts";
import { SessionReportFinalizedError } from "./session-report-access-errors.ts";
import {
  clonePreparedEvidence,
  type PreparedEvidenceReportSnapshot,
  reportFrom,
  type SessionReport,
} from "./session-report-dto.ts";
import { samePrincipal, sessionKey, type VisitTracker } from "./session-write-trackers.ts";

export * from "./final-transcript-aggregate.ts";
export * from "./prepared-evidence-report-observer.ts";
export * from "./serialized-qa-recorder.ts";
export * from "./session-report-dto.ts";
export * from "./session-write-trackers.ts";

import type {
  RecordQaExchangeDraft,
  ReportFinalizationResult,
  SessionEndAccepted,
} from "./session-report-dto.ts";

/**
 * Keeps only derived FINAL metrics in memory. Slide writes are serialized but are not awaited by
 * the live slide-set path; report materialization starts only after session end.
 */
export class SessionReportFinalizer {
  readonly #aggregates = new Map<string, MutableDerivedAggregate>();
  readonly #visits = new Map<string, VisitTracker>();
  readonly #ends = new Map<string, Promise<ReportFinalizationResult>>();
  readonly #qaRecorder: SerializedQaExchangeRecorder;

  constructor(private readonly reports: SessionReportRepository) {
    this.#qaRecorder = new SerializedQaExchangeRecorder((input) =>
      this.reports.appendQaExchange(input),
    );
  }

  recordFinal(principal: SessionReportPrincipal, input: FinalTranscriptAggregateInput): void {
    const key = sessionKey(principal);
    const aggregate = this.#aggregates.get(key) ?? emptyAggregate();
    applyFinalTranscript(aggregate, input);
    this.#aggregates.set(key, aggregate);
    // input and its transcript text are deliberately not retained beyond this synchronous method.
  }

  recordAcceptedSlideSet(input: {
    readonly principal: SessionReportPrincipal;
    readonly presentationSessionEpoch: number;
    readonly sequence: number;
    readonly publicSlideKey: string;
    readonly acceptedOffsetMs: number;
    readonly producerId: string;
  }): void {
    nonNegativeInteger(input.acceptedOffsetMs, "acceptedOffsetMs");
    const key = sessionKey(input.principal);
    const tracker = this.#visits.get(key) ?? {
      active: null,
      writes: Promise.resolve(),
      failure: null,
    };
    const previous = tracker.active;
    if (previous !== null) {
      if (!samePrincipal(previous.principal, input.principal)) {
        throw new Error("slide visit principal changed within a session");
      }
      tracker.writes = tracker.writes.then(async () => {
        if (tracker.failure !== null) return;
        try {
          await this.reports.appendSlideVisit({
            ...previous.principal,
            presentationSessionEpoch: previous.presentationSessionEpoch,
            seq: previous.sequence,
            publicSlideKey: previous.publicSlideKey,
            enteredOffsetMs: previous.enteredOffsetMs,
            leftOffsetMs: input.acceptedOffsetMs,
            producerId: previous.producerId,
          });
        } catch (error) {
          tracker.failure = error;
        }
      });
    }
    tracker.active = {
      principal: input.principal,
      presentationSessionEpoch: input.presentationSessionEpoch,
      sequence: input.sequence,
      publicSlideKey: input.publicSlideKey,
      enteredOffsetMs: input.acceptedOffsetMs,
      producerId: input.producerId,
    };
    this.#visits.set(key, tracker);
  }

  /**
   * Serializes one persisted Q&A exchange per session behind the same chained-write discipline as
   * slide visits. Appends are owner-checked and idempotent; they remain valid after report
   * finalization because exchanges live in their own durable record, not in the report's CAS row.
   */
  async recordQaExchange(
    principal: SessionReportPrincipal,
    draft: RecordQaExchangeDraft,
  ): Promise<QaExchangeAppendResult> {
    return await this.#qaRecorder.record(principal, draft);
  }

  async endSession(input: {
    readonly principal: SessionReportPrincipal;
    readonly endedOffsetMs: number;
    readonly finalizedAtMs: number;
    readonly preparedEvidence: PreparedEvidenceReportSnapshot;
  }): Promise<SessionEndAccepted> {
    nonNegativeInteger(input.endedOffsetMs, "endedOffsetMs");
    nonNegativeInteger(input.finalizedAtMs, "finalizedAtMs");
    const key = sessionKey(input.principal);
    const existingEnd = this.#ends.get(key);
    if (existingEnd !== undefined) return { status: "accepted", finalization: existingEnd };

    const tracker = this.#visits.get(key);
    if (tracker !== undefined) {
      await tracker.writes;
      if (tracker.failure !== null) throw tracker.failure;
      if (tracker.active !== null) {
        await this.reports.appendSlideVisit({
          ...tracker.active.principal,
          presentationSessionEpoch: tracker.active.presentationSessionEpoch,
          seq: tracker.active.sequence,
          publicSlideKey: tracker.active.publicSlideKey,
          enteredOffsetMs: tracker.active.enteredOffsetMs,
          leftOffsetMs: input.endedOffsetMs,
          producerId: tracker.active.producerId,
        });
      }
    }
    // In-flight answers drain before the finalizing CAS so every exchange asked during the talk
    // is persisted while its report revision is still moving; anything racing afterwards lands
    // in the exchange log's own table as well.
    await this.#qaRecorder.drain(input.principal);

    const aggregate = this.#aggregates.get(key) ?? emptyAggregate();
    const current = await this.reports.readForOwner(input.principal);
    if (current?.finalizedAtMs !== null && current !== null) {
      const result = this.readFinalizedReport(input.principal, input.preparedEvidence).then(
        (report) =>
          report === null
            ? { outcome: "FAILED" as const, error: new Error("finalized report is unavailable") }
            : { outcome: "FINALIZED" as const, report },
      );
      this.#ends.set(key, result);
      return { status: "accepted", finalization: result };
    }

    const summary = derivedSpeechSummary(aggregate.finalCount, aggregate.wordCount);
    const saved =
      current ??
      (await this.reports.compareAndSetState({
        ...input.principal,
        expectedRevision: 0,
        speechSummary: summary,
        wordCount: aggregate.wordCount,
        speakingDurationMs: aggregate.speakingDurationMs,
        coachingAggregate: storedAggregate(aggregate),
        finalizedAtMs: null,
      }));
    const evidence = clonePreparedEvidence(input.preparedEvidence);
    const finalization = Promise.resolve().then(async (): Promise<ReportFinalizationResult> => {
      try {
        let finalized: SessionReportState;
        try {
          finalized = await this.reports.compareAndSetState({
            ...input.principal,
            expectedRevision: saved.revision,
            speechSummary: saved.speechSummary,
            wordCount: saved.wordCount,
            speakingDurationMs: saved.speakingDurationMs,
            coachingAggregate: parseStoredAggregate(saved.coachingAggregate),
            finalizedAtMs: input.finalizedAtMs,
          });
        } catch (error) {
          if (!(error instanceof SessionReportFinalizedError)) throw error;
          const alreadyFinalized = await this.reports.readForOwner(input.principal);
          if (alreadyFinalized?.finalizedAtMs === null || alreadyFinalized === null) throw error;
          finalized = alreadyFinalized;
        }
        const report = await this.materializeReport(input.principal, finalized, evidence);
        return { outcome: "FINALIZED", report };
      } catch (error) {
        return {
          outcome: "FAILED",
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    });
    this.#ends.set(key, finalization);
    void finalization.then((result) => {
      if (result.outcome === "FAILED" && this.#ends.get(key) === finalization) {
        this.#ends.delete(key);
      }
    });
    return { status: "accepted", finalization };
  }

  async readFinalizedReport(
    principal: SessionReportPrincipal,
    preparedEvidence: PreparedEvidenceReportSnapshot,
  ): Promise<SessionReport | null> {
    const state = await this.reports.readForOwner(principal);
    if (state?.finalizedAtMs === null || state === null) return null;
    return await this.materializeReport(principal, state, preparedEvidence);
  }

  private async materializeReport(
    principal: SessionReportPrincipal,
    state: SessionReportState,
    preparedEvidence: PreparedEvidenceReportSnapshot,
  ): Promise<SessionReport> {
    const visits = await this.reports.readSlideVisits(principal);
    // A persisted v1 report predates the section entirely and must not grow one on read.
    const exchanges = state.reportVersion >= 2 ? await this.reports.readQaExchanges(principal) : [];
    return reportFrom(principal, state, visits, preparedEvidence, exchanges);
  }
}
