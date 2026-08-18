import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());

const { act, cleanup, fireEvent, render, within } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");

const { AuthProvider, ConsoleRoutes } = await import("./App");
const { messages } = await import("./i18n");

import type {
  AccountSessionView,
  ActivePresentationView,
  ConsoleDeckUploadClient,
  ConsoleSessionClient,
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

const workspacePresentation: ActivePresentationView = {
  presentationSessionId: "ps_workspace",
  deckVersion: "deck_workspace",
  slides: [
    { publicSlideKey: "slide_one", ordinal: 1, accessibilityLabel: "Opening slide" },
    { publicSlideKey: "slide_two", ordinal: 2, accessibilityLabel: "Results slide" },
  ],
};

describe("Console route boundary", () => {
  test("keeps locale catalogs structurally complete", () => {
    expect(Object.keys(messages("ko")).sort()).toEqual(Object.keys(messages("en")).sort());
  });

  test("translates sign-in, navigation, and evidence approval pages without English gaps", () => {
    renderConsole("/sign-in", false, "ko");

    expect(within(document.body).getByRole("heading", { name: "비공개 발표 제어" })).toBeTruthy();
    expect(within(document.body).getByText("일회용 로그인 코드")).toBeTruthy();

    cleanup();
    renderConsole("/live-publication", true, "ko");

    expect(within(document.body).getByRole("heading", { name: "실시간 근거 승인" })).toBeTruthy();
    expect(within(document.body).getByText("신뢰 가능한 최신 상태")).toBeTruthy();
    expect(within(document.body).queryByText("Authoritative snapshot")).toBeNull();
  });

  test("switches the upload-first workflow with an accessible emoji language picker", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider initialAuthenticated initialPresentation={workspacePresentation}>
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );

    const picker = within(document.body).getByRole("group", { name: "Language" });
    expect(within(picker).getByRole("button", { name: "한국어" }).textContent).toContain("🇰🇷");
    expect(within(picker).getByRole("button", { name: "English" }).textContent).toContain("🇺🇸");

    expect(document.documentElement.lang).toBe("ko");
    expect(within(document.body).getByRole("heading", { name: "발표 워크스페이스" })).toBeTruthy();
    const steps = document.querySelector(".console-workflow-steps");
    expect(steps).toBeTruthy();
    expect(within(steps as HTMLElement).getByText("슬라이드 준비")).toBeTruthy();
    expect(within(steps as HTMLElement).getByText("화면 연결")).toBeTruthy();
    expect(within(steps as HTMLElement).getByText("발표 시작")).toBeTruthy();

    fireEvent.click(within(picker).getByRole("button", { name: "English" }));
    expect(document.documentElement.lang).toBe("en");
    expect(within(document.body).getByRole("heading", { name: "Presentation workspace" })).toBeTruthy();
  });

  test("offers one selected structured template before upload", () => {
    renderConsole("/", true);

    const templates = document.querySelectorAll("[data-presentation-template]");
    expect(templates).toHaveLength(3);
    expect(document.querySelectorAll("[data-presentation-template][aria-checked='true']")).toHaveLength(
      1,
    );

    fireEvent.click(templates[1] as Element);

    expect(templates[0]?.getAttribute("aria-checked")).toBe("false");
    expect(templates[1]?.getAttribute("aria-checked")).toBe("true");
  });

  test("opens with an upload-first workspace and accepts a dropped deck", async () => {
    const uploadedFiles: string[] = [];
    const client = workspaceClient({
      async uploadDeck(_csrfToken, file) {
        uploadedFiles.push(file.name);
        return {
          presentationSessionId: workspacePresentation.presentationSessionId,
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

  test("shows evidence preparation immediately without blocking presentation readiness", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider initialAuthenticated initialPresentation={workspacePresentation}>
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );

    switchToEnglish();
    expect(document.querySelector("[data-evidence-status='PREPARING']")).toBeTruthy();
    expect(within(document.body).getByText("Preparing evidence")).toBeTruthy();
    switchToEnglish();
    expect(within(document.body).getByRole("button", { name: "Open audience screen" })).toBeTruthy();
    expect(within(document.body).getByText(/start now/i)).toBeTruthy();
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
      within(document.body).getByRole("button", { name: "Open audience screen" }),
    ).toBeTruthy();
    expect(
      within(document.body).getByRole("button", { name: "Copy audience screen link" }),
    ).toBeTruthy();
    expect(within(document.body).getByRole("button", { name: "Use external display" })).toBeTruthy();
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
    expect(
      within(document.body).getByRole("link", { name: "Presentation workspace" }),
    ).toBeTruthy();
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

  test("exchanges the entered code through the typed session client without storage", async () => {
    const receivedCodes: string[] = [];
    let resolveSignIn: (session: AccountSessionView) => void = () => {
      throw new Error("sign-in signal was not installed");
    };
    const signInCompleted = new Promise<AccountSessionView>((resolve) => {
      resolveSignIn = resolve;
    });
    const client: ConsoleSessionClient = {
      signIn(code) {
        receivedCodes.push(code);
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

    switchToEnglish();
    fireEvent.change(within(document.body).getByLabelText("One-time sign-in code"), {
      target: { value: "transient-code" },
    });
    fireEvent.click(within(document.body).getByRole("button", { name: "Enter private workspace" }));

    await act(async () => {
      resolveSignIn({
        account: { accountId: "account_alpha", actorId: "actor_alpha" },
        expiresAtMs: 10_000,
        csrfToken: "csrf-alpha",
      });
      await signInCompleted;
    });
    expect(
      within(document.body).getByRole("heading", { name: "Start a presentation" }),
    ).toBeTruthy();
    expect(receivedCodes).toEqual(["transient-code"]);
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
        <AuthProvider initialAuthenticated client={client}>
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );

    switchToEnglish();
    fireEvent.change(within(document.body).getByLabelText("Presentation session ID"), {
      target: { value: "ps_live-ui" },
    });
    fireEvent.click(within(document.body).getByRole("button", { name: "Load fresh candidates" }));
    await act(async () => await loaded);
    expect(within(document.body).getByText("Fresh verified claim")).toBeTruthy();

    fireEvent.click(within(document.body).getByRole("button", { name: "Approve live card" }));
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
      deckVersion: "deck_active",
      slides: [],
    };
    let loadedPresentationId = "";
    const client: ConsoleSessionClient = {
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
        <AuthProvider
          initialAuthenticated
          initialPresentation={activePresentation}
          client={client}
        >
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );

    switchToEnglish();
    await act(async () => {});
    expect(loadedPresentationId).toBe("ps_active");
    expect(within(document.body).queryByLabelText("Presentation session ID")).toBeNull();
    expect(within(document.body).getByRole("button", { name: "Refresh suggestions" })).toBeTruthy();
  });

  test("approves an audience screen and controls slides without internal ids", async () => {
    const approvals: string[] = [];
    const slideCommands: string[] = [];
    const activePresentation: ActivePresentationView = {
      presentationSessionId: "ps_active",
      deckVersion: "deck_active",
      slides: [
        { publicSlideKey: "slide_one", ordinal: 1, accessibilityLabel: "Opening" },
        { publicSlideKey: "slide_two", ordinal: 2, accessibilityLabel: "Results" },
      ],
    };
    const client: ConsoleSessionClient = {
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
        <AuthProvider
          initialAuthenticated
          initialPresentation={activePresentation}
          client={client}
        >
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );

    switchToEnglish();
    fireEvent.change(
      within(document.body).getByLabelText("Audience screen connection code"),
      { target: { value: joinCode } },
    );
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
