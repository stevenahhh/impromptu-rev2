import type { Sql } from "postgres";

import type {
  AppendQaExchangeInput,
  QaExchangeAppendResult,
  QaExchangeItem,
} from "../qa/qa-exchange-ledger.ts";

export * from "./session-report-access-errors.ts";
export * from "./session-report-table-codecs.ts";

import { createQaExchangeStore } from "./qa-exchange-store.ts";
import { createDerivedSessionReportStateStore } from "./session-report-cas-store.ts";
import type { ReportAggregateValue } from "./session-report-table-codecs.ts";
import { createSlideVisitStore } from "./slide-visit-store.ts";

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
  /** Contract generation stamped by v2 code when a report finalizes; existing rows carry 1. */
  reportVersion: number;
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

export interface SessionReportRepository {
  appendSlideVisit(
    input: AppendSlideVisitInput,
  ): Promise<
    | Readonly<{ outcome: "APPENDED"; visit: SlideVisit }>
    | Readonly<{ outcome: "DUPLICATE"; visit: SlideVisit }>
  >;
  compareAndSetState(input: CompareAndSetSessionReportStateInput): Promise<SessionReportState>;
  readSlideVisits(principal: SessionReportPrincipal): Promise<readonly SlideVisit[]>;
  appendQaExchange(input: AppendQaExchangeInput): Promise<QaExchangeAppendResult>;
  readQaExchanges(principal: SessionReportPrincipal): Promise<readonly QaExchangeItem[]>;
  readForOwner(principal: SessionReportPrincipal): Promise<SessionReportState | null>;
}

/** PostgreSQL repository for ordered slide visits, CAS report state and Q&A defense exchanges. */
export function createPostgresSessionReportRepository(sql: Sql): SessionReportRepository {
  return {
    ...createSlideVisitStore(sql),
    ...createDerivedSessionReportStateStore(sql),
    ...createQaExchangeStore(sql),
  };
}
