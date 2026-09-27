import { afterEach, describe, expect, test } from "bun:test";
import { registerDom } from "@impromptu/test-harness";

registerDom();

const { act, cleanup, fireEvent, render, within } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");

const { StrictMode } = await import("react");
const { AuthProvider, ConsoleRoutes } = await import("./App");
const { CoachingDisplay } = await import("./coaching-display");
const { messages } = await import("./i18n");
const { createCoachingState, reduceCoachingState } = await import("@impromptu/state/coaching");

import {
  AccountRegistrationError,
  type AccountSessionView,
  type ActivePresentationView,
  type ConsoleDeckUploadClient,
  type ConsoleSessionClient,
  PlaybackCommandRejectedError,
  type RecommendationOutcome,
  SessionReportClientError,
  type SessionReportView,
} from "./session-client";
import { STAGE_ORIGIN } from "./stage-origin";

afterEach(cleanup);

function renderConsole(path: string, authenticated: boolean, locale: "ko" | "en" = "en") {
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider initialAuthenticated={authenticated}>
        <ConsoleRoutes />
      </AuthProvider>
    </MemoryRouter>,
  );
  if (locale === "en") {
    fireEvent.click(within(document.body).getByRole("button", { name: "English" }));
  }
  return view;
}

function switchToEnglish(): void {
  fireEvent.click(within(document.body).getByRole("button", { name: "English" }));
}

function workspaceClient(
  overrides: Partial<ConsoleDeckUploadClient> = {},
): ConsoleDeckUploadClient {
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

const finalizedReport: SessionReportView = {
  reportVersion: 1,
  presentationSessionId: "ps_report",
  ownerAccountId: "account_preview",
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
    {
      sequence: 2,
      publicSlideKey: "B",
      occurrenceSequence: 1,
      enteredOffsetMs: 300,
      leftOffsetMs: 600,
      dwellMs: 300,
      revisit: false,
    },
    {
      sequence: 3,
      publicSlideKey: "A",
      occurrenceSequence: 2,
      enteredOffsetMs: 600,
      leftOffsetMs: 1_000,
      dwellMs: 400,
      revisit: true,
    },
  ],
  speech: {
    derivedSummary: "1개 최종 발화에서 2개 단어를 집계했습니다.",
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
    items: [
      {
        evidenceId: "evidence-1",
        sourceId: "source-1",
        sourceUrl: null,
        provenance: "CURATED_PREAPPROVED",
      },
    ],
  },
};

const workspacePresentation: ActivePresentationView = {
  presentationSessionId: "ps_workspace",
  presentationSessionEpoch: "pse_1",
  deckVersion: "deck_workspace",
  slides: [
    { publicSlideKey: "slide_one", ordinal: 1, accessibilityLabel: "Opening slide" },
    { publicSlideKey: "slide_two", ordinal: 2, accessibilityLabel: "Results slide" },
  ],
};

