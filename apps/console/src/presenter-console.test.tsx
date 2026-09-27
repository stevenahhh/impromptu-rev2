import { afterEach, describe, expect, test } from "bun:test";
import { registerDom } from "@impromptu/test-harness";

registerDom();

const { act, cleanup, fireEvent, render, within } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");

const { AuthProvider, ConsoleRoutes } = await import("./App");
const { messages } = await import("./i18n");

import type {
  ActivePresentationView,
  ConsoleSessionClient,
  SessionReportView,
} from "./session-client";
import { PlaybackCommandRejectedError } from "./session-client";

afterEach(cleanup);

const slides: ActivePresentationView["slides"] = [
  { publicSlideKey: "slide_one", ordinal: 1, accessibilityLabel: "Opening slide" },
  { publicSlideKey: "slide_two", ordinal: 2, accessibilityLabel: "Results slide" },
];

function routineClient(): ConsoleSessionClient {
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
    async setSlide() {
      return { acceptedControlRevision: "cr_1" };
    },
  };
}

function renderSession(client: ConsoleSessionClient, displayBindingEpoch: string) {
  render(
    <MemoryRouter initialEntries={["/session"]}>
      <AuthProvider
        initialAuthenticated
        initialPresentation={{
          presentationSessionId: "ps_active",
          presentationSessionEpoch: "pse_1",
          deckVersion: "deck_active",
          slides,
        }}
        initialDisplayBindingEpoch={displayBindingEpoch}
        client={client}
      >
        <ConsoleRoutes />
      </AuthProvider>
    </MemoryRouter>,
  );
}

async function startTalk(): Promise<void> {
  await act(async () => {
    fireEvent.click(within(document.body).getByRole("button", { name: "발표 시작" }));
  });
}

