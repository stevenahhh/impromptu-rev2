import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerDom } from "@impromptu/test-harness";

registerDom();

// Testing Library only registers the act environment under the suite that imports it
// first, so files sharing the happy-dom global must assert it for themselves and
// restore whatever the surrounding suite had (pattern proven in
// cockpit-audio-capture.test.tsx; without it these suites fail non-deterministically
// depending on file order).
let previousActEnvironment: boolean | undefined;
beforeEach(() => {
  previousActEnvironment = (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT as
    | boolean
    | undefined;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

const { act, cleanup, fireEvent, render, within } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");

const { AuthProvider } = await import("./auth-session");
const { ConsoleRoutes } = await import("./App");
const { messages } = await import("./i18n");
const { QaDefensePanel } = await import("./qa-defense-panel");

import type { ConsoleDeckUploadClient, QaDefenseAnswer, SessionReportView } from "./session-client";

afterEach(cleanup);

const ko = messages("ko");

function client(overrides: Partial<ConsoleDeckUploadClient> = {}): ConsoleDeckUploadClient {
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
    async approveDisplay() {
      throw new Error("not used");
    },
    async setSlide() {
      throw new Error("not used");
    },
    async uploadDeck() {
      throw new Error("not used");
    },
    ...overrides,
  };
}

const endedLifecycle = {
  presentationSessionId: "ps_done",
  presentationSessionEpoch: "pse_1",
  deckVersion: "deck_done",
  status: "ENDED",
  qaWindow: { status: "LIVE", askableUntilMs: Date.now() + 300_000 },
} as const;

const endedReport: SessionReportView = {
  reportVersion: 1,
  presentationSessionId: "ps_done",
  ownerAccountId: "account_preview",
  finalizedAtMs: 10_000,
  totalDurationMs: 600,
  slideVisits: [
    {
      sequence: 1,
      publicSlideKey: "A",
      occurrenceSequence: 1,
      enteredOffsetMs: 0,
      leftOffsetMs: 600,
      dwellMs: 600,
      revisit: false,
    },
  ],
  speech: {
    derivedSummary: "집계된 발화 없음",
    wordCount: 0,
    speakingDurationMs: 0,
    timingAggregate: { finalCount: 0, measuredFinalCount: 0 },
    coachingAggregate: {
      cueCount: 0,
      latestCurrentWordsPerMinute: null,
      latestPreviousWordsPerMinute: null,
    },
  },
  preparedEvidence: {
    label: "준비된 근거",
    items: [],
  },
};

const activePresentation = {
  presentationSessionId: "ps_active",
  presentationSessionEpoch: "pse_1",
  deckVersion: "deck_active",
  slides: [{ publicSlideKey: "slide_one", ordinal: 1, accessibilityLabel: "Opening slide" }],
} as const;

interface CapturedAsk {
  readonly csrfToken: string;
  readonly request: {
    readonly presentationSessionId: string;
    readonly questionText: string;
    readonly origin: "TYPED" | "SPOKEN";
  };
}

describe("Q&A defense panel", () => {
  test("leads a finished presenter into Q&A from the report and never offers it mid-talk", async () => {
    const openedSessions: string[] = [];
    const authProvider = (entry: string) => (
      <MemoryRouter initialEntries={[entry]}>
        <AuthProvider
          initialAuthenticated
          {...(entry === "/"
            ? {
                initialPresentation: {
                  presentationSessionId: activePresentation.presentationSessionId,
                  presentationSessionEpoch: activePresentation.presentationSessionEpoch,
                  deckVersion: activePresentation.deckVersion,
                  slides: [...activePresentation.slides],
                },
              }
            : {})}
          client={client({
            async readFinalizedReport() {
              return { status: "FINALIZED", report: endedReport };
            },
            async openQaDefense(_csrfToken, sessionId) {
              openedSessions.push(sessionId);
              return endedLifecycle;
            },
            submitQaDefenseQuestion() {
              return new Promise<QaDefenseAnswer>(() => {});
            },
          })}
        >
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>
    );

    // Before the talk ends the workspace offers no Q&A surface at all.
    render(authProvider("/"));
    expect(document.querySelector(".console-qa")).toBeNull();
    expect(within(document.body).queryByRole("button", { name: ko.qaOpen })).toBeNull();
    cleanup();

    // After the end lands the presenter straight on the report, so the entry lives there and
    // one click opens the Q&A session bound to the report's own presentation session.
    render(authProvider("/reports/ps_done"));
    await act(async () => {});
    const entry = within(document.body).getByRole("button", { name: ko.qaOpen });
    await act(async () => {
      fireEvent.click(entry);
    });

    expect(openedSessions).toEqual(["ps_done"]);
    expect(document.querySelector("[data-qa-question-input]")).toBeTruthy();
  });

  test("submits one request per question and renders every citation kind as a visible source", async () => {
    const asks: CapturedAsk[] = [];
    const resolvers: Array<(outcome: QaDefenseAnswer) => void> = [];
    render(
      <MemoryRouter>
        <AuthProvider
          initialAuthenticated
          client={client({
            async openQaDefense(_csrfToken, sessionId) {
              return { ...endedLifecycle, presentationSessionId: sessionId };
            },
            submitQaDefenseQuestion(csrfToken, request) {
              asks.push({ csrfToken, request });
              return new Promise<QaDefenseAnswer>((resolve) => {
                resolvers.push(resolve);
              });
            },
          })}
        >
          <QaDefensePanel presentationSessionId="ps_qa" />
        </AuthProvider>
      </MemoryRouter>,
    );
    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: ko.qaOpen }));
    });

    const input = document.querySelector("[data-qa-question-input]");
    if (!(input instanceof HTMLInputElement)) throw new Error("question input is missing");
    fireEvent.change(input, { target: { value: "2분기 매출이 왜 하락했나요?" } });
    await act(async () => {
      fireEvent.click(document.querySelector("[data-qa-submit]") as Element);
    });

    // One click means exactly one POST; the answer arrives when the stub resolves.
    expect(resolvers).toHaveLength(1);
    await act(async () => {
      resolvers[0]?.({
        outcome: "ANSWERED",
        answer: "2분기 매출은 계절성 수요 감소로 하락했습니다.",
        citations: [
          {
            kind: "DECK_SLIDE",
            evidenceId: "ev_deck_1",
            slideOrdinal: 3,
            title: "매출 추이",
            quote: "3분기 예상 대비 12% 하락",
          },
          {
            kind: "REFERENCE_DOCUMENT",
            evidenceId: "ev_ref_1",
            documentTitle: "2026년 사업 계획서.md",
            chunkOrdinal: 4,
            quote: "하반기 수요는 계절적 요인으로 감소합니다.",
          },
          {
            kind: "EXTERNAL_SOURCE",
            evidenceId: "ev_ext_1",
            title: "업계 연간 보고서",
            url: "https://example.test/annual-report",
            quote: "Industry-wide demand softened in Q2.",
          },
        ],
        latencyMs: 120,
        completedAtMs: 1_000,
        askableUntilMs: Date.now() + 300_000,
      });
    });

    expect(asks).toHaveLength(1);
    expect(asks[0]).toEqual({
      csrfToken: "preview-csrf",
      request: {
        presentationSessionId: "ps_qa",
        questionText: "2분기 매출이 왜 하락했나요?",
        origin: "TYPED",
      },
    });

    const card = document.querySelector("[data-qa-answer='ANSWERED']");
    expect(card?.textContent).toContain("2분기 매출은 계절성 수요 감소로 하락했습니다.");

    // The source is the point: each citation kind gets its own visible row, led by what the
    // audience recognizes — the slide, the document name, or the link itself.
    const sources = [...(card?.querySelectorAll("[data-qa-source]") ?? [])];
    expect(sources.map((row) => row.getAttribute("data-qa-source"))).toEqual([
      "DECK_SLIDE",
      "REFERENCE_DOCUMENT",
      "EXTERNAL_SOURCE",
    ]);
    expect(sources[0]?.textContent).toContain(ko.qaSourceSlide.replace("{ordinal}", "3"));
    expect(sources[1]?.textContent).toContain("2026년 사업 계획서.md");
    const link = sources[2]?.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.test/annual-report");
  });

  test("a transient abstention keeps the draft and retries the same retained question", async () => {
    const asks: CapturedAsk[] = [];
    const resolvers: Array<(outcome: QaDefenseAnswer) => void> = [];
    render(
      <MemoryRouter>
        <AuthProvider
          initialAuthenticated
          client={client({
            async openQaDefense(_csrfToken, sessionId) {
              return { ...endedLifecycle, presentationSessionId: sessionId };
            },
            submitQaDefenseQuestion(csrfToken, request) {
              asks.push({ csrfToken, request });
              return new Promise<QaDefenseAnswer>((resolve) => {
                resolvers.push(resolve);
              });
            },
          })}
        >
          <QaDefensePanel presentationSessionId="ps_retry" />
        </AuthProvider>
      </MemoryRouter>,
    );
    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: ko.qaOpen }));
    });
    const input = document.querySelector("[data-qa-question-input]");
    if (!(input instanceof HTMLInputElement)) throw new Error("question input is missing");
    fireEvent.change(input, { target: { value: "경쟁사 대비 근거를 설명해 주세요" } });
    await act(async () => {
      fireEvent.click(document.querySelector("[data-qa-submit]") as Element);
    });
    await act(async () => {
      resolvers[0]?.({
        outcome: "ABSTAINED",
        reason: "retrieval_timeout",
        retryable: true,
        latencyMs: 40,
        completedAtMs: 900,
        askableUntilMs: Date.now() + 300_000,
      });
    });

    // Transient miss: honest copy, no claim the materials are inadequate, and the draft intact.
    const notice = document.querySelector("[data-qa-abstained='RETRYABLE']");
    expect(notice?.textContent).toContain(ko.qaAbstainedRetryable);
    expect(notice?.textContent).not.toContain(ko.qaAbstainedTerminal);
    expect(input.value).toBe("경쟁사 대비 근거를 설명해 주세요");
    const retry = document.querySelector("[data-qa-retry]");
    expect(retry).toBeTruthy();

    await act(async () => {
      fireEvent.click(retry as Element);
    });
    expect(asks).toHaveLength(2);
    expect(asks[1]?.request.questionText).toBe("경쟁사 대비 근거를 설명해 주세요");

    await act(async () => {
      resolvers[1]?.({
        outcome: "ANSWERED",
        answer: "대조 근거가 검색되어 답변을 준비했습니다.",
        citations: [
          {
            kind: "DECK_SLIDE",
            evidenceId: "ev_deck_2",
            slideOrdinal: 7,
            title: "경쟁 비교",
            quote: "주요 경쟁사 대비 단가 8% 우위",
          },
        ],
        latencyMs: 90,
        completedAtMs: 1_500,
        askableUntilMs: Date.now() + 300_000,
      });
    });
    expect(document.querySelector("[data-qa-answer='ANSWERED']")).toBeTruthy();
    expect(document.querySelector("[data-qa-retry]")).toBeNull();
  });

  test("a terminal abstention says the materials cannot support the question and offers no retry", async () => {
    const asks: CapturedAsk[] = [];
    const resolvers: Array<(outcome: QaDefenseAnswer) => void> = [];
    render(
      <MemoryRouter>
        <AuthProvider
          initialAuthenticated
          client={client({
            async openQaDefense(_csrfToken, sessionId) {
              return { ...endedLifecycle, presentationSessionId: sessionId };
            },
            submitQaDefenseQuestion(csrfToken, request) {
              asks.push({ csrfToken, request });
              return new Promise<QaDefenseAnswer>((resolve) => {
                resolvers.push(resolve);
              });
            },
          })}
        >
          <QaDefensePanel presentationSessionId="ps_terminal" />
        </AuthProvider>
      </MemoryRouter>,
    );
    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: ko.qaOpen }));
    });
    const input = document.querySelector("[data-qa-question-input]");
    if (!(input instanceof HTMLInputElement)) throw new Error("question input is missing");
    fireEvent.change(input, { target: { value: "내년 주가 전망은 어떤가요?" } });
    await act(async () => {
      fireEvent.click(document.querySelector("[data-qa-submit]") as Element);
    });
    await act(async () => {
      resolvers[0]?.({
        outcome: "ABSTAINED",
        reason: "no_supporting_material",
        retryable: false,
        latencyMs: 60,
        completedAtMs: 800,
        askableUntilMs: Date.now() + 300_000,
      });
    });

    // A terminal abstention is not an error and not an invitation to burn another attempt.
    const notice = document.querySelector("[data-qa-abstained='TERMINAL']");
    expect(notice?.textContent).toContain(ko.qaAbstainedTerminal);
    expect(document.querySelector("[data-qa-retry]")).toBeNull();
    expect(within(document.body).queryByRole("button", { name: ko.qaRetry })).toBeNull();
    expect(asks).toHaveLength(1);
  });

  // Renders the panel, opens the session, asks `question`, and hands back the single
  // resolver for the stubbed submit so each test decides the settled outcome.
  async function askOnce(question: string) {
    const resolvers: Array<(outcome: QaDefenseAnswer) => void> = [];
    render(
      <MemoryRouter>
        <AuthProvider
          initialAuthenticated
          client={client({
            async openQaDefense(_csrfToken, sessionId) {
              return { ...endedLifecycle, presentationSessionId: sessionId };
            },
            submitQaDefenseQuestion(_csrfToken, _request) {
              return new Promise<QaDefenseAnswer>((resolve) => {
                resolvers.push(resolve);
              });
            },
          })}
        >
          <QaDefensePanel presentationSessionId="ps_card" />
        </AuthProvider>
      </MemoryRouter>,
    );
    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: ko.qaOpen }));
    });
    const input = document.querySelector("[data-qa-question-input]");
    if (!(input instanceof HTMLInputElement)) throw new Error("question input is missing");
    fireEvent.change(input, { target: { value: question } });
    await act(async () => {
      fireEvent.click(document.querySelector("[data-qa-submit]") as Element);
    });
    return {
      input,
      settle: (outcome: QaDefenseAnswer) =>
        act(async () => {
          resolvers[0]?.(outcome);
        }),
      settleRetry: (outcome: QaDefenseAnswer) =>
        act(async () => {
          resolvers[1]?.(outcome);
        }),
    };
  }

  test("an ANSWERED card leads with the exact asked question", async () => {
    const { settle } = await askOnce("2분기 매출이 왜 하락했나요?");
    await settle({
      outcome: "ANSWERED",
      answer: "2분기 매출은 계절성 수요 감소로 하락했습니다.",
      citations: [],
      latencyMs: 10,
      completedAtMs: 100,
      askableUntilMs: Date.now() + 300_000,
    });
    const card = document.querySelector("[data-qa-answer='ANSWERED']");
    const heading = card?.querySelector("[data-qa-question]");
    expect(heading?.textContent).toBe("2분기 매출이 왜 하락했나요?");
  });

  test("both abstention variants keep the asked question visible on the card", async () => {
    const retryable = await askOnce("경쟁사 대비 근거를 설명해 주세요");
    await retryable.settle({
      outcome: "ABSTAINED",
      reason: "retrieval_timeout",
      retryable: true,
      latencyMs: 40,
      completedAtMs: 900,
      askableUntilMs: Date.now() + 300_000,
    });
    expect(
      document.querySelector("[data-qa-abstained='RETRYABLE']")?.querySelector("[data-qa-question]")
        ?.textContent,
    ).toBe("경쟁사 대비 근거를 설명해 주세요");
    cleanup();

    const terminal = await askOnce("내년 주가 전망은 어떤가요?");
    await terminal.settle({
      outcome: "ABSTAINED",
      reason: "no_supporting_material",
      retryable: false,
      latencyMs: 60,
      completedAtMs: 800,
      askableUntilMs: Date.now() + 300_000,
    });
    expect(
      document.querySelector("[data-qa-abstained='TERMINAL']")?.querySelector("[data-qa-question]")
        ?.textContent,
    ).toBe("내년 주가 전망은 어떤가요?");
  });

  test("retry resubmits the retained question and the re-rendered card still shows it", async () => {
    const asks: CapturedAsk[] = [];
    const resolvers: Array<(outcome: QaDefenseAnswer) => void> = [];
    render(
      <MemoryRouter>
        <AuthProvider
          initialAuthenticated
          client={client({
            async openQaDefense(_csrfToken, sessionId) {
              return { ...endedLifecycle, presentationSessionId: sessionId };
            },
            submitQaDefenseQuestion(csrfToken, request) {
              asks.push({ csrfToken, request });
              return new Promise<QaDefenseAnswer>((resolve) => {
                resolvers.push(resolve);
              });
            },
          })}
        >
          <QaDefensePanel presentationSessionId="ps_retry_card" />
        </AuthProvider>
      </MemoryRouter>,
    );
    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: ko.qaOpen }));
    });
    const input = document.querySelector("[data-qa-question-input]");
    if (!(input instanceof HTMLInputElement)) throw new Error("question input is missing");
    fireEvent.change(input, { target: { value: "도입부 구조를 다시 설명해 주세요" } });
    await act(async () => {
      fireEvent.click(document.querySelector("[data-qa-submit]") as Element);
    });
    await act(async () => {
      resolvers[0]?.({
        outcome: "ABSTAINED",
        reason: "retrieval_timeout",
        retryable: true,
        latencyMs: 30,
        completedAtMs: 700,
        askableUntilMs: Date.now() + 300_000,
      });
    });

    // The presenter edits the draft while deciding to retry; the retry must still send —
    // and the settled card must still name — the question the audience actually heard.
    fireEvent.change(input, { target: { value: "지금과 전혀 다른 임시 텍스트" } });
    await act(async () => {
      fireEvent.click(document.querySelector("[data-qa-retry]") as Element);
    });
    expect(asks[1]?.request.questionText).toBe("도입부 구조를 다시 설명해 주세요");
    await act(async () => {
      resolvers[1]?.({
        outcome: "ANSWERED",
        answer: "도입부 구조를 정리했습니다.",
        citations: [],
        latencyMs: 80,
        completedAtMs: 1_400,
        askableUntilMs: Date.now() + 300_000,
      });
    });
    const card = document.querySelector("[data-qa-answer='ANSWERED']");
    expect(card?.querySelector("[data-qa-question]")?.textContent).toBe(
      "도입부 구조를 다시 설명해 주세요",
    );
  });

  // -----------------------------------------------------------------------
  // FIVE-MINUTE WINDOW EXPIRY. The panel arms one coalesced recheck at the
  // accepted submission's askableUntilMs; an expiry landing mid-ask aborts the
  // pending submission and ends EXPIRED — an 'asking' state can never outlive
  // its window silently.
  // -----------------------------------------------------------------------
  interface ManualTimer {
    readonly delayMs: number;
    fire(): void;
    cancelled: boolean;
    fired: boolean;
  }

  function manualClock() {
    const timers: ManualTimer[] = [];
    const pending = () => timers.filter((timer) => !timer.cancelled && !timer.fired);
    const seams = {
      now: () => 0,
      schedule(delayMs: number, fire: () => void) {
        const timer: ManualTimer = {
          delayMs,
          cancelled: false,
          fired: false,
          fire: () => {
            timer.fired = true;
            if (!timer.cancelled) fire();
          },
        };
        timers.push(timer);
        return {
          cancel: () => {
            timer.cancelled = true;
          },
        };
      },
      cancel(handle: { cancel(): void }) {
        handle.cancel();
      },
    };
    return { timers, pending, seams };
  }

  test("an ask interrupted by its window's deadline refetches and ends EXPIRED, never left as 'asking'", async () => {
    const clock = manualClock();
    let pendingSignal: AbortSignal | undefined;
    const rechecks: string[] = [];
    render(
      <MemoryRouter>
        <AuthProvider
          initialAuthenticated
          client={client({
            async openQaDefense(_csrfToken, sessionId) {
              return {
                ...endedLifecycle,
                presentationSessionId: sessionId,
                qaWindow: { status: "LIVE", askableUntilMs: 5_000 },
              };
            },
            submitQaDefenseQuestion(_csrfToken, _request, signal) {
              pendingSignal = signal;
              return new Promise<QaDefenseAnswer>(() => {});
            },
            async readQaDefenseWindow(_csrfToken, sessionId) {
              rechecks.push(sessionId);
              return { status: "EXPIRED", askableUntilMs: 5_000 };
            },
          })}
        >
          <QaDefensePanel presentationSessionId="ps_expiry" clockSeams={clock.seams} />
        </AuthProvider>
      </MemoryRouter>,
    );
    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: ko.qaOpen }));
    });
    // The LIVE window armed exactly one recheck at its deadline.
    expect(clock.pending()).toHaveLength(1);

    const input = document.querySelector("[data-qa-question-input]");
    if (!(input instanceof HTMLInputElement)) throw new Error("question input is missing");
    fireEvent.change(input, { target: { value: "자료 근거를 다시 설명해 주세요" } });
    await act(async () => {
      fireEvent.click(document.querySelector("[data-qa-submit]") as Element);
    });
    expect(document.querySelector("[data-qa-phase]")?.getAttribute("data-qa-phase")).toBe("ASKING");

    // The deadline lands while the ask is still in flight: the recheck fires, refetches,
    // and the server-verified EXPIRED verdict ends the window and aborts the pending ask.
    await act(async () => {
      clock.timers[0]?.fire();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(rechecks).toEqual(["ps_expiry"]);
    expect(pendingSignal?.aborted).toBe(true);
    expect(document.querySelector("[data-qa-phase]")?.getAttribute("data-qa-phase")).toBe(
      "EXPIRED",
    );
    expect(document.querySelector("[data-qa-question-input]")).toBeNull();
    expect(document.querySelector("[data-qa-submit]")).toBeNull();
    expect(document.body.textContent).toContain(ko.qaWindowExpired);
  });

  test("a LIVE recheck verdict re-arms the chain and the ask completes normally inside the window", async () => {
    const clock = manualClock();
    const resolvers: Array<(outcome: QaDefenseAnswer) => void> = [];
    let reads = 0;
    render(
      <MemoryRouter>
        <AuthProvider
          initialAuthenticated
          client={client({
            async openQaDefense(_csrfToken, sessionId) {
              return {
                ...endedLifecycle,
                presentationSessionId: sessionId,
                qaWindow: { status: "LIVE", askableUntilMs: 5_000 },
              };
            },
            submitQaDefenseQuestion() {
              return new Promise<QaDefenseAnswer>((resolve) => {
                resolvers.push(resolve);
              });
            },
            async readQaDefenseWindow() {
              reads += 1;
              // First recheck: still LIVE (server clock disagrees). Second: terminal EXPIRED.
              return reads === 1
                ? { status: "LIVE", askableUntilMs: 5_000 }
                : { status: "EXPIRED", askableUntilMs: 5_000 };
            },
          })}
        >
          <QaDefensePanel presentationSessionId="ps_still_live" clockSeams={clock.seams} />
        </AuthProvider>
      </MemoryRouter>,
    );
    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: ko.qaOpen }));
    });
    const input = document.querySelector("[data-qa-question-input]");
    if (!(input instanceof HTMLInputElement)) throw new Error("question input is missing");
    fireEvent.change(input, { target: { value: "경쟁 우위는?" } });
    await act(async () => {
      fireEvent.click(document.querySelector("[data-qa-submit]") as Element);
    });

    // Tick at the deadline: the refetch says the window is still LIVE, so the ask is left
    // alone and the chain re-arms once — never two pending timers.
    await act(async () => {
      clock.timers[0]?.fire();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.querySelector("[data-qa-phase]")?.getAttribute("data-qa-phase")).toBe("ASKING");
    expect(clock.pending()).toHaveLength(1);

    await act(async () => {
      resolvers[0]?.({
        outcome: "ANSWERED",
        answer: "단가 우위가 핵심입니다.",
        citations: [],
        latencyMs: 40,
        completedAtMs: 2_000,
        askableUntilMs: 5_000,
      });
    });
    expect(document.querySelector("[data-qa-answer='ANSWERED']")).toBeTruthy();

    // The settled submission's window is still watched: the next tick refetches and the
    // terminal EXPIRED verdict ends the window — the card stays, the controls leave.
    await act(async () => {
      clock.pending().at(-1)?.fire();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.querySelector("[data-qa-phase]")?.getAttribute("data-qa-phase")).toBe(
      "EXPIRED",
    );
    expect(document.querySelector("[data-qa-answer='ANSWERED']")).toBeTruthy();
    expect(document.querySelector("[data-qa-submit]")).toBeNull();
  });

  test("a window already EXPIRED at open stays terminal — no ask controls, no armed recheck", async () => {
    const clock = manualClock();
    render(
      <MemoryRouter>
        <AuthProvider
          initialAuthenticated
          client={client({
            async openQaDefense(_csrfToken, sessionId) {
              return {
                ...endedLifecycle,
                presentationSessionId: sessionId,
                qaWindow: { status: "EXPIRED", askableUntilMs: 5_000 },
              };
            },
          })}
        >
          <QaDefensePanel presentationSessionId="ps_late" clockSeams={clock.seams} />
        </AuthProvider>
      </MemoryRouter>,
    );
    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: ko.qaOpen }));
    });
    expect(document.querySelector("[data-qa-phase]")?.getAttribute("data-qa-phase")).toBe(
      "EXPIRED",
    );
    expect(document.querySelector("[data-qa-question-input]")).toBeNull();
    expect(clock.pending()).toHaveLength(0);
    expect(document.body.textContent).toContain(ko.qaWindowExpired);
  });

  test("an ask refused with qa_expired ends the window EXPIRED without waiting for a tick", async () => {
    const clock = manualClock();
    const { QaDefenseExpiredError } = await import("./session-client");
    render(
      <MemoryRouter>
        <AuthProvider
          initialAuthenticated
          client={client({
            async openQaDefense(_csrfToken, sessionId) {
              return {
                ...endedLifecycle,
                presentationSessionId: sessionId,
                qaWindow: { status: "LIVE", askableUntilMs: 5_000 },
              };
            },
            async submitQaDefenseQuestion() {
              throw new QaDefenseExpiredError();
            },
          })}
        >
          <QaDefensePanel presentationSessionId="ps_refused" clockSeams={clock.seams} />
        </AuthProvider>
      </MemoryRouter>,
    );
    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: ko.qaOpen }));
    });
    const input = document.querySelector("[data-qa-question-input]");
    if (!(input instanceof HTMLInputElement)) throw new Error("question input is missing");
    fireEvent.change(input, { target: { value: "늦은 질문" } });
    await act(async () => {
      fireEvent.click(document.querySelector("[data-qa-submit]") as Element);
    });
    expect(document.querySelector("[data-qa-phase]")?.getAttribute("data-qa-phase")).toBe(
      "EXPIRED",
    );
    expect(document.body.textContent).toContain(ko.qaWindowExpired);
    expect(clock.pending()).toHaveLength(0);
  });
});