describe("Console route boundary", () => {
  test("gates neutral coaching metrics by explicit opt-in, mute, words, and capability", () => {
    const text = {
      title: "코칭 지표",
      optIn: "코칭 지표 표시",
      mute: "코칭 표시 음소거",
      unavailable: "측정 불가",
      currentPace: "현재 30초",
      previousPace: "직전 30초",
      delta: "변화량",
      cueCount: "큐 횟수",
    };
    const apply = (state: ReturnType<typeof createCoachingState>, event: unknown) =>
      reduceCoachingState(state, event).state;
    let measured = apply(createCoachingState(), { kind: "OPT_IN", enabled: true });
    measured = apply(measured, {
      kind: "FINAL",
      sessionGeneration: 1,
      sequence: 1,
      segmentId: "segment_previous",
      finalSegmentId: "final_previous",
      finalizedAtSessionMs: 45_000,
      words: [
        { text: "직전", startSessionMs: 34_800, endSessionMs: 35_000 },
        { text: "구간", startSessionMs: 39_800, endSessionMs: 40_000 },
      ],
    });
    measured = apply(measured, {
      kind: "FINAL",
      sessionGeneration: 1,
      sequence: 2,
      segmentId: "segment_current",
      finalSegmentId: "final_current",
      finalizedAtSessionMs: 90_000,
      words: [
        { text: "현재", startSessionMs: 64_800, endSessionMs: 65_000 },
        { text: "고정", startSessionMs: 69_800, endSessionMs: 70_000 },
        { text: "단어", startSessionMs: 79_800, endSessionMs: 80_000 },
        { text: "fixture", startSessionMs: 89_800, endSessionMs: 90_000 },
      ],
    });

    const optInChanges: boolean[] = [];
    const muteChanges: boolean[] = [];
    const noChange = () => {};
    const view = render(
      <CoachingDisplay
        state={createCoachingState()}
        text={text}
        wordTimingCapable
        onOptInChange={(enabled) => optInChanges.push(enabled)}
        onMuteChange={(muted) => muteChanges.push(muted)}
      />,
    );
    expect(document.querySelectorAll("[data-coaching-metric]")).toHaveLength(0);
    const optIn = within(document.body).getByRole("checkbox", { name: text.optIn });
    expect(optIn.tabIndex).toBeGreaterThanOrEqual(0);
    fireEvent.click(optIn);
    expect(optInChanges).toEqual([true]);

    view.rerender(
      <CoachingDisplay
        state={measured}
        text={text}
        wordTimingCapable
        onOptInChange={noChange}
        onMuteChange={(muted) => muteChanges.push(muted)}
      />,
    );
    expect(document.querySelector("[data-coaching-metric='current']")?.textContent).toBe("8 WPM");
    expect(document.querySelector("[data-coaching-metric='previous']")?.textContent).toBe("4 WPM");
    expect(document.querySelector("[data-coaching-metric='delta']")?.textContent).toBe("+4 WPM");
    expect(document.querySelector("[data-coaching-metric='cue-count']")?.textContent).toBe("2");
    expect(document.querySelector("[aria-live='polite']")?.getAttribute("aria-atomic")).toBe(
      "true",
    );
    fireEvent.click(within(document.body).getByRole("checkbox", { name: text.mute }));
    expect(muteChanges).toEqual([true]);

    view.rerender(
      <CoachingDisplay
        state={{ ...measured, muted: true }}
        text={text}
        wordTimingCapable
        onOptInChange={noChange}
        onMuteChange={noChange}
      />,
    );
    expect(document.querySelectorAll("[data-coaching-metric]")).toHaveLength(0);

    view.rerender(
      <CoachingDisplay
        state={measured}
        text={text}
        wordTimingCapable={false}
        onOptInChange={noChange}
        onMuteChange={noChange}
      />,
    );
    expect(document.querySelectorAll("[data-coaching-state]")).toHaveLength(1);
    expect(document.querySelector("[data-coaching-state='unavailable']")?.textContent).toBe(
      "측정 불가",
    );
    expect(document.querySelectorAll("[data-coaching-metric]")).toHaveLength(0);

    const noWords = apply(apply(createCoachingState(), { kind: "OPT_IN", enabled: true }), {
      kind: "FINAL",
      sessionGeneration: 1,
      sequence: 1,
      segmentId: "segment_empty",
      finalSegmentId: "final_empty",
      finalizedAtSessionMs: 30_000,
      words: [],
    });
    view.rerender(
      <CoachingDisplay
        state={noWords}
        text={text}
        wordTimingCapable
        onOptInChange={noChange}
        onMuteChange={noChange}
      />,
    );
    expect(document.querySelectorAll("[data-coaching-state]")).toHaveLength(1);
    expect(document.querySelector("[data-coaching-state='unavailable']")?.textContent).toBe(
      "측정 불가",
    );
    expect(document.querySelectorAll("[data-coaching-metric]")).toHaveLength(0);
  });

  test("keeps locale catalogs structurally complete", () => {
    expect(Object.keys(messages("ko")).sort()).toEqual(Object.keys(messages("en")).sort());
  });

  test("renders the exact finalized report after owner end and routes without a GET", async () => {
    let readCount = 0;
    let signalEnded: () => void = () => {
      throw new Error("end signal was not installed");
    };
    const ended = new Promise<void>((resolve) => {
      signalEnded = resolve;
    });
    const client = workspaceClient({
      async setSlide() {
        return { acceptedControlRevision: "cr_1" };
      },
      async endPresentationAndAwaitReport() {
        signalEnded();
        return finalizedReport;
      },
      async readFinalizedReport() {
        readCount += 1;
        return { status: "FINALIZED", report: finalizedReport };
      },
    });
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider
          initialAuthenticated
          initialDisplayBindingEpoch="dbe_1"
          initialPresentation={{ ...workspacePresentation, presentationSessionId: "ps_report" }}
          client={client}
        >
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );

    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: "발표 시작" }));
    });
    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: "발표 종료" }));
      await ended;
    });

    expect(document.querySelector("[data-presentation-report='ready']")).toBeTruthy();
    expect(readCount).toBe(0);
    expect(document.querySelectorAll("[data-report-slide-visit]")).toHaveLength(3);
  });

  test("still reaches the report when the finalization signal lapses", async () => {
    let readCount = 0;
    const client = workspaceClient({
      async setSlide() {
        return { acceptedControlRevision: "cr_1" };
      },
      async endPresentationAndAwaitReport() {
        // The live signal is bounded at ten seconds; the presentation ends server-side regardless.
        throw new Error("Finalized report signal did not arrive in time.");
      },
      async readFinalizedReport() {
        readCount += 1;
        return { status: "FINALIZED", report: finalizedReport };
      },
    });
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider
          initialAuthenticated
          initialDisplayBindingEpoch="dbe_1"
          initialPresentation={{ ...workspacePresentation, presentationSessionId: "ps_report" }}
          client={client}
        >
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );

    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: "발표 시작" }));
    });
    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: "발표 종료" }));
      for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
    });

    // A lapsed signal used to strand the presenter on the playback screen in front of a room,
    // even though the report was readable the whole time.
    expect(readCount).toBe(1);
    expect(document.querySelector("[data-presentation-report='ready']")).toBeTruthy();
  });

  test("stays on the presentation when the end itself did not take", async () => {
    const client = workspaceClient({
      async setSlide() {
        return { acceptedControlRevision: "cr_1" };
      },
      async endPresentationAndAwaitReport() {
        throw new Error("Private report stream did not open in time.");
      },
      async readFinalizedReport() {
        throw new Error("the report cannot be read");
      },
    });
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider
          initialAuthenticated
          initialDisplayBindingEpoch="dbe_1"
          initialPresentation={{ ...workspacePresentation, presentationSessionId: "ps_unended" }}
          client={client}
        >
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );

    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: "발표 시작" }));
    });
    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: "발표 종료" }));
      for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
    });

    // An unreadable report means the presentation is still live, so navigating away would hide a
    // running presentation from its own controller.
    expect(document.querySelector("[data-presentation-report='ready']")).toBeNull();
    expect(within(document.body).getByRole("button", { name: "발표 종료" })).toBeTruthy();
  });

  test("reload GET reproduces identical A-B-A report DOM and exact dwell totals", async () => {
    const client = workspaceClient({
      async readFinalizedReport() {
        return { status: "FINALIZED", report: finalizedReport };
      },
    });
    const finalizedView = render(
      <MemoryRouter
        initialEntries={[{ pathname: "/reports/ps_report", state: { report: finalizedReport } }]}
      >
        <AuthProvider initialAuthenticated client={client}>
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );
    const beforeReload = document.querySelector("[data-presentation-report]")?.innerHTML;
    if (beforeReload === undefined) throw new Error("finalized report DOM is missing");
    finalizedView.unmount();

    let signalRead: () => void = () => {
      throw new Error("reload read signal was not installed");
    };
    const read = new Promise<void>((resolve) => {
      signalRead = resolve;
    });
    const reloadClient = workspaceClient({
      async readFinalizedReport() {
        signalRead();
        return { status: "FINALIZED", report: finalizedReport };
      },
    });
    render(
      <MemoryRouter initialEntries={["/reports/ps_report"]}>
        <AuthProvider initialAuthenticated client={reloadClient}>
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );
    await act(async () => await read);

    const reportElement = document.querySelector("[data-presentation-report]");
    expect(reportElement?.innerHTML).toBe(beforeReload);
    const visits = [...document.querySelectorAll("[data-report-slide-visit]")];
    expect(visits.map((visit) => visit.getAttribute("data-report-slide-key"))).toEqual([
      "A",
      "B",
      "A",
    ]);
    expect(visits.map((visit) => visit.getAttribute("data-report-occurrence"))).toEqual([
      "1",
      "1",
      "2",
    ]);
    expect(
      visits.reduce(
        (total, visit) => total + Number(visit.getAttribute("data-report-dwell-ms")),
        0,
      ),
    ).toBe(1_000);
    expect(visits.map((visit) => visit.getAttribute("data-report-dwell-ms"))).toEqual([
      "300",
      "300",
      "400",
    ]);
    const reportJson = JSON.stringify(finalizedReport);
    const reportDom = reportElement?.textContent ?? "";
    for (const sentinel of ["TRANSCRIPT_BODY_SENTINEL", "SILENCE_SENTINEL", "사용한 근거"]) {
      expect(reportJson).not.toContain(sentinel);
      expect(reportDom).not.toContain(sentinel);
    }
    expect(reportDom).toContain("관련 자료");
  });

  test("renders zero report data when the same-tenant non-owner receives 403", async () => {
    let signalDenied: () => void = () => {
      throw new Error("denial signal was not installed");
    };
    const denied = new Promise<void>((resolve) => {
      signalDenied = resolve;
    });
    const client = workspaceClient({
      async readFinalizedReport() {
        signalDenied();
        throw new SessionReportClientError(403, "report_forbidden");
      },
    });
    render(
      <MemoryRouter initialEntries={["/reports/ps_report"]}>
        <AuthProvider initialAuthenticated client={client}>
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );
    await act(async () => await denied);

    expect(document.querySelector("[data-report-status='FORBIDDEN']")).toBeTruthy();
    expect(document.querySelectorAll("[data-presentation-report]")).toHaveLength(0);
    expect(document.querySelectorAll("[data-report-slide-visit]")).toHaveLength(0);
    expect(document.querySelectorAll("[data-report-evidence]")).toHaveLength(0);
    expect(document.body.textContent).not.toContain("report_forbidden");
  });

  test("translates sign-in, navigation, and evidence approval pages without English gaps", () => {
    renderConsole("/sign-in", false, "ko");

    expect(within(document.body).getByRole("heading", { name: "Impromptu에 로그인" })).toBeTruthy();
    expect(document.querySelector("[data-sign-in-username]")).toBeTruthy();
    expect(document.querySelector("[data-sign-in-password]")).toBeTruthy();

    cleanup();
    renderConsole("/live-publication", true, "ko");

    // The retired public-approval surface now renders a guide-and-return step in the
    // presenter's language, never the old approval chrome and never an English gap.
    expect(within(document.body).getByRole("heading", { name: "화면 안내" })).toBeTruthy();
    expect(document.querySelector("[data-live-publication-interstitial]")).toBeTruthy();
    const returnLinks = within(document.body)
      .getAllByRole("link", { name: "발표 준비" })
      .filter((link) => link.getAttribute("href") === "/");
    expect(returnLinks.length).toBeGreaterThan(0);
    expect(within(document.body).queryByRole("button", { name: "카드 승인" })).toBeNull();
    expect(within(document.body).queryByText("Authoritative snapshot")).toBeNull();
  });

  test("switches locale from the compact language control", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider initialAuthenticated initialPresentation={workspacePresentation}>
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );

    const picker = within(document.body).getByRole("group", { name: "Language" });
    expect(within(picker).getByRole("button", { name: "한국어" })).toBeTruthy();
    expect(within(picker).getByRole("button", { name: "English" })).toBeTruthy();
    expect(document.documentElement.lang).toBe("ko");
    expect(within(document.body).getByRole("heading", { name: "발표 준비" })).toBeTruthy();

    fireEvent.click(within(picker).getByRole("button", { name: "English" }));
    expect(document.documentElement.lang).toBe("en");
    expect(
      within(document.body).getByRole("heading", { name: "Presentation preparation" }),
    ).toBeTruthy();
  });

  test("opens with an upload-first workspace and accepts a dropped deck", async () => {
    const uploadedFiles: string[] = [];
    const client = workspaceClient({
      async uploadDeck(_csrfToken, file) {
        uploadedFiles.push(file.name);
        return {
          presentationSessionId: workspacePresentation.presentationSessionId,
          presentationSessionEpoch: workspacePresentation.presentationSessionEpoch,
          deckVersion: workspacePresentation.deckVersion,
          publicDeck: { slides: workspacePresentation.slides },
        };
      },
    });
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider initialAuthenticated client={client}>
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );
    switchToEnglish();
    const file = new File(["deck"], "launch.pdf", { type: "application/pdf" });
    const dropzone = document.querySelector("[data-upload-dropzone]");
    expect(dropzone).toBeTruthy();

    await act(async () => {
      fireEvent.drop(dropzone as Element, { dataTransfer: { files: [file] } });
    });

    expect(uploadedFiles).toEqual(["launch.pdf"]);
    expect(
      within(document.body).getByRole("heading", { name: "Presentation preparation" }),
    ).toBeTruthy();
    // The slide rail was removed, so the uploaded deck is asserted through the surfaces that
    // replaced it: the preview region and the navigation controls that drive the same index.
    expect(within(document.body).getByLabelText("Slide preview")).toBeTruthy();
    expect(within(document.body).getByRole("button", { name: "Next slide" })).toBeTruthy();
    expect(within(document.body).queryByRole("button", { name: "Opening slide" })).toBeNull();
  });

  function uploadedSlidePresentation(url: string, contentHash: string): ActivePresentationView {
    return {
      ...workspacePresentation,
      slides: [
        {
          publicSlideKey: "slide_one",
          ordinal: 1,
          accessibilityLabel: "Opening slide",
          image: { url, contentHash, width: 1600, height: 900 },
        },
      ],
    };
  }

  test("renders an uploaded slide through the same-origin asset path", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider
          initialAuthenticated
          initialPresentation={uploadedSlidePresentation(
            "http://127.0.0.1:3002/v1/deck-assets/manifest/slides/slide-1.png",
            "a".repeat(64),
          )}
        >
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );

    const image = document.querySelector("[data-rendered-slide] img");
    expect(image?.getAttribute("src")).toBe("/v1/deck-assets/manifest/slides/slide-1.png");
    await act(async () => fireEvent.load(image as Element));
    expect(document.querySelector("[data-rendered-slide='active'] img")).toBeTruthy();
    expect(image?.getAttribute("alt")).toBe("Opening slide");
  });

  test("adds evidence as each slide finishes without blocking presentation readiness", async () => {
    let resolveOpening: (outcome: RecommendationOutcome) => void = () => {
      throw new Error("opening recommendation signal was not installed");
    };
    const openingRecommendation = new Promise<RecommendationOutcome>((resolve) => {
      resolveOpening = resolve;
    });
    let resolveResults: (outcome: RecommendationOutcome) => void = () => {
      throw new Error("results recommendation signal was not installed");
    };
    const resultsRecommendation = new Promise<RecommendationOutcome>((resolve) => {
      resolveResults = resolve;
    });
    let signalRequestsStarted: () => void = () => {
      throw new Error("request signal was not installed");
    };
    const requestsStarted = new Promise<void>((resolve) => {
      signalRequestsStarted = resolve;
    });
    const requestSignals: AbortSignal[] = [];
    const slideCommands: string[] = [];
    const presentation = { ...workspacePresentation, manifestHash: "a".repeat(64) };
    const client = workspaceClient({
      recommend(_csrfToken, request, signal) {
        if (signal !== undefined) requestSignals.push(signal);
        if (requestSignals.length === presentation.slides.length) signalRequestsStarted();
        return request.query === "Opening slide" ? openingRecommendation : resultsRecommendation;
      },
      async setSlide(_csrfToken, input) {
        slideCommands.push(input.publicSlideKey);
        return { acceptedControlRevision: "cr_1" };
      },
    });
    const view = render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider
          initialAuthenticated
          initialDisplayBindingEpoch="dbe_1"
          initialPresentation={presentation}
          client={client}
        >
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );

    await act(async () => await requestsStarted);
    expect(document.querySelector("[data-evidence-status='PREPARING']")).toBeTruthy();
    expect(document.querySelectorAll("[data-evidence-card]")).toHaveLength(0);
    const start = within(document.body).getByRole("button", { name: "발표 시작" });
    expect(start.hasAttribute("disabled")).toBe(false);
    await act(async () => fireEvent.click(start));
    expect(slideCommands).toEqual(["slide_one"]);

    const result: RecommendationOutcome = {
      outcome: "RECOMMEND",
      recommendation: { claim: "Revenue increased year over year." },
      evidence: [
        {
          kind: "EXTERNAL",
          evidenceId: `external:${"b".repeat(64)}`,
          title: "Origin annual report",
          sourceUrl: "https://example.test/annual-report",
          sourceDate: "2025-03-04T00:00:00.000Z",
          rights: "UNKNOWN",
        },
      ],
      completedAtMs: 100,
      latencyMs: 20,
    };
    await act(async () => {
      resolveResults(result);
      await resultsRecommendation;
    });

    const cards = document.querySelectorAll("[data-evidence-card]");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.textContent).toContain("Origin annual report");
    expect(cards[0]?.textContent).toContain("Revenue increased year over year.");
    expect(cards[0]?.textContent).toContain("https://example.test/annual-report");
    expect(cards[0]?.textContent).toContain("기준일");
    expect(cards[0]?.textContent).toContain("2025-03-04");
    expect(cards[0]?.textContent).toContain("이용 조건 확인 필요");
    expect(cards[0]?.textContent).not.toContain("SEARCH_SNIPPET_SENTINEL");
    expect(document.querySelector("[data-evidence-status='PREPARING']")).toBeTruthy();

    view.unmount();
    expect(requestSignals).toHaveLength(2);
    expect(requestSignals.every((signal) => signal.aborted)).toBe(true);
    await act(async () => {
      resolveOpening(result);
      await openingRecommendation;
    });
    expect(document.querySelectorAll("[data-evidence-card]")).toHaveLength(0);
  });

  test("dispatches exactly one recommendation per slide when StrictMode double-invokes the preparation effect", async () => {
    const recommendQueries: string[] = [];
    const requestSignals: AbortSignal[] = [];
    let signalAllStarted: () => void = () => {
      throw new Error("request signal was not installed");
    };
    const allStarted = new Promise<void>((resolve) => {
      signalAllStarted = resolve;
    });
    const deck = new File(["deck"], "rehearsal.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    const client = workspaceClient({
      async uploadDeck(_csrfToken, selected) {
        expect(selected.name).toBe("rehearsal.pptx");
        return {
          presentationSessionId: "ps_strict",
          presentationSessionEpoch: "pse_1",
          deckVersion: "deck_strict",
          publicDeck: {
            manifestHash: "a".repeat(64),
            slides: [
              {
                publicSlideKey: "slide_one",
                ordinal: 1,
                accessibilityLabel: "Opening slide",
              },
              {
                publicSlideKey: "slide_two",
                ordinal: 2,
                accessibilityLabel: "Results slide",
              },
            ],
          },
        };
      },
      recommend(_csrfToken, request, signal) {
        if (signal !== undefined) requestSignals.push(signal);
        recommendQueries.push(request.query);
        if (recommendQueries.length >= 2) signalAllStarted();
        return new Promise<RecommendationOutcome>(() => {});
      },
    });
    const view = render(
      <MemoryRouter initialEntries={["/"]}>
        <StrictMode>
          <AuthProvider initialAuthenticated client={client}>
            <ConsoleRoutes />
          </AuthProvider>
        </StrictMode>
      </MemoryRouter>,
    );

    // The cockpit (and its preparation panel) mounts only once a deck has been uploaded,
    // exactly as it does in production.
    const input = document.querySelector("[data-deck-file-input]") as HTMLInputElement;
    Object.defineProperty(input, "files", { configurable: true, value: [deck] });
    await act(async () => {
      fireEvent.change(input);
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      await allStarted;
    });
    // Let every macrotask-dispatched request land before counting.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(recommendQueries.sort()).toEqual(["Opening slide", "Results slide"]);

    view.unmount();
    expect(requestSignals.length).toBeGreaterThan(0);
    expect(requestSignals.every((signal) => signal.aborted)).toBe(true);
  });

  test("keeps an approved internal card when external fetch produces no safe card", async () => {
    let signalRecommended: () => void = () => {
      throw new Error("recommendation signal was not installed");
    };
    const recommended = new Promise<void>((resolve) => {
      signalRecommended = resolve;
    });
    const firstSlide = workspacePresentation.slides[0];
    if (firstSlide === undefined) throw new Error("workspace fixture requires one slide");
    const presentation = {
      ...workspacePresentation,
      manifestHash: "a".repeat(64),
      slides: [firstSlide],
    };
    const client = workspaceClient({
      async recommend() {
        signalRecommended();
        return {
          outcome: "RECOMMEND",
          recommendation: { claim: "Internal evidence remains available." },
          evidence: [
            {
              kind: "INTERNAL",
              evidenceId: "internal:object-1:revision-1",
              title: "Internal source",
              sourceUrl: null,
              sourceDate: null,
              rights: "APPROVED",
            },
          ],
          completedAtMs: 100,
          latencyMs: 20,
        };
      },
    });
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider initialAuthenticated initialPresentation={presentation} client={client}>
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );

    await act(async () => await recommended);
    const cards = document.querySelectorAll("[data-evidence-card]");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.getAttribute("data-evidence-kind")).toBe("INTERNAL");
    expect(cards[0]?.textContent).toContain("업로드한 자료");
    expect(cards[0]?.textContent).not.toContain("출처 정보가 없습니다.");
    expect(document.querySelector("[data-evidence-kind='EXTERNAL']")).toBeNull();
  });

  test("offers display choices and starts from one primary action", async () => {
    const slideCommands: string[] = [];
    const client = workspaceClient({
      async setSlide(_csrfToken, input) {
        slideCommands.push(input.publicSlideKey);
        return { acceptedControlRevision: "cr_1" };
      },
    });
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider
          initialAuthenticated
          initialPresentation={workspacePresentation}
          initialDisplayBindingEpoch="dbe_1"
          client={client}
        >
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );

    switchToEnglish();
    expect(
      within(document.body).getByRole("button", { name: "Open presentation screen first" }),
    ).toBeTruthy();
    expect(
      within(document.body).getByRole("button", { name: "Copy presentation screen link" }),
    ).toBeTruthy();
    const start = within(document.body).getByRole("button", { name: "Start presentation" });
    expect(start).toBeTruthy();
    expect(document.querySelector("[data-presentation-state='READY']")).toBeTruthy();
    await act(async () => {
      fireEvent.click(start);
    });
    expect(slideCommands).toEqual(["slide_one"]);
    expect(document.querySelector("[data-presentation-state='PRESENTING']")).toBeTruthy();
  });

  function railWorkspace() {
    return render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider
          initialAuthenticated
          initialPresentation={workspacePresentation}
          initialDisplayBindingEpoch="dbe_1"
          client={workspaceClient({
            async setSlide() {
              return { acceptedControlRevision: "cr_1" };
            },
          })}
        >
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );
  }

  test("keeps preparation surfaces directly visible before the talk starts", () => {
    railWorkspace();
    expect(document.querySelector("[data-cockpit-phase='PREPARING']")).toBeTruthy();
    const reference = document.querySelector("[data-reference-documents-status]");
    expect(reference).toBeTruthy();
    expect(reference?.closest("details")).toBeNull();
    const audience = document.querySelector("[data-audience-screen-panel]");
    expect(audience).toBeTruthy();
    expect(audience?.closest("details")).toBeNull();
  });

  test("folds preparation surfaces behind a reachable disclosure once the talk starts", async () => {
    railWorkspace();
    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: "발표 시작" }));
    });
    expect(document.querySelector("[data-cockpit-phase='PRESENTING']")).toBeTruthy();
    const drawer = document.querySelector("[data-preparation-surfaces]");
    expect(drawer).toBeInstanceOf(HTMLDetailsElement);
    expect((drawer as HTMLDetailsElement).open).toBe(false);
    // Receded never means removed: real talks go sideways, so both surfaces stay in the tree.
    expect(drawer?.querySelector("[data-reference-documents-status]")).toBeTruthy();
    expect(drawer?.querySelector("[data-audience-screen-panel]")).toBeTruthy();
  });

  test("shows coaching as its opt-in control until the presenter opts in", async () => {
    const text = {
      title: "코칭 지표",
      optIn: "코칭 지표 표시",
      mute: "코칭 표시 음소거",
      unavailable: "측정 불가",
      currentPace: "현재 30초",
      previousPace: "직전 30초",
      delta: "변화량",
      cueCount: "큐 횟수",
    };
    const noop = () => {};
    const view = render(
      <CoachingDisplay
        state={createCoachingState()}
        text={text}
        wordTimingCapable
        onOptInChange={noop}
        onMuteChange={noop}
      />,
    );
    expect(document.querySelector("[data-coaching-folded='FOLDED']")).toBeTruthy();
    expect(within(document.body).getByRole("checkbox", { name: text.optIn })).toBeTruthy();
    // Collapsed means only the opt-in control: no mute surface, nothing else holding height.
    expect(within(document.body).queryByRole("checkbox", { name: text.mute })).toBeNull();

    view.rerender(
      <CoachingDisplay
        state={reduceCoachingState(createCoachingState(), { kind: "OPT_IN", enabled: true }).state}
        text={text}
        wordTimingCapable
        onOptInChange={noop}
        onMuteChange={noop}
      />,
    );
    expect(document.querySelector("[data-coaching-folded]")).toBeNull();
    expect(within(document.body).getByRole("checkbox", { name: text.mute })).toBeTruthy();
  });

  test("redirects a signed-out visitor away from every private route", () => {
    renderConsole("/session", false);

    expect(
      within(document.body).getByRole("heading", { name: "Sign in to Impromptu" }),
    ).toBeTruthy();
    expect(within(document.body).queryByRole("heading", { name: "Session controls" })).toBeNull();
  });

  test("keeps the sign-in route public-only once authenticated", () => {
    renderConsole("/sign-in", true);

    expect(
      within(document.body).getByRole("heading", { name: "Upload your presentation" }),
    ).toBeTruthy();
    expect(
      within(document.body).queryByRole("heading", { name: "Sign in to Impromptu" }),
    ).toBeNull();
  });

  test("renders no dead navigation entries on the workspace", () => {
    renderConsole("/", true);

    // The retired public-approval flow must not appear in customer navigation; the workspace
    // route itself needs no nav entry because it is already the current location.
    expect(within(document.body).queryByRole("link", { name: "Evidence approval" })).toBeNull();
    expect(
      within(document.body).queryByRole("link", { name: "Presentation preparation" }),
    ).toBeNull();
    expect(within(document.body).queryByRole("alert")).toBeNull();
    expect(
      within(document.body).getByRole("heading", { name: "Upload your presentation" }),
    ).toBeTruthy();
  });

  test("disables co-resident convenience after the public surface observes a private pixel", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider initialAuthenticated>
          <ConsoleRoutes coResident />
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(document.querySelector("[data-co-resident-state='ENABLED']")).toBeTruthy();
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("impromptu:public-surface-observation", {
          detail: { privatePixelCount: 1 },
        }),
      );
    });
    expect(within(document.body).queryByRole("navigation")).toBeNull();
    expect(document.querySelector("[data-co-resident-state='DISABLED']")).toBeTruthy();
  });

  test("observes controller background through the real visibility listener", async () => {
    renderConsole("/", true);
    await act(async () => {
      document.dispatchEvent(
        new CustomEvent("visibilitychange", { detail: { state: "BACKGROUND" } }),
      );
    });
    expect(document.querySelector("[data-controller-lifecycle='BACKGROUND']")).toBeTruthy();
  });

  test("creates an account through the typed client and signs in without storage", async () => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    const calls: Array<{ operation: "SIGN_UP" | "SIGN_IN"; username: string; password: string }> =
      [];
    let signalSignedIn: () => void = () => {
      throw new Error("sign-in signal was not installed");
    };
    const signedIn = new Promise<void>((resolve) => {
      signalSignedIn = resolve;
    });
    const client = workspaceClient({
      async signUp(username, password) {
        calls.push({ operation: "SIGN_UP", username, password });
        return { account: { accountId: "account_new" } };
      },
      async signIn(username, password) {
        calls.push({ operation: "SIGN_IN", username, password });
        signalSignedIn();
        return {
          account: { accountId: "account_new", actorId: "actor_new" },
          expiresAtMs: 10_000,
          csrfToken: "csrf-new",
        };
      },
    });
    render(
      <MemoryRouter initialEntries={["/sign-up"]}>
        <AuthProvider client={client}>
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );

    const usernameInput = document.querySelector("[data-sign-up-username]");
    const passwordInput = document.querySelector("[data-sign-up-password]");
    const submit = document.querySelector("[data-sign-up-submit]");
    if (
      !(usernameInput instanceof HTMLInputElement) ||
      !(passwordInput instanceof HTMLInputElement) ||
      !(submit instanceof HTMLButtonElement)
    ) {
      throw new Error("sign-up controls are missing");
    }
    expect(usernameInput.autocomplete).toBe("username");
    expect(passwordInput.type).toBe("password");
    expect(passwordInput.autocomplete).toBe("new-password");
    fireEvent.change(usernameInput, { target: { value: "presenter-new" } });
    fireEvent.change(passwordInput, { target: { value: "new-password" } });
    await act(async () => {
      fireEvent.click(submit);
      await signedIn;
    });

    expect(calls).toEqual([
      { operation: "SIGN_UP", username: "presenter-new", password: "new-password" },
      { operation: "SIGN_IN", username: "presenter-new", password: "new-password" },
    ]);
    expect(document.querySelector("[data-upload-dropzone]")).toBeTruthy();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  test("shows a duplicate-username failure without signing in", async () => {
    let signInCount = 0;
    let signalRegistrationAttempted: () => void = () => {
      throw new Error("registration signal was not installed");
    };
    const registrationAttempted = new Promise<void>((resolve) => {
      signalRegistrationAttempted = resolve;
    });
    const client = workspaceClient({
      async signUp() {
        signalRegistrationAttempted();
        throw new AccountRegistrationError("USERNAME_TAKEN", 409);
      },
      async signIn() {
        signInCount += 1;
        throw new Error("sign-in must not run after rejected registration");
      },
    });
    render(
      <MemoryRouter initialEntries={["/sign-up"]}>
        <AuthProvider client={client}>
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );

    const usernameInput = document.querySelector("[data-sign-up-username]");
    const passwordInput = document.querySelector("[data-sign-up-password]");
    const submit = document.querySelector("[data-sign-up-submit]");
    if (
      !(usernameInput instanceof HTMLInputElement) ||
      !(passwordInput instanceof HTMLInputElement) ||
      !(submit instanceof HTMLButtonElement)
    ) {
      throw new Error("sign-up controls are missing");
    }
    fireEvent.change(usernameInput, { target: { value: "presenter-taken" } });
    fireEvent.change(passwordInput, { target: { value: "new-password" } });
    await act(async () => {
      fireEvent.click(submit);
      await registrationAttempted;
    });

    expect(document.querySelector("[data-sign-up-error='USERNAME_TAKEN']")).toBeTruthy();
    expect(document.querySelector("[data-sign-up-error]")?.textContent?.length).toBeGreaterThan(0);
    expect(document.querySelector("[data-sign-up-submit]")).toBeTruthy();
    expect(document.querySelector("[data-upload-dropzone]")).toBeNull();
    expect(signInCount).toBe(0);
  });

  test("passes username and password through the typed session client without storage", async () => {
    const receivedCredentials: Array<{ username: string; password: string }> = [];
    let resolveSignIn: (session: AccountSessionView) => void = () => {
      throw new Error("sign-in signal was not installed");
    };
    const signInCompleted = new Promise<AccountSessionView>((resolve) => {
      resolveSignIn = resolve;
    });
    const client: ConsoleSessionClient = {
      async signUp() {
        throw new Error("not used");
      },
      signIn(username, password) {
        receivedCredentials.push({ username, password });
        return signInCompleted;
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
    };
    render(
      <MemoryRouter initialEntries={["/sign-in"]}>
        <AuthProvider client={client}>
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );

    const usernameInput = document.querySelector("[data-sign-in-username]");
    const passwordInput = document.querySelector("[data-sign-in-password]");
    const submit = document.querySelector("[data-sign-in-submit]");
    if (
      !(usernameInput instanceof HTMLInputElement) ||
      !(passwordInput instanceof HTMLInputElement) ||
      !(submit instanceof HTMLButtonElement)
    ) {
      throw new Error("sign-in controls are missing");
    }
    expect(usernameInput.autocomplete).toBe("username");
    expect(passwordInput.type).toBe("password");
    expect(passwordInput.autocomplete).toBe("current-password");
    expect(submit.disabled).toBe(true);
    fireEvent.change(usernameInput, { target: { value: "presenter-alpha" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(passwordInput, { target: { value: "transient-password" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await act(async () => {
      resolveSignIn({
        account: { accountId: "account_alpha", actorId: "actor_alpha" },
        expiresAtMs: 10_000,
        csrfToken: "csrf-alpha",
      });
      await signInCompleted;
    });
    expect(document.querySelector("[data-upload-dropzone]")).toBeTruthy();
    expect(receivedCredentials).toEqual([
      { username: "presenter-alpha", password: "transient-password" },
    ]);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  test("the retired live-approval route never reads or approves candidates", async () => {
    const approvals: Array<{ candidateId: string; snapshotHash: string }> = [];
    const loadEvents: Array<Record<string, unknown>> = [];
    const observeLoad = (event: Event) => {
      if (
        event instanceof CustomEvent &&
        typeof event.detail === "object" &&
        event.detail !== null
      ) {
        loadEvents.push(event.detail as Record<string, unknown>);
      }
    };
    window.addEventListener("impromptu:approval-load", observeLoad);
    let snapshotReads = 0;
    const snapshot = {
      authoritativeSnapshotHash: "snapshot-hash-1",
      presentationSessionId: "ps_live-ui",
      presentationSessionEpoch: "pse_1",
      publicationPolicyVersion: "publication-policy-1",
      publicationAuthorityId: "pubauth_live-ui",
      publicCardRevision: "pcr_0",
      livePublicEnabled: true,
      candidates: [
        {
          candidateId: "candidate_live-ui",
          candidateVersion: "candidate-version-1",
          candidateRevision: "candrev_1",
          claimText: "Fresh verified claim",
          evidenceExcerpt: "Authoritative support",
          occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
        },
      ],
    } as const;
    const client: ConsoleSessionClient = {
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
        snapshotReads += 1;
        return snapshot;
      },
      async approveLiveCandidate(_csrfToken, authoritative, candidate) {
        approvals.push({
          candidateId: candidate.candidateId,
          snapshotHash: authoritative.authoritativeSnapshotHash,
        });
      },
      async approveDisplay() {
        throw new Error("not used");
      },
      async setSlide() {
        throw new Error("not used");
      },
    };
    render(
      <MemoryRouter initialEntries={["/live-publication"]}>
        <AuthProvider
          initialAuthenticated
          initialPresentation={{
            presentationSessionId: "ps_live-ui",
            presentationSessionEpoch: "pse_1",
            deckVersion: "deck_live-ui",
            slides: [],
          }}
          client={client}
        >
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );

    await act(async () => {});
    // The retired public-approval surface renders only the guide-and-return step: no snapshot
    // read, no approve control, no approval request or settlement ever leaves the client.
    expect(snapshotReads).toBe(0);
    expect(approvals).toEqual([]);
    expect(document.querySelector("[data-live-publication-interstitial]")).toBeTruthy();
    expect(within(document.body).queryByText("Fresh verified claim")).toBeNull();
    expect(within(document.body).queryByRole("button", { name: "카드 승인" })).toBeNull();
    expect(loadEvents.map(({ type }) => type)).toEqual([]);
    window.removeEventListener("impromptu:approval-load", observeLoad);
  });

  test("uses the active presentation without asking for a session id", async () => {
    const activePresentation: ActivePresentationView = {
      presentationSessionId: "ps_active",
      presentationSessionEpoch: "pse_1",
      deckVersion: "deck_active",
      slides: [],
    };
    let loadedPresentationId = "";
    const client: ConsoleSessionClient = {
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
      async readLiveCandidates(presentationSessionId) {
        // The retired route must never read the candidate snapshot: the route renders the
        // guide-and-return interstitial regardless of the active presentation.
        loadedPresentationId = presentationSessionId;
        return {
          authoritativeSnapshotHash: "snapshot-active",
          presentationSessionId,
          presentationSessionEpoch: "pse_1",
          publicationPolicyVersion: "policy_1",
          publicationAuthorityId: "authority_1",
          publicCardRevision: "pcr_0",
          livePublicEnabled: true,
          candidates: [],
        };
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
    };

    render(
      <MemoryRouter initialEntries={["/live-publication"]}>
        <AuthProvider initialAuthenticated initialPresentation={activePresentation} client={client}>
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );

    switchToEnglish();
    await act(async () => {});
    expect(loadedPresentationId).toBe("");
    expect(document.querySelector("[data-live-publication-interstitial]")).toBeTruthy();
    expect(within(document.body).queryByRole("textbox")).toBeNull();
    expect(within(document.body).queryByRole("button", { name: "Refresh suggestions" })).toBeNull();
  });

  test("approves an audience screen and controls slides without internal ids", async () => {
    const approvals: string[] = [];
    const slideCommands: string[] = [];
    const activePresentation: ActivePresentationView = {
      presentationSessionId: "ps_active",
      presentationSessionEpoch: "pse_1",
      deckVersion: "deck_active",
      slides: [
        { publicSlideKey: "slide_one", ordinal: 1, accessibilityLabel: "Opening" },
        { publicSlideKey: "slide_two", ordinal: 2, accessibilityLabel: "Results" },
      ],
    };
    const client: ConsoleSessionClient = {
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
      async approveDisplay(_csrfToken, presentation, join) {
        approvals.push(`${presentation.presentationSessionId}:${join.displayId}`);
        return { displayBindingEpoch: "dbe_1" };
      },
      async setSlide(_csrfToken, input) {
        slideCommands.push(input.publicSlideKey);
        return { acceptedControlRevision: "cr_1" };
      },
    };
    const joinCode = btoa(
      JSON.stringify({
        displayJoinId: `join_${"a".repeat(32)}`,
        displayId: "display_room",
        displayFingerprint: "stage-browser-fingerprint",
        deckVersion: "deck_active",
        expiresAtMs: Date.now() + 60_000,
      }),
    );

    render(
      <MemoryRouter initialEntries={["/session"]}>
        <AuthProvider initialAuthenticated initialPresentation={activePresentation} client={client}>
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );

    switchToEnglish();
    fireEvent.change(within(document.body).getByLabelText("Presentation screen connection code"), {
      target: { value: joinCode },
    });
    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: "Connect with the code" }));
    });
    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: "Next slide" }));
    });

    expect(approvals).toEqual(["ps_active:display_room"]);
    expect(slideCommands).toEqual(["slide_two"]);
    expect(within(document.body).queryByText("ps_active")).toBeNull();
  });
});

