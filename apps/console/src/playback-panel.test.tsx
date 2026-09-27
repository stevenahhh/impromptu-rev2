import { afterEach, expect, test } from "bun:test";
import { registerDom } from "@impromptu/test-harness";

registerDom();

const { act, cleanup, fireEvent, render, within } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");

const { AuthProvider, ConsoleRoutes } = await import("./App");
const { messages } = await import("./i18n");
const { STAGE_ORIGIN } = await import("./stage-origin");

import type {
  ActivePresentationView,
  ConsoleSessionClient,
  SessionReportView,
} from "./session-client";
import { PlaybackCommandRejectedError } from "./session-client";

afterEach(cleanup);

// Join events must come from the origin the console actually resolved for this test process;
// stage-origin is evaluated once per run and the ambient .env can point it at a tunnel.
const stageOrigin = STAGE_ORIGIN;

const slides: ActivePresentationView["slides"] = [
  { publicSlideKey: "slide_one", ordinal: 1, accessibilityLabel: "Opening slide" },
  { publicSlideKey: "slide_two", ordinal: 2, accessibilityLabel: "Results slide" },
];

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
      approvals.push(`${presentation.presentationSessionId}:${join.displayId}`);
      return { displayBindingEpoch: "dbe_fresh" };
    },
    async issueDisplayInvitation() {
      return {
        invitationId: `dinvite_${"cd".repeat(16)}`,
        deckVersion: "deck_active",
        expiresAtMs: Date.now() + 90_000,
        stagePath: `/?deck=deck_active#invite=dinv_${"ab".repeat(32)}`,
      };
    },
    async readDisplayInvitationPending(invitationId) {
      return {
        invitationId,
        presentationSessionId: "ps_active",
        deckVersion: "deck_active",
        expiresAtMs: Date.now() + 90_000,
        status: "PENDING",
        displayBindingEpoch: "dbe_0",
        join: null,
      };
    },
    async setSlide(_csrfToken, _input) {
      throw new Error("not used");
    },
  };
}

function renderPlayback(client: ConsoleSessionClient, displayBindingEpoch: string) {
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
        initialDisplayBindingEpoch={displayBindingEpoch}
        client={client}
      >
        <ConsoleRoutes />
      </AuthProvider>
    </MemoryRouter>,
  );
}

test("renders a routine slide change in the neutral state, never the problem state", async () => {
  const client: ConsoleSessionClient = {
    ...pairingClient([]),
    async setSlide() {
      return { acceptedControlRevision: "cr_1" };
    },
  };
  renderPlayback(client, "dbe_1");

  // The command is triggered only after the assertion target exists; the resolved promise
  // flushes inside act, so there is no waiting on wall-clock time anywhere.
  await act(async () => {
    fireEvent.click(within(document.body).getByRole("button", { name: "다음 슬라이드" }));
  });

  const status = document.querySelector("[data-playback-status]");
  expect(status?.getAttribute("data-playback-status")).toBe("NEUTRAL");
  expect(document.querySelector("[data-playback-status='PROBLEM']")).toBeNull();
  // Routine success is a quiet receipt: shown, but outside every live region.
  const receipt = [...document.querySelectorAll(".console-present__status *")].find(
    (element) => element.textContent === messages("ko").slideChanged,
  );
  expect(receipt).toBeDefined();
  expect(receipt?.hasAttribute("aria-live")).toBe(false);
});

test("renders a dead-binding expiry in the problem state and keeps the anti-stranding path", async () => {
  const approvals: string[] = [];
  const slideCommands: string[] = [];
  const opens: Window[] = [];
  const originalOpen = window.open;
  window.open = ((_url?: string | URL) => {
    const handle = {} as Window;
    opens.push(handle);
    return handle;
  }) as typeof window.open;
  let commands = 0;
  const client: ConsoleSessionClient = {
    ...pairingClient(approvals),
    async setSlide(_csrfToken, input) {
      commands += 1;
      if (commands === 1) {
        throw new PlaybackCommandRejectedError("STALE_DISPLAY_BINDING");
      }
      slideCommands.push(input.publicSlideKey);
      return { acceptedControlRevision: `cr_${commands}` };
    },
  };

  try {
    renderPlayback(client, "dbe_dead");

    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: "다음 슬라이드" }));
    });

    expect(
      document.querySelector("[data-playback-status]")?.getAttribute("data-playback-status"),
    ).toBe("PROBLEM");
    expect(document.querySelector("[data-playback-status='PROBLEM']")?.textContent).toContain(
      messages("ko").bindingExpired,
    );
    // The dead binding was cleared: relative controls disable instead of looping on 409.
    expect(
      within(document.body).getByRole("button", { name: "다음 슬라이드" }).hasAttribute("disabled"),
    ).toBe(true);

    // Anti-stranding guarantee intact: the next press takes the ordinary open-and-bind path.
    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: "발표 시작" }));
    });
    await act(async () => {
      const source = opens[0];
      if (source === undefined) throw new Error("audience screen was never opened");
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: stageOrigin,
          data: {
            kind: "impromptu:display-join",
            join: {
              displayJoinId: `join_${"b".repeat(32)}`,
              displayId: "display_room",
              displayFingerprint: "stage-browser-fingerprint",
              deckVersion: "deck_active",
              expiresAtMs: Date.now() + 60_000,
            },
          },
          source,
        }),
      );
    });

    expect(approvals).toEqual(["ps_active:display_room"]);
    expect(slideCommands).toEqual(["slide_one"]);
    expect(document.querySelector("[data-presentation-state='PRESENTING']")).toBeTruthy();
    // Recovery succeeded, so the surface leaves the problem state behind.
    expect(
      document.querySelector("[data-playback-status]")?.getAttribute("data-playback-status"),
    ).toBe("NEUTRAL");
  } finally {
    window.open = originalOpen;
  }
});

