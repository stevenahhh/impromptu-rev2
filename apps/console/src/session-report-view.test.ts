import { describe, expect, test } from "bun:test";
import type { SessionReportView } from "./session-report-view";
import { sessionReport } from "./session-report-view";

const baseReport = {
  reportVersion: 1,
  presentationSessionId: "ps_report",
  ownerAccountId: "account_owner",
  finalizedAtMs: 10_000,
  totalDurationMs: 1_000,
  slideVisits: [
    {
      sequence: 1,
      publicSlideKey: "A",
      occurrenceSequence: 1,
      enteredOffsetMs: 0,
      leftOffsetMs: 300,
      dwellMs: 300,
      revisit: false,
    },
  ],
  speech: {
    derivedSummary: "요약",
    wordCount: 2,
    speakingDurationMs: 400,
    timingAggregate: { finalCount: 1, measuredFinalCount: 1 },
    coachingAggregate: {
      cueCount: 1,
      latestCurrentWordsPerMinute: 120,
      latestPreviousWordsPerMinute: null,
    },
  },
  preparedEvidence: {
    label: "준비된 근거",
    items: [],
  },
} satisfies SessionReportView;

const answeredExchange = {
  exchangeId: "qa-1",
  askedAtMs: 5_000,
  question: "올해 매출 목표가 있나요?",
  origin: "TYPED",
  defense: {
    outcome: "ANSWERED",
    answerText: "목표 매출은 100억입니다.",
    citations: [
      { kind: "DECK_SLIDE", slideOrdinal: 2 },
      { kind: "REFERENCE_DOCUMENT", documentTitle: "실적 보고서", chunkOrdinal: 3 },
      { kind: "EXTERNAL_SOURCE", url: "https://example.test/source" },
    ],
  },
};

const abstainedExchange = {
  exchangeId: "qa-2",
  askedAtMs: 6_000,
  question: "내년 인사 계획은요?",
  origin: "SPOKEN",
  defense: {
    outcome: "ABSTAINED",
    abstainReason: "근거를 찾지 못했습니다.",
    retryable: true,
  },
};

function reportVersion2(exchanges: unknown): Record<string, unknown> {
  return { ...baseReport, reportVersion: 2, qaDefense: { label: "질의응답", exchanges } };
}

describe("sessionReport", () => {
  test("keeps parsing a persisted version-1 report without a qaDefense section", () => {
    expect(sessionReport(baseReport)).toEqual(baseReport);
  });

  test("parses a version-2 report whose qaDefense section carries exchanges", () => {
    const parsed = sessionReport(reportVersion2([answeredExchange, abstainedExchange]));
    expect(parsed).not.toBeNull();
    expect(parsed?.reportVersion).toBe(2);
    expect(parsed?.qaDefense?.status).toBe("READY");
    if (parsed?.qaDefense?.status !== "READY") return;
    expect(parsed.qaDefense.label).toBe("질의응답");
    expect(parsed.qaDefense.exchanges).toEqual([
      {
        exchangeId: "qa-1",
        askedAtMs: 5_000,
        question: "올해 매출 목표가 있나요?",
        origin: "TYPED",
        defense: {
          outcome: "ANSWERED",
          answerText: "목표 매출은 100억입니다.",
          citations: [
            { kind: "DECK_SLIDE", slideOrdinal: 2 },
            { kind: "REFERENCE_DOCUMENT", documentTitle: "실적 보고서", chunkOrdinal: 3 },
            { kind: "EXTERNAL_SOURCE", url: "https://example.test/source" },
          ],
        },
      },
      {
        exchangeId: "qa-2",
        askedAtMs: 6_000,
        question: "내년 인사 계획은요?",
        origin: "SPOKEN",
        defense: {
          outcome: "ABSTAINED",
          abstainReason: "근거를 찾지 못했습니다.",
          retryable: true,
        },
      },
    ]);
  });

  test("rejects an external citation url that is not a plain https url", () => {
    const parsed = sessionReport(
      reportVersion2([
        {
          ...answeredExchange,
          defense: {
            outcome: "ANSWERED",
            answerText: "답변",
            citations: [{ kind: "EXTERNAL_SOURCE", url: "javascript:alert(1)" }],
          },
        },
      ]),
    );
    expect(parsed?.qaDefense?.status).toBe("UNREADABLE");
  });

  test("degrades only the qaDefense section when it is malformed; the rest of the report stays valid", () => {
    for (const malformed of [
      null,
      42,
      {},
      { label: "질의응답", exchanges: [{ ...answeredExchange, exchangeId: "" }] },
      {
        label: "질의응답",
        exchanges: [
          answeredExchange,
          { ...abstainedExchange, defense: { ...abstainedExchange.defense, retryable: "yes" } },
        ],
      },
      { label: "다른 라벨", exchanges: [] },
      { label: "질의응답", exchanges: "two" },
    ]) {
      const parsed = sessionReport({ ...baseReport, reportVersion: 2, qaDefense: malformed });
      expect(parsed).not.toBeNull();
      expect(parsed?.reportVersion).toBe(2);
      expect(parsed?.slideVisits).toHaveLength(1);
      expect(parsed?.speech.wordCount).toBe(2);
      expect(parsed?.preparedEvidence.label).toBe("준비된 근거");
      expect(parsed?.qaDefense?.status).toBe("UNREADABLE");
    }
  });

  test("version-1 reports that illegally carry an unreadable qaDefense degrade it, not the report", () => {
    const parsed = sessionReport({ ...baseReport, qaDefense: { label: "질의응답" } });
    expect(parsed).not.toBeNull();
    expect(parsed?.qaDefense?.status).toBe("UNREADABLE");
  });
});
