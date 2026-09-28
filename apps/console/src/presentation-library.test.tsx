import { afterEach, describe, expect, test } from "bun:test";
import { registerDom } from "@impromptu/test-harness";

registerDom();

const { act, cleanup, fireEvent, render, within } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");
const { AuthProvider, ConsoleRoutes } = await import("./App");

import type {
  AccountSessionView,
  ConsoleDeckUploadClient,
  PresentationDetailView,
  PresentationListView,
} from "./session-client";

afterEach(cleanup);

const presentationSummary = {
  presentationSessionId: "ps_resume",
  presentationSessionEpoch: "pse_1",
  title: "Impromptu sample deck",
  status: "ACTIVE" as const,
  createdAtMs: 1_000,
  updatedAtMs: 1_500,
  endedAtMs: null,
  deckVersion: "deck_resume",
  slideCount: 7,
};

const resumedDetail: PresentationDetailView = {
  ...presentationSummary,
  publicDeck: {
    deckVersion: "deck_resume",
    manifestHash: "a".repeat(64),
    slides: Array.from({ length: 7 }, (_unused, index) => ({
      publicSlideKey: `slide_resume_${index + 1}`,
      ordinal: index + 1,
      accessibilityLabel: `Sample slide ${index + 1}`,
    })),
  },
  playback: {
    displayBindingEpoch: "dbe_2",
    controlRevision: "cr_3",
    stageStatus: "READY",
    occurrence: { publicSlideKey: "slide_resume_2", occurrenceSeq: 2 },
    activeLease: { actorId: "actor_stale", expiresAtMs: Number.MAX_SAFE_INTEGER },
  },
};

function libraryClient(overrides: Partial<ConsoleDeckUploadClient> = {}) {
  const calls = { takeovers: 0, resumed: [] as string[] };
  const client: ConsoleDeckUploadClient = {
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
      throw new Error("upload must not run for a resumed deck");
    },
    async listPresentations() {
      return { presentations: [presentationSummary], nextCursor: null };
    },
    async readPresentation(presentationSessionId) {
      calls.resumed.push(presentationSessionId);
      return resumedDetail;
    },
    async takeoverPlaybackLease() {
      calls.takeovers += 1;
      return { leaseActorId: "actor_taken_over" };
    },
    ...overrides,
  };
  return { client, calls };
}

function renderConsole(
  client: ConsoleDeckUploadClient,
  options: { path?: string; hydrateSession?: boolean } = {},
) {
  return render(
    <MemoryRouter initialEntries={[options.path ?? "/"]}>
      <AuthProvider
        initialAuthenticated
        client={client}
        {...(options.hydrateSession === undefined
          ? {}
          : { hydrateSession: options.hydrateSession })}
      >
        <ConsoleRoutes />
      </AuthProvider>
    </MemoryRouter>,
  );
}

function switchToEnglish(): void {
  fireEvent.click(within(document.body).getByRole("button", { name: "English" }));
}

