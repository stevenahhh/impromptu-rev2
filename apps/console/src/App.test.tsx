import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());

const { act, cleanup, fireEvent, render, within } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");

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
  type RecommendationOutcome,
  SessionReportClientError,
  type SessionReportView,
} from "./session-client";

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
    expect(reportDom).toContain("준비된 근거");
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

    expect(within(document.body).getByRole("heading", { name: "비공개 발표 제어" })).toBeTruthy();
    expect(document.querySelector("[data-sign-in-username]")).toBeTruthy();
    expect(document.querySelector("[data-sign-in-password]")).toBeTruthy();

    cleanup();
    renderConsole("/live-publication", true, "ko");

    expect(within(document.body).getByRole("heading", { name: "실시간 근거 승인" })).toBeTruthy();
    expect(within(document.body).getByText("신뢰 가능한 최신 상태")).toBeTruthy();
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
    expect(within(document.body).getByRole("heading", { name: "발표 워크스페이스" })).toBeTruthy();

    fireEvent.click(within(picker).getByRole("button", { name: "English" }));
    expect(document.documentElement.lang).toBe("en");
    expect(
      within(document.body).getByRole("heading", { name: "Presentation workspace" }),
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
      within(document.body).getByRole("heading", { name: "Presentation workspace" }),
    ).toBeTruthy();
    expect(within(document.body).getAllByText("Opening slide").length).toBeGreaterThan(0);
  });

  test("renders an uploaded slide through the same-origin asset path", async () => {
    const presentation: ActivePresentationView = {
      ...workspacePresentation,
      slides: [
        {
          publicSlideKey: "slide_one",
          ordinal: 1,
          accessibilityLabel: "Opening slide",
          image: {
            url: "http://127.0.0.1:3002/v1/deck-assets/manifest/slides/slide-1.svg",
            contentHash: "a".repeat(64),
            width: 1600,
            height: 900,
          },
        },
      ],
    };
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider initialAuthenticated initialPresentation={presentation}>
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );

    const image = document.querySelector("[data-rendered-slide] img");
    expect(image?.getAttribute("src")).toBe("/v1/deck-assets/manifest/slides/slide-1.svg");
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
    expect(cards[0]?.textContent).toContain("권리 미확인(UNKNOWN)");
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
    expect(cards[0]?.textContent).toContain("내부 근거 · 승인됨(APPROVED)");
    expect(cards[0]?.textContent).toContain("출처 정보 없음");
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
      within(document.body).getByRole("button", { name: "Open audience screen first" }),
    ).toBeTruthy();
    expect(
      within(document.body).getByRole("button", { name: "Copy audience screen link" }),
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

  test("redirects a signed-out visitor away from every private route", () => {
    renderConsole("/session", false);

    expect(
      within(document.body).getByRole("heading", { name: "Private presentation control" }),
    ).toBeTruthy();
    expect(within(document.body).queryByRole("heading", { name: "Session controls" })).toBeNull();
  });

  test("keeps the sign-in route public-only once authenticated", () => {
    renderConsole("/sign-in", true);

    expect(
      within(document.body).getByRole("heading", { name: "Start a presentation" }),
    ).toBeTruthy();
    expect(
      within(document.body).queryByRole("heading", { name: "Private presentation control" }),
    ).toBeNull();
  });

  test("renders an explicit private navigation landmark", () => {
    renderConsole("/", true);

    expect(
      within(document.body).getByRole("navigation", { name: "Private workspace" }),
    ).toBeTruthy();
    expect(within(document.body).getByRole("link", { name: "Evidence approval" })).toBeTruthy();
    expect(
      within(document.body).queryByRole("link", { name: "Presentation workspace" }),
    ).toBeNull();
    expect(within(document.body).queryByRole("alert")).toBeNull();
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
    expect(usernameInput).toBeInstanceOf(HTMLInputElement);
    expect(passwordInput).toBeInstanceOf(HTMLInputElement);
    expect(submit).toBeInstanceOf(HTMLButtonElement);
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

  test("approves a live candidate only from the loaded authoritative snapshot", async () => {
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
    let loadedSnapshot: (() => void) | undefined;
    const loaded = new Promise<void>((resolve) => {
      loadedSnapshot = resolve;
    });
    let approvedCandidate: (() => void) | undefined;
    const approved = new Promise<void>((resolve) => {
      approvedCandidate = resolve;
    });
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
      async readLiveCandidates(presentationSessionId) {
        expect(presentationSessionId).toBe("ps_live-ui");
        loadedSnapshot?.();
        return snapshot;
      },
      async approveLiveCandidate(_csrfToken, authoritative, candidate) {
        approvals.push({
          candidateId: candidate.candidateId,
          snapshotHash: authoritative.authoritativeSnapshotHash,
        });
        approvedCandidate?.();
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

    await act(async () => await loaded);
    expect(within(document.body).getByText("Fresh verified claim")).toBeTruthy();

    fireEvent.click(within(document.body).getByRole("button", { name: "실시간 카드 승인" }));
    await act(async () => await approved);
    expect(approvals).toEqual([
      { candidateId: "candidate_live-ui", snapshotHash: "snapshot-hash-1" },
    ]);
    expect(within(document.body).queryByText("Fresh verified claim")).toBeNull();
    expect(loadEvents.map(({ type }) => type)).toEqual([
      "SNAPSHOT_LOADED",
      "APPROVAL_REQUESTED",
      "APPROVAL_SETTLED",
    ]);
    expect(loadEvents[1]?.approvalId).toBe(loadEvents[2]?.approvalId);
    expect(loadEvents[2]?.outcome).toBe("PUBLISHED");
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
    expect(loadedPresentationId).toBe("ps_active");
    expect(within(document.body).queryByRole("textbox")).toBeNull();
    expect(within(document.body).getByRole("button", { name: "Refresh suggestions" })).toBeTruthy();
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
    fireEvent.change(within(document.body).getByLabelText("Audience screen connection code"), {
      target: { value: joinCode },
    });
    await act(async () => {
      fireEvent.click(
        within(document.body).getByRole("button", { name: "Approve audience screen" }),
      );
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
  const stageOrigin = "http://localhost:4174";

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
        fireEvent.click(within(document.body).getByRole("button", { name: "청중 화면 미리 열기" }));
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
        fireEvent.click(within(document.body).getByRole("button", { name: "연결 요청 승인" }));
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
        fireEvent.click(within(document.body).getByRole("button", { name: "청중 화면 미리 열기" }));
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
      expect(document.body.textContent).toContain("브라우저가 청중 화면을 열지 못했습니다.");
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
    expect(within(collapsed as HTMLElement).getByText("청중 화면 연결 코드")).toBeTruthy();

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
});
