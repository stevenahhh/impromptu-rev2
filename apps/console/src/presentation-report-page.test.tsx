import { GlobalRegistrator } from "@happy-dom/global-registrator";

const { cleanup, render, act } = await import("@testing-library/react");
const { test, expect, afterEach, afterAll } = await import("bun:test");

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());
const { createElement } = await import("react");
const { MemoryRouter, Route, Routes } = await import("react-router-dom");

import { AuthProvider } from "./App";
import { PresentationReportPage } from "./report-page";
import type { ConsoleSessionClient, SessionReportView } from "./session-client";

afterEach(cleanup);

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

const hostReport: SessionReportView = {
  reportVersion: 2,
  presentationSessionId: "ps_host",
  ownerAccountId: "account_owner",
  finalizedAtMs: 10_000,
  totalDurationMs: 1_000,
  slideVisits: [visitWith(hexKey("a"), 1), visitWith(hexKey("b"), 2)],
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
};

function reportClient(finalized: SessionReportView): ConsoleSessionClient {
  return {
    async signUp() {
      throw new Error("not used");
    },
    async signIn() {
      throw new Error("not used");
    },
    async readSession() {
      return null;
    },
    async signOut() {},
    async createPresentation() {
      throw new Error("not used");
    },
    async recommend() {
      throw new Error("not used");
    },
    async readLiveCandidates() {
      throw new Error("not used");
    },
    async approveLiveCandidate() {
      throw new Error("not used");
    },
    async readFinalizedReport() {
      return { status: "FINALIZED", report: finalized };
    },
  };
}

async function renderReportPage(
  finalized: SessionReportView,
  slides?: readonly { publicSlideKey: string; ordinal: number; accessibilityLabel: string }[],
): Promise<void> {
  const client = reportClient(finalized);
  const routes = createElement(
    Routes,
    null,
    createElement(Route, {
      path: "/reports/:presentationSessionId",
      element: createElement(PresentationReportPage),
    }),
  );
  await act(async () => {
    render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/reports/ps_host"] },
        slides === undefined
          ? createElement(AuthProvider, { initialAuthenticated: true, client, children: routes })
          : createElement(AuthProvider, {
              initialAuthenticated: true,
              client,
              initialPresentation: {
                presentationSessionId: "ps_host",
                presentationSessionEpoch: "pse_1",
                deckVersion: "deck_1",
                slides,
              },
              children: routes,
            }),
      ),
    );
  });
  await act(async () => {});
}

test("the report host resolves labels from the in-session deck", async () => {
  await renderReportPage(hostReport, deckSlides);
  const titles = [...document.querySelectorAll("[data-report-slide-title]")];
  expect(titles.map((title) => title.textContent)).toEqual(["Results slide", "슬라이드 3"]);
  const article = document.querySelector("[data-presentation-report='ready']");
  expect(article?.textContent).not.toMatch(/slide_[0-9a-f]{8}/i);
});

test("the report host falls back to ko ordinals when no deck is in session", async () => {
  await renderReportPage(hostReport);
  const titles = [...document.querySelectorAll("[data-report-slide-title]")];
  expect(titles.map((title) => title.textContent)).toEqual(["슬라이드 1", "슬라이드 2"]);
  const article = document.querySelector("[data-presentation-report='ready']");
  expect(article?.textContent).not.toMatch(/slide_[0-9a-f]{8}/i);
});