describe("presenter console mid-talk surfaces", () => {
  test("presenting with a bound screen reduces the audience panel to badge plus copy link", async () => {
    renderSession(routineClient(), "dbe_live");
    await startTalk();

    const panel = document.querySelector("[data-audience-screen-panel='CONNECTED']");
    expect(panel).toBeTruthy();
    expect(panel?.querySelector(".ui-badge--success")?.textContent).toContain(
      messages("ko").audienceConnected,
    );
    expect(panel?.querySelector("[data-copy-stage]")).toBeTruthy();
    expect(panel?.querySelector("[data-copy-stage]")?.textContent).toContain("발표 화면 링크 복사");
    expect(document.querySelector("[data-stage-open]")).toBeNull();
    expect(document.querySelector("[data-display-approve]")).toBeNull();
    expect(document.querySelector(".console-advanced-connect")).toBeNull();
  });

  test("presenting without a bound screen keeps the full recovery surface reachable", async () => {
    let commands = 0;
    const client: ConsoleSessionClient = {
      ...routineClient(),
      async setSlide(_csrfToken, _input) {
        commands += 1;
        if (commands === 2) {
          // The start command lands; the next press outlives the binding.
          throw new PlaybackCommandRejectedError("STALE_DISPLAY_BINDING");
        }
        return { acceptedControlRevision: `cr_${commands}` };
      },
    };
    renderSession(client, "dbe_dead");
    await startTalk();
    expect(document.querySelector("[data-presentation-state='PRESENTING']")).toBeTruthy();

    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: "다음 슬라이드" }));
    });

    expect(document.querySelector("[data-playback-status='PROBLEM']")).toBeTruthy();
    const panel = document.querySelector("[data-audience-screen-panel='PENDING']");
    expect(panel).toBeTruthy();
    expect(panel?.querySelector("[data-stage-open]")).toBeTruthy();
    expect(panel?.querySelector(".console-advanced-connect")).toBeTruthy();
    expect(panel?.querySelector(".console-field input")).toBeTruthy();
    expect(panel?.textContent).toContain(messages("ko").connectLead);
    // The pending surface offers the copy-link action and the invitation flow; it is not
    // collapsed into a copy-only state and no invitation is minted until requested.
    expect(panel?.querySelector("[data-copy-stage]")).toBeTruthy();
    expect(panel?.querySelector("[data-stage-invitation]")).toBeNull();
  });

  test("the header deck swap control disappears once the talk starts", async () => {
    renderSession(routineClient(), "dbe_live");

    expect(
      within(document.body).getByRole("button", { name: messages("ko").newDeck }),
    ).toBeTruthy();

    await startTalk();

    expect(
      within(document.body).queryByRole("button", { name: messages("ko").newDeck }),
    ).toBeNull();
  });

  test("the cockpit root carries the phase attribute and flips after start", async () => {
    renderSession(routineClient(), "dbe_live");

    expect(document.querySelector(".console-cockpit[data-cockpit-phase='PREPARING']")).toBeTruthy();
    expect(document.querySelector(".console-cockpit[data-cockpit-phase='PRESENTING']")).toBeNull();

    await startTalk();

    expect(
      document.querySelector(".console-cockpit[data-cockpit-phase='PRESENTING']"),
    ).toBeTruthy();
    expect(document.querySelector(".console-cockpit[data-cockpit-phase='PREPARING']")).toBeNull();
  });

  // The end control hands off to the summary while finalization is still running: the page
  // opens on the honest in-flight state and only ever swaps in a report that was actually
  // generated for this session — a stuck PENDING keeps its bounded retry instead of a card.
  test("end lands on the compiling summary and resolves to the real report on retry", async () => {
    const endedReport: SessionReportView = {
      reportVersion: 1,
      presentationSessionId: "ps_active",
      ownerAccountId: "account_owner",
      finalizedAtMs: 10_000,
      totalDurationMs: 1_000,
      slideVisits: [
        {
          sequence: 1,
          publicSlideKey: "slide_one",
          occurrenceSequence: 1,
          enteredOffsetMs: 0,
          leftOffsetMs: 600,
          dwellMs: 600,
          revisit: false,
        },
        {
          sequence: 2,
          publicSlideKey: "slide_two",
          occurrenceSequence: 1,
          enteredOffsetMs: 600,
          leftOffsetMs: 1_000,
          dwellMs: 400,
          revisit: false,
        },
      ],
      speech: {
        derivedSummary: "발화 집계",
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
    let summaryRead: () => void = () => {
      throw new Error("summary read signal was not installed");
    };
    const summaryLanded = new Promise<void>((resolve) => {
      summaryRead = resolve;
    });
    let reads = 0;
    const client: ConsoleSessionClient = {
      ...routineClient(),
      async endPresentationAndAwaitReport() {
        // The live REPORT_READY signal is bounded; the presentation ends server-side anyway.
        throw new Error("Finalized report signal did not arrive in time.");
      },
      async readFinalizedReport() {
        // Read 1 is the cockpit's end-took discriminator, read 2 the summary's mount read,
        // read 3 the explicit retry — each answering the truth at its own moment.
        reads += 1;
        if (reads === 2) summaryRead();
        return reads < 3 ? { status: "PENDING" } : { status: "FINALIZED", report: endedReport };
      },
    };
    renderSession(client, "dbe_live");
    await startTalk();

    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: "발표 종료" }));
    });
    await summaryLanded;
    await act(async () => {});

    // In-flight: the summary says the results are being compiled; no report body exists yet.
    expect(document.querySelector("[data-report-status='PENDING']")).toBeTruthy();
    expect(document.querySelector("[data-presentation-report]")).toBeNull();
    const retry = document.querySelector("[data-report-retry]");
    expect(retry).not.toBeNull();

    await act(async () => {
      fireEvent.click(retry as Element);
    });
    await act(async () => {});

    const card = document.querySelector("[data-presentation-report='ready']");
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("Opening slide");
    expect(document.querySelector("[data-report-status]")).toBeNull();
  });
});

test("keeps ko and en locale key sets equal", () => {
  const ko = Object.keys(messages("ko")).sort();
  const en = Object.keys(messages("en")).sort();
  expect(ko).toEqual(en);
});
