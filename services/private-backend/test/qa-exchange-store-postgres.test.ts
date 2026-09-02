import { afterAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import type { QaExchangeItem } from "../src/qa/qa-exchange-ledger.ts";
import {
  createPostgresSessionReportRepository,
  SessionReportAccessDeniedError,
  SessionReportStateConflictError,
} from "../src/report/postgres-session-report-repository.ts";
import { createProvisionedSessionReportRepository } from "../src/report/provisioned-session-report-repository.ts";
import { SessionReportFinalizer } from "../src/report/session-report-finalizer.ts";

/**
 * Store-level regression tests for the post-talk Q&A rule, run against the real PostgreSQL
 * schema (uniqueness, owner checks, RLS): ending the talk finalizes the session report, and the
 * exchange log — its own durable record in private_app.qa_exchanges — must keep accepting
 * owner-checked writes afterwards. Uses PRIVATE_DATABASE_URL when set (CI), falling back to the
 * local dev database URL scripts/dev-services.ts provisions.
 */
const privateDatabaseUrl =
  Bun.env.PRIVATE_DATABASE_URL ?? "postgresql://private_app@127.0.0.1:5432/impromptu_private";
const sql = postgres(privateDatabaseUrl, { max: 4 });
const reports = createProvisionedSessionReportRepository(
  sql,
  createPostgresSessionReportRepository(sql),
);
const evidence = { label: "준비된 근거" as const, items: [] };

afterAll(async () => {
  await sql.end({ timeout: 0 });
});

const tenantId = "account_postgres_exchange";
const finalizedAtMs = 1_760_000_000_000;

function freshPrincipal(ownerSubject = "account_postgres_owner") {
  const hex = crypto.randomUUID().replaceAll("-", "");
  return {
    tenantId,
    presentationSessionId: `ps_${hex}`,
    ownerSubject,
    presentationSessionEpoch: 1,
  };
}

function finalizeInput(principal: ReturnType<typeof freshPrincipal>) {
  return {
    ...principal,
    expectedRevision: 0,
    speechSummary: "Post-talk derived summary only",
    wordCount: 5,
    speakingDurationMs: 800,
    coachingAggregate: {
      timing: { finalCount: 1, measuredFinalCount: 1 },
      coaching: {
        cueCount: 0,
        latestCurrentWordsPerMinute: null,
        latestPreviousWordsPerMinute: null,
      },
    },
    finalizedAtMs,
  };
}

function exchangeDraft(exchangeId: string): QaExchangeItem {
  return {
    exchangeId,
    askedAtMs: finalizedAtMs + 60_000,
    question: "발표 종료 후의 첫 질문",
    origin: "TYPED",
    defense: {
      outcome: "ANSWERED",
      answerText: "종료 후에도 슬라이드 근거로 답변했습니다",
      citations: [{ kind: "DECK_SLIDE", slideOrdinal: 3 }],
    },
  };
}

/** Everything a finalized report owns EXCEPT the additive qaDefense section. */
function talkView(
  report: NonNullable<Awaited<ReturnType<SessionReportFinalizer["readFinalizedReport"]>>>,
) {
  const { qaDefense: _section, ...talk } = report;
  return talk;
}

describe("qa exchanges outlive report finalization (private_app.qa_exchanges)", () => {
  test("an exchange appended AFTER finalization is recorded exactly once and appears when the report is read, with finalized talk data untouched", async () => {
    const principal = freshPrincipal();
    const state = await reports.compareAndSetState(finalizeInput(principal));
    expect(state.reportVersion).toBe(2);

    const finalizer = new SessionReportFinalizer(reports);
    const before = await finalizer.readFinalizedReport(principal, evidence);
    expect(before).not.toBeNull();
    if (before === null) throw new Error("finalized report missing before the append");
    const beforeTalk = JSON.stringify(talkView(before));

    const appended = await finalizer.recordQaExchange(principal, exchangeDraft("qa-after-end-1"));
    // This is the exact call that answered REJECTED REPORT_FINALIZED while the feature was dead.
    expect(appended.outcome).toBe("APPENDED");
    const retried = await finalizer.recordQaExchange(principal, exchangeDraft("qa-after-end-1"));
    expect(retried.outcome).toBe("DUPLICATE");
    expect(retried.exchange.exchangeId).toBe(appended.exchange.exchangeId);

    const after = await finalizer.readFinalizedReport(principal, evidence);
    if (after === null) throw new Error("finalized report missing after the append");
    expect(after.reportVersion).toBe(2);
    expect(after.finalizedAtMs).toBe(finalizedAtMs);
    expect(after.qaDefense?.label).toBe("질의응답");
    expect(after.qaDefense?.exchanges.map((exchange) => exchange.exchangeId)).toEqual([
      "qa-after-end-1",
    ]);
    expect(after.qaDefense?.exchanges[0]?.defense).toEqual(exchangeDraft("qa-after-end-1").defense);

    // The finalized row held: identical talk data plus exactly one additive section.
    expect(JSON.stringify(talkView(after))).toBe(beforeTalk);
  });

  test("the same exchange id written twice lands one row, and a reused id with different content stays a typed conflict", async () => {
    const principal = freshPrincipal();
    await reports.compareAndSetState(finalizeInput(principal));

    const first = await reports.appendQaExchange({
      ...principal,
      ...exchangeDraft("qa-idempotent-1"),
    });
    const retried = await reports.appendQaExchange({
      ...principal,
      ...exchangeDraft("qa-idempotent-1"),
    });

    expect(first.outcome).toBe("APPENDED");
    expect(retried.outcome).toBe("DUPLICATE");
    expect(retried.exchange.exchangeId).toBe(first.exchange?.exchangeId);
    expect((await reports.readQaExchanges(principal)).length).toBe(1);

    const conflicted = reports.appendQaExchange({
      ...principal,
      ...exchangeDraft("qa-idempotent-1"),
      origin: "SPOKEN",
    });
    expect(conflicted).rejects.toBeInstanceOf(SessionReportStateConflictError);
    await conflicted.catch(() => undefined);
    expect((await reports.readQaExchanges(principal)).length).toBe(1);
  });

  test("exchanges read back in ask (insertion) order even when askedAtMs is out of order", async () => {
    const principal = freshPrincipal();
    await reports.compareAndSetState(finalizeInput(principal));

    const baseMs = finalizedAtMs + 120_000;
    const order = ["qa-order-1", "qa-order-2", "qa-order-3"];
    // Appended in ask order with deliberately descending timestamps: the ledger's ask_seq, not
    // the wall clock, defines read order.
    for (const [index, exchangeId] of order.entries()) {
      await reports.appendQaExchange({
        ...principal,
        ...exchangeDraft(exchangeId),
        askedAtMs: baseMs - index * 1_000,
      });
    }

    expect(
      (await reports.readQaExchanges(principal)).map((exchange) => exchange.exchangeId),
    ).toEqual(order);
  });

  test("a same-tenant non-owner still cannot append to another session's exchange log", async () => {
    const principal = freshPrincipal();

    const ownerAppend = await reports.appendQaExchange({
      ...principal,
      ...exchangeDraft("qa-owner-only"),
    });
    expect(ownerAppend.outcome).toBe("APPENDED");

    const observerAttempt = reports.appendQaExchange({
      ...freshPrincipal("account_postgres_observer"),
      presentationSessionId: principal.presentationSessionId,
      ...exchangeDraft("qa-owner-only-too"),
    });
    expect(observerAttempt).rejects.toBeInstanceOf(SessionReportAccessDeniedError);
    await observerAttempt.catch(() => undefined);
    expect((await reports.readQaExchanges(principal)).length).toBe(1);
  });
});
