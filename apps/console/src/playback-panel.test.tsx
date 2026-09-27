import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());

const { act, cleanup, fireEvent, render, within } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");

const { AuthProvider, ConsoleRoutes } = await import("./App");
const { STAGE_ORIGIN } = await import("./stage-origin");

import type { ActivePresentationView, ConsoleSessionClient } from "./session-client";
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
    (element) => element.textContent === "청중 화면의 슬라이드를 변경했습니다.",
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
      "청중 화면 연결이 만료되었습니다.",
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
  expect(problem?.textContent).toContain("슬라이드 변경에 실패했습니다.");
  // Real problems reach assistive tech: the live region carries them.
  const announcer = [...document.querySelectorAll(".console-present__status [aria-live]")].find(
    (element) => element.textContent?.includes("슬라이드 변경에 실패했습니다."),
  );
  expect(announcer).toBeDefined();
});