test("renders a slide failure in the problem state with its own announced region", async () => {
  const client: ConsoleSessionClient = {
    ...pairingClient([]),
    async setSlide() {
      throw new PlaybackCommandRejectedError("REVISION_MISMATCH");
    },
  };
  renderPlayback(client, "dbe_1");

  await act(async () => {
    fireEvent.click(within(document.body).getByRole("button", { name: "다음 슬라이드" }));
  });

  const problem = document.querySelector("[data-playback-status='PROBLEM']");
  expect(problem?.textContent).toContain(messages("ko").slideFailed);
  // Real problems reach assistive tech: the live region carries them.
  const announcer = [...document.querySelectorAll(".console-present__status [aria-live]")].find(
    (element) => element.textContent?.includes(messages("ko").slideFailed),
  );
  expect(announcer).toBeDefined();
});

// The end-presentation summary is the cockpit's status line while 발표 종료 runs: it opens as
// in-flight work, and resolves only to the outcome that actually happened.
const generatedReport: SessionReportView = {
  reportVersion: 1,
  presentationSessionId: "ps_active",
  ownerAccountId: "account_preview",
  finalizedAtMs: 10_000,
  totalDurationMs: 1_000,
  slideVisits: [
    {
      sequence: 1,
      publicSlideKey: "slide_one",
      occurrenceSequence: 1,
      enteredOffsetMs: 0,
      leftOffsetMs: 1_000,
      dwellMs: 1_000,
      revisit: false,
    },
  ],
  speech: {
    derivedSummary: "1개 최종 발화에서 2개 단어를 집계했습니다.",
    wordCount: 2,
    speakingDurationMs: 400,
    timingAggregate: { finalCount: 1, measuredFinalCount: 1 },
    coachingAggregate: {
      cueCount: 0,
      latestCurrentWordsPerMinute: null,
      latestPreviousWordsPerMinute: null,
    },
  },
  preparedEvidence: { label: "준비된 근거", items: [] },
};

async function startTalkAndEnd(client: ConsoleSessionClient): Promise<void> {
  renderPlayback(client, "dbe_1");
  await act(async () => {
    fireEvent.click(within(document.body).getByRole("button", { name: "발표 시작" }));
  });
  await act(async () => {
    fireEvent.click(within(document.body).getByRole("button", { name: "발표 종료" }));
  });
}

test("the end summary opens with the report in flight and lands on the generated report", async () => {
  let settleEnd: (report: SessionReportView) => void = () => {
    throw new Error("end promise was not installed");
  };
  const endOutcome = new Promise<SessionReportView>((resolve) => {
    settleEnd = resolve;
  });
  let endCalls = 0;
  const client: ConsoleSessionClient = {
    ...pairingClient([]),
    async setSlide() {
      return { acceptedControlRevision: "cr_1" };
    },
    endPresentationAndAwaitReport() {
      endCalls += 1;
      return endOutcome;
    },
    async readFinalizedReport() {
      throw new Error("the fallback read must not run while the live signal is pending");
    },
  };
  await startTalkAndEnd(client);

  // While the report is still being generated the summary says so - and shows no report.
  expect(endCalls).toBe(1);
  const status = document.querySelector("[data-playback-status]");
  expect(status?.textContent).toContain(messages("ko").reportFinalizing);
  expect(document.querySelector("[data-presentation-report]")).toBeNull();

  await act(async () => {
    settleEnd(generatedReport);
    await endOutcome;
  });

  // Success resolves to the artifact the server actually produced.
  const report = document.querySelector("[data-presentation-report='ready']");
  expect(report).toBeTruthy();
  expect(report?.textContent).toContain(generatedReport.speech.derivedSummary);
});

test("a failed end stays on the talk with bounded recovery copy, never a fabricated report", async () => {
  const client: ConsoleSessionClient = {
    ...pairingClient([]),
    async setSlide() {
      return { acceptedControlRevision: "cr_1" };
    },
    async endPresentationAndAwaitReport() {
      throw new Error("Private report stream did not open in time.");
    },
    async readFinalizedReport() {
      throw new Error("the report cannot be read");
    },
  };
  await startTalkAndEnd(client);

  const problem = document.querySelector("[data-playback-status='PROBLEM']");
  expect(problem?.textContent).toContain(messages("ko").reportFinalizeFailed);
  // Bounded recovery: the summary names the one action that retries the end, and the control
  // that performs it is live again - no dead panel, no second implicit mutation.
  expect(problem?.textContent).toContain("발표 종료");
  const retry = within(document.body).getByRole("button", { name: "발표 종료" });
  expect(retry.hasAttribute("disabled")).toBe(false);
  expect(document.querySelector("[data-presentation-report]")).toBeNull();
  expect(document.querySelector("[data-presentation-state='PRESENTING']")).toBeTruthy();
});

test("a still-finalizing report lands on its page as pending, not as a report that was never made", async () => {
  const client: ConsoleSessionClient = {
    ...pairingClient([]),
    async setSlide() {
      return { acceptedControlRevision: "cr_1" };
    },
    async endPresentationAndAwaitReport() {
      // The live signal is bounded; the end itself already took server-side.
      throw new Error("Finalized report signal did not arrive in time.");
    },
    async readFinalizedReport() {
      return { status: "PENDING" };
    },
  };
  await startTalkAndEnd(client);

  // PENDING is the honest summary of an end that was accepted but has not produced a report yet.
  expect(document.querySelector("[data-report-status='PENDING']")).toBeTruthy();
  expect(document.querySelector("[data-presentation-report]")).toBeNull();
  expect(document.querySelectorAll("[data-report-slide-visit]")).toHaveLength(0);
});