describe("Console presentation library", () => {
  test("lists the owner's decks and resumes one without any upload", async () => {
    const { client, calls } = libraryClient();
    renderConsole(client);
    switchToEnglish();

    // The list arrives from the server read, not storage.
    await act(async () => {});
    expect(within(document.body).getByText("Impromptu sample deck")).toBeTruthy();

    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: "Continue setup" }));
    });

    // The detail pins a stale lease actor, so resume takes the lease over once; no upload ran
    // and the cockpit opens on the slide the room was showing (2 of 7), not slide one.
    expect(calls.resumed).toEqual(["ps_resume"]);
    expect(calls.takeovers).toBe(1);
    expect(
      within(document.body).getByRole("heading", { name: "Presentation preparation" }),
    ).toBeTruthy();
    expect(document.querySelector("[data-deck-file-input]")).toBeNull();
    expect(document.body.textContent).toContain("2 / 7");
  });

  test("after a sign-out and a fresh sign-in the same deck resumes via lease takeover", async () => {
    const sessionsByUsername: Record<string, number> = {};
    const signedOut = { alpha: false };
    const { client, calls } = libraryClient({
      async signIn(username, _password) {
        sessionsByUsername[username] = (sessionsByUsername[username] ?? 0) + 1;
        const session: AccountSessionView = {
          account: {
            accountId: "account_alpha",
            actorId: `actor_fresh_${sessionsByUsername[username]}`,
          },
          expiresAtMs: Number.MAX_SAFE_INTEGER,
          csrfToken: `csrf_${sessionsByUsername[username]}`,
        };
        return session;
      },
      async signOut() {
        signedOut.alpha = true;
      },
    });
    renderConsole(client);
    await act(async () => {});

    // Sign out clears the loaded deck context before the next account arrives.
    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: "로그아웃" }));
    });
    expect(signedOut.alpha).toBe(true);
    expect(within(document.body).queryByText("Impromptu sample deck")).toBeNull();

    // Sign back in as the same account; the server list still holds the deck.
    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: "English" }));
    });
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
    fireEvent.change(usernameInput, { target: { value: "presenter-alpha" } });
    fireEvent.change(passwordInput, { target: { value: "transient-password" } });
    await act(async () => {
      fireEvent.click(submit);
    });

    await act(async () => {});
    fireEvent.click(within(document.body).getByRole("button", { name: "Continue setup" }));
    await act(async () => {});

    // The resumed detail pins the stale lease actor, so resume takes the lease over before
    // the cockpit is usable — never re-uploading, never silently reusing a dead lease.
    expect(calls.takeovers).toBe(1);
    expect(
      within(document.body).getByRole("heading", { name: "Presentation preparation" }),
    ).toBeTruthy();
  });

  test("an account switch never shows the previous account's list or deck", async () => {
    const listByAccount: Record<string, PresentationListView> = {
      account_alpha: { presentations: [presentationSummary], nextCursor: null },
      account_beta: {
        presentations: [
          { ...presentationSummary, presentationSessionId: "ps_beta", title: "Beta only" },
        ],
        nextCursor: null,
      },
    };
    let signedInAccount = "account_alpha";
    const { client } = libraryClient({
      async listPresentations() {
        return listByAccount[signedInAccount] ?? { presentations: [], nextCursor: null };
      },
      async signIn(username) {
        signedInAccount = username === "beta" ? "account_beta" : "account_alpha";
        return {
          account: { accountId: signedInAccount, actorId: `actor_${signedInAccount}` },
          expiresAtMs: Number.MAX_SAFE_INTEGER,
          csrfToken: `csrf_${signedInAccount}`,
        };
      },
    });
    renderConsole(client);
    await act(async () => {});
    expect(within(document.body).getByText("Impromptu sample deck")).toBeTruthy();

    // Alpha resumes its deck first: the stale-state hazard is a loaded cockpit surviving a
    // switch, not just a stale list.
    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: "이어서 준비" }));
    });
    expect(document.querySelector("[data-deck-file-input]")).toBeNull();

    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: "로그아웃" }));
    });
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
    fireEvent.change(usernameInput, { target: { value: "beta" } });
    fireEvent.change(passwordInput, { target: { value: "transient-password" } });
    await act(async () => {
      fireEvent.click(submit);
    });
    await act(async () => {});

    expect(within(document.body).queryByText("Impromptu sample deck")).toBeNull();
    expect(within(document.body).getByText("Beta only")).toBeTruthy();
    // The previous account's cockpit is gone: the upload surface is what a switched account
    // sees until it picks one of its own decks.
    expect(document.querySelector("[data-deck-file-input]")).toBeTruthy();
  });

  test("deletes a deck after an explicit confirm and drops the row", async () => {
    const calls = { deleted: [] as string[] };
    const { client } = libraryClient({
      async deletePresentation(_csrfToken, presentationSessionId) {
        calls.deleted.push(presentationSessionId);
      },
    });
    renderConsole(client, { path: "/presentations" });
    switchToEnglish();
    await act(async () => {});
    expect(within(document.body).getByText("Impromptu sample deck")).toBeTruthy();

    // Delete is a two-tap action: the first tap only arms the confirm, nothing is deleted.
    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: "Delete" }));
    });
    expect(calls.deleted).toEqual([]);

    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: "Confirm delete" }));
    });
    expect(calls.deleted).toEqual(["ps_resume"]);
    expect(within(document.body).queryByText("Impromptu sample deck")).toBeNull();
  });

  test("a failed delete keeps the row and reports the error", async () => {
    const { client } = libraryClient({
      async deletePresentation() {
        throw new Error("backend unreachable");
      },
    });
    renderConsole(client, { path: "/presentations" });
    switchToEnglish();
    await act(async () => {});

    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: "Delete" }));
    });
    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: "Confirm delete" }));
    });

    expect(within(document.body).getByText("Impromptu sample deck")).toBeTruthy();
    expect(
      within(document.body).getByText("The presentation could not be deleted. Please try again."),
    ).toBeTruthy();
  });

  test("a failed list read is an honest error with retry, never an empty list", async () => {
    let attempts = 0;
    const { client } = libraryClient({
      async listPresentations() {
        attempts += 1;
        if (attempts === 1) throw new Error("backend unreachable");
        return { presentations: [presentationSummary], nextCursor: null };
      },
    });
    renderConsole(client, { path: "/presentations" });
    switchToEnglish();
    await act(async () => {});

    expect(
      within(document.body).getByText("The presentation list could not be loaded."),
    ).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: "Try again" }));
    });
    expect(within(document.body).getByText("Impromptu sample deck")).toBeTruthy();
    expect(attempts).toBe(2);
  });

  test("session hydration restores the signed-in workspace after a reload", async () => {
    const { client } = libraryClient({
      async readSession() {
        return {
          account: { accountId: "account_alpha", actorId: "actor_alpha" },
          expiresAtMs: Number.MAX_SAFE_INTEGER,
          csrfToken: "csrf_restored",
        };
      },
    });
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider client={client} hydrateSession>
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );

    // While the session read is in flight nothing claims signed-out; once it resolves the
    // workspace arrives without a manual sign-in.
    await act(async () => {});
    await act(async () => {});
    switchToEnglish();
    expect(within(document.body).getByText("Impromptu sample deck")).toBeTruthy();
  });

  test("session hydration leaves a signed-out visitor on the sign-in page", async () => {
    const { client } = libraryClient();
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider client={client} hydrateSession>
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );

    await act(async () => {});
    expect(within(document.body).getByRole("heading", { name: "Impromptu에 로그인" })).toBeTruthy();
  });
});