describe("Console-led audience screen pairing", () => {
  // The build bakes a deployment origin (`.env` ships a tunnel URL), so pairing
  // messages must be dispatched from whatever origin the app actually resolved.
  const stageOrigin = STAGE_ORIGIN;

  function handshakeJoin(deckVersion: string, displayId = "display_room") {
    return {
      displayJoinId: `join_${"a".repeat(32)}`,
      displayId,
      displayFingerprint: "stage-browser-fingerprint",
      deckVersion,
      expiresAtMs: Date.now() + 60_000,
    };
  }

  function pairingClient(approvals: string[]): ConsoleSessionClient {
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
      async approveDisplay(_csrfToken, presentation, join) {
        approvals.push(
          `${presentation.presentationSessionId}:${join.displayId}:${join.displayJoinId}`,
        );
        return { displayBindingEpoch: "dbe_1" };
      },
      async setSlide() {
        return { acceptedControlRevision: "cr_1" };
      },
    };
  }

  function renderWorkspace(
    client: ConsoleSessionClient,
    slides: ActivePresentationView["slides"] = [],
  ) {
    return render(
      <MemoryRouter initialEntries={["/session"]}>
        <AuthProvider
          initialAuthenticated
          initialPresentation={{
            presentationSessionId: "ps_active",
            presentationSessionEpoch: "pse_1",
            deckVersion: "deck_active",
            slides,
          }}
          client={client}
        >
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );
  }

  test("opens the audience screen carrying the session deck and pairs its handshake without a typed code", async () => {
    const approvals: string[] = [];
    const openedUrls: string[] = [];
    const originalOpen = window.open;
    window.open = ((url?: string | URL) => {
      openedUrls.push(String(url));
      return {} as Window;
    }) as typeof window.open;
    renderWorkspace(pairingClient(approvals));

    try {
      await act(async () => {
        fireEvent.click(within(document.body).getByRole("button", { name: "발표 화면 미리 열기" }));
      });
      expect(openedUrls).toEqual([`${stageOrigin}/?deck=deck_active`]);

      // The opened screen reports its join back to the opener; one explicit approval follows.
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            origin: stageOrigin,
            data: { kind: "impromptu:display-join", join: handshakeJoin("deck_active") },
          }),
        );
      });
      const pairing = document.querySelector("[data-stage-pairing='DETECTED']");
      expect(pairing?.getAttribute("data-join-display-id")).toBe("display_room");

      await act(async () => {
        fireEvent.click(within(document.body).getByRole("button", { name: "이 화면 연결" }));
      });
      expect(approvals).toEqual(["ps_active:display_room:join_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
    } finally {
      window.open = originalOpen;
    }
  });

  test("never approves an audience screen without an explicit presenter action", async () => {
    const approvals: string[] = [];
    renderWorkspace(pairingClient(approvals));

    // A forged message from another origin must not register as the audience screen.
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://evil.example",
          data: { kind: "impromptu:display-join", join: handshakeJoin("deck_active") },
        }),
      );
    });
    // Even a genuine handshake only surfaces a request; approval stays behind the button.
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: stageOrigin,
          data: { kind: "impromptu:display-join", join: handshakeJoin("deck_active") },
        }),
      );
    });
    await act(async () => {});
    expect(approvals).toEqual([]);
    expect(document.querySelector("[data-stage-pairing]")?.getAttribute("data-stage-pairing")).toBe(
      "DETECTED",
    );
  });

  test("binds the screen it opened without asking the presenter to confirm twice", async () => {
    const approvals: string[] = [];
    const opened = {} as Window;
    const originalOpen = window.open;
    window.open = (() => opened) as typeof window.open;
    renderWorkspace(pairingClient(approvals));

    try {
      await act(async () => {
        fireEvent.click(within(document.body).getByRole("button", { name: "발표 화면 미리 열기" }));
      });
      // The join arrives from the very window this panel opened, so opening it already was the
      // presenter's explicit action and no second confirmation is asked for.
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            origin: stageOrigin,
            data: { kind: "impromptu:display-join", join: handshakeJoin("deck_active") },
            source: opened,
          }),
        );
      });
      await act(async () => {});
      expect(approvals).toEqual(["ps_active:display_room:join_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
      expect(
        document
          .querySelector("[data-audience-screen-panel]")
          ?.getAttribute("data-audience-screen-panel"),
      ).toBe("CONNECTED");
    } finally {
      window.open = originalOpen;
    }
  });

  test("offers exactly one control that opens the audience screen", async () => {
    const opens: string[] = [];
    const originalOpen = window.open;
    window.open = ((url?: string | URL) => {
      opens.push(String(url));
      return {} as Window;
    }) as typeof window.open;
    renderWorkspace(pairingClient([]));

    try {
      const buttons = [...document.querySelectorAll(".console-stage-actions button")];
      for (const button of buttons) {
        await act(async () => {
          fireEvent.click(button);
        });
      }
      // A second button wired to the same handler only makes the panel look like it offers a
      // choice it does not have.
      expect(opens).toHaveLength(1);
    } finally {
      window.open = originalOpen;
    }
  });

  const oneSlide: ActivePresentationView["slides"] = [
    { publicSlideKey: "slide_one", ordinal: 1, accessibilityLabel: "Opening slide" },
  ];

  function recordingClient(approvals: string[], slideCommands: string[]): ConsoleSessionClient {
    return {
      ...pairingClient(approvals),
      async setSlide(_csrfToken, input) {
        slideCommands.push(input.publicSlideKey);
        return { acceptedControlRevision: "cr_1" };
      },
    };
  }

  test("starts the presentation from one action when no screen is connected yet", async () => {
    const approvals: string[] = [];
    const slideCommands: string[] = [];
    const opened = {} as Window;
    const originalOpen = window.open;
    window.open = (() => opened) as typeof window.open;
    renderWorkspace(recordingClient(approvals, slideCommands), oneSlide);

    try {
      const start = within(document.body).getByRole("button", { name: "발표 시작" });
      // Nothing is paired yet: the single action has to open the screen, bind it, and publish.
      expect(start.hasAttribute("disabled")).toBe(false);
      await act(async () => {
        fireEvent.click(start);
      });
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            origin: stageOrigin,
            data: { kind: "impromptu:display-join", join: handshakeJoin("deck_active") },
            source: opened,
          }),
        );
      });

      expect(approvals).toEqual(["ps_active:display_room:join_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
      expect(slideCommands).toEqual(["slide_one"]);
      expect(document.querySelector("[data-presentation-state='PRESENTING']")).toBeTruthy();
    } finally {
      window.open = originalOpen;
    }
  });

  function mutableOpenStub(): {
    windows: Array<{ closed: boolean }>;
    screen(n: number): Window;
    restore(): void;
  } {
    const windows: Array<{ closed: boolean }> = [];
    const originalOpen = window.open;
    window.open = (() => {
      const child: { closed: boolean } = { closed: false };
      windows.push(child);
      return child as Window;
    }) as typeof window.open;
    return {
      windows,
      screen(n: number): Window {
        const handle = windows[n];
        if (handle === undefined) throw new Error(`screen ${n} was never opened`);
        return handle as unknown as Window;
      },
      restore() {
        window.open = originalOpen;
      },
    };
  }

  test("replaces the spent start action with an audience-screen reopen once the talk began", async () => {
    const approvals: string[] = [];
    const slideCommands: string[] = [];
    const openStub = mutableOpenStub();
    const client: ConsoleSessionClient = {
      ...recordingClient(approvals, []),
      async setSlide(_csrfToken, input) {
        slideCommands.push(input.publicSlideKey);
        return { acceptedControlRevision: "cr_1" };
      },
    };
    renderWorkspace(client, [
      { publicSlideKey: "slide_one", ordinal: 1, accessibilityLabel: "Opening slide" },
      { publicSlideKey: "slide_two", ordinal: 2, accessibilityLabel: "Results slide" },
    ]);

    try {
      await act(async () => {
        fireEvent.click(within(document.body).getByRole("button", { name: "발표 시작" }));
      });
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            origin: stageOrigin,
            data: { kind: "impromptu:display-join", join: handshakeJoin("deck_active") },
            source: openStub.screen(0),
          }),
        );
      });

      expect(slideCommands).toEqual(["slide_one"]);
      expect(document.querySelector("[data-presentation-state='PRESENTING']")).toBeTruthy();

      // The talked-started label is spent: pressing it under the old wiring re-ran show(0)
      // and yanked the room back to slide 1 mid-talk.
      await act(async () => {
        fireEvent.click(within(document.body).getByRole("button", { name: "발표 화면 다시 열기" }));
      });
      // Reopening opens a fresh screen and waits for ITS handshake; it never replays the
      // start flow, which would immediately push slide one again over the existing binding.
      expect(openStub.windows.length).toBe(2);
      expect(slideCommands).toEqual(["slide_one"]);

      // Only the brand-new screen reporting back moves anything.
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            origin: stageOrigin,
            data: { kind: "impromptu:display-join", join: handshakeJoin("deck_active") },
            source: openStub.screen(1),
          }),
        );
      });
      expect(document.querySelector("[data-presentation-state='PRESENTING']")).toBeTruthy();
    } finally {
      openStub.restore();
    }
  });

  test("reopens onto the slide the room is showing now with the freshly returned binding", async () => {
    const approvals: string[] = [];
    const slideCommands: Array<{ key: string; epoch: string }> = [];
    let approvalCount = 0;
    const openStub = mutableOpenStub();
    const client: ConsoleSessionClient = {
      ...pairingClient(approvals),
      async approveDisplay(_csrfToken, _presentation, join) {
        approvalCount += 1;
        approvals.push(join.displayId);
        return { displayBindingEpoch: approvalCount === 1 ? "dbe_first" : "dbe_reopen" };
      },
      async setSlide(_csrfToken, input) {
        slideCommands.push({
          key: input.publicSlideKey,
          epoch: input.displayBindingEpoch,
        });
        return { acceptedControlRevision: "cr_1" };
      },
    };
    renderWorkspace(client, [
      { publicSlideKey: "slide_one", ordinal: 1, accessibilityLabel: "Opening slide" },
      { publicSlideKey: "slide_two", ordinal: 2, accessibilityLabel: "Results slide" },
    ]);

    try {
      await act(async () => {
        fireEvent.click(within(document.body).getByRole("button", { name: "발표 시작" }));
      });
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            origin: stageOrigin,
            data: { kind: "impromptu:display-join", join: handshakeJoin("deck_active") },
            source: openStub.screen(0),
          }),
        );
      });
      await act(async () => {
        fireEvent.click(within(document.body).getByRole("button", { name: "다음 슬라이드" }));
      });
      // The start itself published slide one over the first binding.
      expect(slideCommands).toEqual([
        { key: "slide_one", epoch: "dbe_first" },
        { key: "slide_two", epoch: "dbe_first" },
      ]);

      await act(async () => {
        fireEvent.click(within(document.body).getByRole("button", { name: "발표 화면 다시 열기" }));
      });
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            origin: stageOrigin,
            data: { kind: "impromptu:display-join", join: handshakeJoin("deck_active") },
            source: openStub.screen(1),
          }),
        );
      });
      // The rebinding lands on the presenter's CURRENT slide through the newly returned
      // binding, never back on slide one, and never on the superseded epoch.
      expect(slideCommands).toEqual([
        { key: "slide_one", epoch: "dbe_first" },
        { key: "slide_two", epoch: "dbe_first" },
        { key: "slide_two", epoch: "dbe_reopen" },
      ]);
    } finally {
      openStub.restore();
    }
  });

  test("keeps the live controls honest while offering the reopen action", async () => {
    const approvals: string[] = [];
    const openStub = mutableOpenStub();
    // 발표 종료 must be enabled after start, which requires the capability on the client too.
    const client: ConsoleSessionClient = {
      ...recordingClient(approvals, []),
      async endPresentationAndAwaitReport() {
        throw new Error("not used in this assertion");
      },
    };
    renderWorkspace(client, [
      { publicSlideKey: "slide_one", ordinal: 1, accessibilityLabel: "Opening slide" },
      { publicSlideKey: "slide_two", ordinal: 2, accessibilityLabel: "Results slide" },
    ]);

    try {
      await act(async () => {
        fireEvent.click(within(document.body).getByRole("button", { name: "발표 시작" }));
      });
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            origin: stageOrigin,
            data: { kind: "impromptu:display-join", join: handshakeJoin("deck_active") },
            source: openStub.screen(0),
          }),
        );
      });

      expect(document.querySelector("[data-presentation-state='READY']")).toBeNull();
      expect(document.querySelector("[data-presentation-state='PRESENTING']")).toBeTruthy();
      const end = within(document.body).getByRole("button", { name: "발표 종료" });
      expect(end.hasAttribute("disabled")).toBe(false);
    } finally {
      openStub.restore();
    }
  });

  test("surfaces a closed audience screen as DISCONNECTED with its reopen affordance", async () => {
    const approvals: string[] = [];
    const openStub = mutableOpenStub();
    renderWorkspace(recordingClient(approvals, []), [
      { publicSlideKey: "slide_one", ordinal: 1, accessibilityLabel: "Opening slide" },
    ]);

    try {
      await act(async () => {
        fireEvent.click(within(document.body).getByRole("button", { name: "발표 화면 미리 열기" }));
      });
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            origin: stageOrigin,
            data: { kind: "impromptu:display-join", join: handshakeJoin("deck_active") },
            source: openStub.screen(0),
          }),
        );
      });
      expect(approvals).toHaveLength(1);

      // No cross-origin close event exists, so detection rides the opener's focus/blur
      // signals; the deterministic trigger here mirrors the browser firing them.
      await act(async () => {
        const child = openStub.windows[0];
        if (child === undefined) throw new Error("opened screen handle missing");
        child.closed = true;
        window.dispatchEvent(new Event("blur"));
      });
      expect(document.body.textContent).toContain("발표 화면 연결이 끊겼습니다.");
      expect(
        within(document.body).getByRole("button", { name: "발표 화면 다시 열기" }),
      ).toBeTruthy();
    } finally {
      openStub.restore();
    }
  });

  test("explains a blocked audience screen instead of starting the presentation", async () => {
    const slideCommands: string[] = [];
    const originalOpen = window.open;
    window.open = (() => null) as typeof window.open;
    renderWorkspace(recordingClient([], slideCommands), oneSlide);

    try {
      await act(async () => {
        fireEvent.click(within(document.body).getByRole("button", { name: "발표 시작" }));
      });

      expect(slideCommands).toEqual([]);
      expect(document.body.textContent).toContain("브라우저가 발표 화면 창을 막았습니다.");
      expect(within(document.body).getByRole("button", { name: "다시 시도" })).toBeTruthy();
      expect(document.querySelector("[data-presentation-state='READY']")).toBeTruthy();
    } finally {
      window.open = originalOpen;
    }
  });

  test("keeps the connection fallbacks folded away until a join needs a decision", async () => {
    renderWorkspace(pairingClient([]), oneSlide);

    const collapsed = document.querySelector(".console-advanced-connect");
    expect(collapsed).toBeInstanceOf(HTMLDetailsElement);
    expect((collapsed as HTMLDetailsElement).open).toBe(false);
    // The manual code path lives in there rather than on the happy path.
    expect(within(collapsed as HTMLElement).getByText("발표 화면 연결 코드")).toBeTruthy();

    // A join from a window this Console did not open cannot bind itself, so it has to surface.
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: stageOrigin,
          data: { kind: "impromptu:display-join", join: handshakeJoin("deck_active") },
        }),
      );
    });

    expect((document.querySelector(".console-advanced-connect") as HTMLDetailsElement).open).toBe(
      true,
    );
    expect(document.querySelector("[data-stage-pairing='DETECTED']")).not.toBeNull();
  });

  // A binding minted by a previous backend process (or rotated by another audience bind) is
  // still sitting in React context; the server answers STALE_DISPLAY_BINDING for every command
  // that carries it. These tests pin the recovery contract around that exact reason.
  const staleBindingSlides: ActivePresentationView["slides"] = [
    { publicSlideKey: "slide_one", ordinal: 1, accessibilityLabel: "Opening slide" },
    { publicSlideKey: "slide_two", ordinal: 2, accessibilityLabel: "Results slide" },
  ];

  function renderStaleBindingWorkspace(client: ConsoleSessionClient) {
    return render(
      <MemoryRouter initialEntries={["/session"]}>
        <AuthProvider
          initialAuthenticated
          initialPresentation={{
            presentationSessionId: "ps_active",
            presentationSessionEpoch: "pse_1",
            deckVersion: "deck_active",
            slides: staleBindingSlides,
          }}
          initialDisplayBindingEpoch="dbe_9"
          client={client}
        >
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );
  }

  function rejectingSlideClient(
    behavior: (input: { publicSlideKey: string }) => void,
  ): ConsoleSessionClient {
    return {
      ...pairingClient([]),
      async setSlide(_csrfToken, input) {
        behavior(input);
        throw new PlaybackCommandRejectedError("STALE_DISPLAY_BINDING");
      },
    };
  }

  test("recovers when the held display binding is dead instead of stranding the presenter", async () => {
    const slideCommands: string[] = [];
    const opens: number[] = [];
    const originalOpen = window.open;
    window.open = ((_url?: string | URL) => {
      opens.push(1);
      return {} as Window;
    }) as typeof window.open;
    renderStaleBindingWorkspace(
      rejectingSlideClient((input) => slideCommands.push(input.publicSlideKey)),
    );

    try {
      await act(async () => {
        fireEvent.click(within(document.body).getByRole("button", { name: "발표 시작" }));
      });

      // The doomed command really went out once — the defect was never that it was skipped.
      expect(slideCommands).toEqual(["slide_one"]);
      expect(document.querySelector("[data-presentation-state='PRESENTING']")).toBeNull();
      // Honest copy replaces the silent failure, and the surface stops claiming a connected screen.
      expect(document.body.textContent).toContain("발표 화면 연결이 만료되었습니다.");
      expect(document.body.textContent).toContain("발표 화면은 이 창 옆에 열립니다.");
      // Recovery must not auto-open: browsers only honour window.open inside a user gesture.
      expect(opens).toHaveLength(0);
    } finally {
      window.open = originalOpen;
    }
  });

  test("starts normally on the press after a dead-binding recovery", async () => {
    let commandCount = 0;
    const slideCommands: string[] = [];
    const approvals: string[] = [];
    const openStub = mutableOpenStub();
    const recoveredClient: ConsoleSessionClient = {
      ...pairingClient(approvals),
      async setSlide(_csrfToken, input) {
        commandCount += 1;
        if (commandCount === 1) {
          throw new PlaybackCommandRejectedError("STALE_DISPLAY_BINDING");
        }
        slideCommands.push(input.publicSlideKey);
        return { acceptedControlRevision: `cr_${commandCount}` };
      },
    };
    renderStaleBindingWorkspace(recoveredClient);

    try {
      await act(async () => {
        fireEvent.click(within(document.body).getByRole("button", { name: "발표 시작" }));
      });
      expect(document.querySelector("[data-presentation-state='PRESENTING']")).toBeNull();

      // The anti-stranding guarantee: after clearing the dead epoch, the very next press takes
      // the ordinary open-and-bind path — window.open runs inside this click — and starts.
      await act(async () => {
        fireEvent.click(within(document.body).getByRole("button", { name: "발표 시작" }));
      });
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            origin: stageOrigin,
            data: { kind: "impromptu:display-join", join: handshakeJoin("deck_active") },
            source: openStub.screen(0),
          }),
        );
      });

      expect(openStub.windows.length).toBe(1);
      expect(approvals).toEqual(["ps_active:display_room:join_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
      expect(slideCommands).toEqual(["slide_one"]);
      expect(document.querySelector("[data-presentation-state='PRESENTING']")).toBeTruthy();
    } finally {
      openStub.restore();
    }
  });

  test("keeps a REVISION_MISMATCH rejection on the existing slide-failure path", async () => {
    const slideCommands: string[] = [];
    const revisionClient: ConsoleSessionClient = {
      ...pairingClient([]),
      async setSlide(_csrfToken, input) {
        slideCommands.push(input.publicSlideKey);
        throw new PlaybackCommandRejectedError("REVISION_MISMATCH");
      },
    };
    renderStaleBindingWorkspace(revisionClient);

    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: "발표 시작" }));
    });

    expect(slideCommands).toEqual(["slide_one"]);
    expect(document.querySelector("[data-presentation-state='PRESENTING']")).toBeNull();
    // The pre-existing generic handling stands, and the binding survives: REVISION_MISMATCH says
    // nothing about the display binding, and controlRevisionRef owns that retry path.
    expect(document.body.textContent).toContain("슬라이드 변경에 실패했습니다.");
    expect(document.body.textContent).not.toContain("발표 화면 연결이 만료되었습니다.");
    expect(document.body.textContent).toContain("발표 화면 연결됨");
  });

  test("clears a dead binding surfaced during slide navigation instead of looping", async () => {
    const slideCommands: string[] = [];
    renderStaleBindingWorkspace(
      rejectingSlideClient((input) => slideCommands.push(input.publicSlideKey)),
    );

    // The panel cannot know the binding is dead yet, so next stays enabled and goes out once.
    const next = within(document.body).getByRole("button", { name: "다음 슬라이드" });
    expect(next.hasAttribute("disabled")).toBe(false);
    await act(async () => {
      fireEvent.click(next);
    });

    expect(slideCommands).toEqual(["slide_two"]);
    expect(document.body.textContent).toContain("발표 화면 연결이 만료되었습니다.");
    // One surfacing, no loop: with the epoch gone the relative controls disable themselves.
    expect(
      within(document.body).getByRole("button", { name: "다음 슬라이드" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      within(document.body).getByRole("button", { name: "이전 슬라이드" }).hasAttribute("disabled"),
    ).toBe(true);
  });
});
