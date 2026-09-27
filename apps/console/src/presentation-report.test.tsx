import { GlobalRegistrator } from "@happy-dom/global-registrator";

const { cleanup, render } = await import("@testing-library/react");
const { test, expect, afterEach, afterAll } = await import("bun:test");

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());
const { createElement } = await import("react");

import { messages } from "./i18n";
import en from "./locales/en.json";
import ko from "./locales/ko.json";
import { PresentationReport } from "./presentation-report";
import { presentationReportText } from "./presentation-report-text";
import type { SessionReportView } from "./session-report-view";

const hexKey = (seed: string) => `slide_${seed.repeat(64).slice(0, 64)}`;
const deckSlides = [
  { publicSlideKey: hexKey("a"), ordinal: 2, accessibilityLabel: "Results slide" },
  { publicSlideKey: hexKey("b"), ordinal: 3, accessibilityLabel: "" },
];

function visitWith(publicSlideKey: string, sequence = 1) {
  return {
    sequence,
    publicSlideKey,
    occurrenceSequence: 1,
    enteredOffsetMs: 0,
    leftOffsetMs: 300,
    dwellMs: 300,
    revisit: false,
  };
}

const slideIndex = new Map(
  deckSlides.map((slide) => [
    slide.publicSlideKey,
    { ordinal: slide.ordinal, label: slide.accessibilityLabel },
  ]),
);

const reportText = presentationReportText(messages("en"));

afterEach(cleanup);

const report: SessionReportView = {
  reportVersion: 2,
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
  preparedEvidence: { label: "준비된 근거", items: [] },
  qaDefense: {
    status: "READY",
    label: "질의응답",
    exchanges: [
      {
        exchangeId: "qa-1",
        askedAtMs: 5_000,
        question: "올해 매출 목표가 있나요?",
        origin: "TYPED",
        defense: {
          outcome: "ANSWERED",
          answerText: "목표 매출은 100억입니다.",
          citations: [{ kind: "DECK_SLIDE", slideOrdinal: 2 }],
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
    ],
  },
};

function renderReport(
  nextReport: SessionReportView,
  slides?: ReadonlyMap<string, { ordinal: number; label: string }>,
): void {
  render(createElement(PresentationReport, { report: nextReport, text: reportText, slides }));
}

test("ko and en locale key sets stay equal", () => {
  expect(Object.keys(en).sort()).toEqual(Object.keys(ko).sort());
});

test("renders a version-1 report exactly as before without any Q&A markup", () => {
  // A v1 report carries no qaDefense section at all.
  const withoutQa = { ...report };
  delete (withoutQa as Record<string, unknown>).qaDefense;
  render(
    createElement(PresentationReport, { report: withoutQa as SessionReportView, text: reportText }),
  );
  expect(document.querySelector("[data-report-qa-defense]")).toBeNull();
  expect(document.querySelector("[data-presentation-report='ready']")).toBeTruthy();
});

test("renders the Q&A exchanges with answers, citations and honest abstentions", () => {
  renderReport(report);
  const panel = document.querySelector("[data-report-qa-defense='READY']");
  expect(panel).toBeTruthy();
  const exchanges = document.querySelectorAll("[data-report-qa-exchange]");
  expect(exchanges).toHaveLength(2);

  const answered = document.querySelector("[data-report-qa-answer='ANSWERED']");
  expect(answered?.textContent).toContain("목표 매출은 100억입니다.");
  const citation = document.querySelector("[data-report-qa-citation='DECK_SLIDE']");
  expect(citation?.textContent).toContain("2");
  const external = document.querySelectorAll("[data-report-qa-citation]");
  expect(external.length).toBeGreaterThan(0);

  const abstained = document.querySelector("[data-report-qa-abstained='RETRYABLE']");
  expect(abstained?.textContent).toContain("근거를 찾지 못했습니다.");
  expect(abstained?.textContent).not.toContain("목표 매출은 100억입니다.");
  expect(
    document.querySelector("[data-report-qa-abstained] [data-report-qa-answer-text]"),
  ).toBeNull();
});

test("renders the deck slide label, never the raw key, for a matched visit", () => {
  const keyed: SessionReportView = {
    ...report,
    slideVisits: [visitWith(hexKey("a"))],
  };
  renderReport(keyed, slideIndex);
  const title = document.querySelector("[data-report-slide-title]");
  expect(title?.textContent).toBe("Results slide");
});

test("leaks no slide key anywhere in the rendered report text", () => {
  const keyed: SessionReportView = {
    ...report,
    slideVisits: [visitWith(hexKey("a"), 1), visitWith(hexKey("b"), 2)],
  };
  renderReport(keyed, slideIndex);
  const article = document.querySelector("[data-presentation-report='ready']");
  expect(article?.textContent).toBeTruthy();
  expect(article?.textContent).not.toMatch(/slide_[0-9a-f]{8}/i);
  for (const slide of deckSlides) {
    expect(article?.textContent).not.toContain(slide.publicSlideKey);
  }
});

test("uses the deck ordinal when a matched slide label is empty", () => {
  const keyed: SessionReportView = {
    ...report,
    slideVisits: [visitWith(hexKey("b"))],
  };
  renderReport(keyed, slideIndex);
  expect(document.querySelector("[data-report-slide-title]")?.textContent).toBe("Slide 3");
});

test("falls back to a human ordinal from visit order when no deck is available", () => {
  const keyed: SessionReportView = {
    ...report,
    slideVisits: [visitWith(hexKey("a"))],
  };
  renderReport(keyed);
  const title = document.querySelector("[data-report-slide-title]");
  expect(title?.textContent).toBe("Slide 1");
  expect(title?.textContent).not.toContain(hexKey("a"));
});

test("degrades only the Q&A section when it is unreadable; the rest of the report survives", () => {
  renderReport({
    ...report,
    qaDefense: { status: "UNREADABLE" },
  });
  expect(document.querySelector("[data-report-qa-defense='UNREADABLE']")).toBeTruthy();
  expect(document.querySelector("[data-presentation-report='ready']")).toBeTruthy();
  expect(document.querySelector("[data-report-slide-visit]")).toBeTruthy();
  expect(document.querySelector("[data-report-speech-summary]")).toBeTruthy();
});
