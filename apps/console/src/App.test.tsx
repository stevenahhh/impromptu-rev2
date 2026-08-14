import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());

const { act, cleanup, fireEvent, render, within } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");

const { AuthProvider, ConsoleRoutes } = await import("./App");

import type { AccountSessionView, ConsoleSessionClient } from "./session-client";

afterEach(cleanup);

function renderConsole(path: string, authenticated: boolean) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider initialAuthenticated={authenticated}>
        <ConsoleRoutes />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("Console route boundary", () => {
  test("redirects a signed-out visitor away from every private route", () => {
    renderConsole("/session", false);

    expect(
      within(document.body).getByRole("heading", { name: "Private presentation control" }),
    ).toBeTruthy();
    expect(within(document.body).queryByRole("heading", { name: "Session controls" })).toBeNull();
  });

  test("keeps the sign-in route public-only once authenticated", () => {
    renderConsole("/sign-in", true);

    expect(within(document.body).getByRole("heading", { name: "Ready for the room" })).toBeTruthy();
    expect(
      within(document.body).queryByRole("heading", { name: "Private presentation control" }),
    ).toBeNull();
  });

  test("renders an explicit private navigation landmark", () => {
    renderConsole("/", true);

    expect(
      within(document.body).getByRole("navigation", { name: "Private workspace" }),
    ).toBeTruthy();
    expect(within(document.body).getByText("Private workspace")).toBeTruthy();
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

    expect(within(document.body).getByRole("alert").textContent).toContain(
      "No-private-pixel protection does not apply",
    );
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("impromptu:public-surface-observation", {
          detail: { privatePixelCount: 1 },
        }),
      );
    });
    expect(within(document.body).getByText("Co-resident mode disabled")).toBeTruthy();
    expect(within(document.body).queryByText("Private workspace")).toBeNull();
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
    };
    render(
      <MemoryRouter initialEntries={["/sign-in"]}>
        <AuthProvider client={client}>
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );

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
    expect(within(document.body).getByRole("heading", { name: "Ready for the room" })).toBeTruthy();
    expect(receivedCodes).toEqual(["transient-code"]);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  test("approves a live candidate only from the loaded authoritative snapshot", async () => {
    const approvals: Array<{ candidateId: string; snapshotHash: string }> = [];
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
    };
    render(
      <MemoryRouter initialEntries={["/live-publication"]}>
        <AuthProvider initialAuthenticated client={client}>
          <ConsoleRoutes />
        </AuthProvider>
      </MemoryRouter>,
    );

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
    expect(within(document.body).getByText(/Load a new authoritative snapshot/)).toBeTruthy();
  });
});
