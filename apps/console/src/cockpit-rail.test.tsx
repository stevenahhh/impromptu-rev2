import { afterEach, describe, expect, test } from "bun:test";
import { registerDom } from "@impromptu/test-harness";

registerDom();

const { act, cleanup, fireEvent, render, within } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");

const { AuthProvider } = await import("./auth-session");
const { ConsoleRoutes } = await import("./console-routes");
const { messages } = await import("./i18n");
const { STAGE_ORIGIN } = await import("./stage-origin");

import type { ActivePresentationView, ConsoleSessionClient } from "./session-client";

afterEach(cleanup);

// The console only honours joins posted from its resolved stage origin. Use the module's own
// value: the ambient .env may point it at a tunnel, and stage-origin is resolved once for the
// whole test process, so a hardcoded localhost would miss whenever the env differs.
const stageOrigin = STAGE_ORIGIN;

const workspaceSlides: ActivePresentationView["slides"] = [
  { publicSlideKey: "slide_one", ordinal: 1, accessibilityLabel: "Opening slide" },
];

function handshakeJoin(deckVersion: string) {
  return {
    displayJoinId: `join_${"a".repeat(32)}`,
    displayId: "display_room",
    displayFingerprint: "stage-browser-fingerprint",
    deckVersion,
    expiresAtMs: Date.now() + 60_000,
  };
}

function pairingClient(approvals: string[], slideCommands: string[]): ConsoleSessionClient {
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
      return { displayBindingEpoch: "dbe_1" };
    },
    async setSlide(_csrfToken, input) {
      slideCommands.push(input.publicSlideKey);
      return { acceptedControlRevision: "cr_1" };
    },
  };
}

function renderWorkspace(client: ConsoleSessionClient) {
  render(
    <MemoryRouter initialEntries={["/session"]}>
      <AuthProvider
        initialAuthenticated
        initialPresentation={{
          presentationSessionId: "ps_active",
          presentationSessionEpoch: "pse_1",
          deckVersion: "deck_active",
          slides: workspaceSlides,
        }}
        client={client}
      >
        <ConsoleRoutes />
      </AuthProvider>
    </MemoryRouter>,
  );
}

async function startTalk(): Promise<void> {
  const opened = {} as Window;
  const originalOpen = window.open;
  window.open = (() => opened) as typeof window.open;
  try {
    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: "발표 시작" }));
    });
    // The opened stage screen reports its join back through the same MessageEvent the
    // real audience window sends; no timer is involved.
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: stageOrigin,
          data: { kind: "impromptu:display-join", join: handshakeJoin("deck_active") },
          source: opened,
        }),
      );
    });
  } finally {
    window.open = originalOpen;
  }
}

describe("Cockpit rail phases", () => {
  test("keeps reference material and audience connection in the primary rail before start", () => {
    renderWorkspace(pairingClient([], []));

    expect(
      document.querySelector(".console-cockpit__side[data-cockpit-phase='PREPARING']"),
    ).toBeTruthy();
    expect(
      document.querySelector(".console-cockpit__side > .console-reference-documents"),
    ).toBeTruthy();
    expect(
      document.querySelector(".console-cockpit__side > [data-audience-screen-panel]"),
    ).toBeTruthy();
    // Prominence means position: the two preparation surfaces lead the rail.
    const side = document.querySelector(".console-cockpit__side");
    expect(side?.firstElementChild?.classList.contains("console-reference-documents")).toBe(true);
    expect(side?.children[1]?.hasAttribute("data-audience-screen-panel")).toBe(true);
  });

  test("folds reference material away and promotes prepared evidence after start", async () => {
    const approvals: string[] = [];
    const slideCommands: string[] = [];
    renderWorkspace(pairingClient(approvals, slideCommands));
    await startTalk();

    expect(slideCommands).toEqual(["slide_one"]);
    expect(document.querySelector("[data-presentation-state='PRESENTING']")).toBeTruthy();
    expect(
      document.querySelector(".console-cockpit__side[data-cockpit-phase='PRESENTING']"),
    ).toBeTruthy();
    // Prepared evidence holds prime rail space on stage.
    expect(
      document.querySelector(".console-cockpit__side > .console-evidence-preparation"),
    ).toBeTruthy();
    // 참고 자료 and the audience recovery surface stay mounted but collapsed behind the
    // preparation drawer, never a primary block.
    const drawer = document.querySelector<HTMLDetailsElement>(
      ".console-cockpit__side > details.console-preparation-drawer",
    );
    expect(drawer).toBeTruthy();
    expect(drawer?.open).toBe(false);
    expect(drawer?.querySelector(".console-reference-documents")).toBeTruthy();
    expect(drawer?.querySelector("[data-audience-screen-panel]")).toBeTruthy();
    expect(
      document.querySelector(".console-cockpit__side > .console-reference-documents"),
    ).toBeNull();
    // The audience screen surface stays reachable while live.
    expect(document.querySelector("[data-audience-screen-panel]")).toBeTruthy();
  });

  test("renders no coaching panel block until opt-in, keeping the opt-in control reachable", async () => {
    renderWorkspace(pairingClient([], []));

    expect(document.querySelector(".console-coaching")).toBeNull();
    await act(async () => {
      fireEvent.click(within(document.body).getByRole("checkbox", { name: "발표 도움말 표시" }));
    });
    expect(document.querySelector(".console-coaching")).toBeTruthy();
  });

  test("keeps every rail capability reachable across both phases", async () => {
    const approvals: string[] = [];
    const slideCommands: string[] = [];
    renderWorkspace(pairingClient(approvals, slideCommands));

    // Preparing phase surfaces every capability directly.
    expect(
      document.querySelector(".console-cockpit__side > .console-reference-documents"),
    ).toBeTruthy();
    expect(
      document.querySelector(".console-cockpit__side > [data-audience-screen-panel]"),
    ).toBeTruthy();
    expect(
      document.querySelector(".console-cockpit__side > .console-evidence-preparation"),
    ).toBeTruthy();
    expect(within(document.body).getByRole("checkbox", { name: "발표 도움말 표시" })).toBeTruthy();

    await startTalk();

    // Presenting phase keeps evidence and capture status direct; reference and audience-screen
    // connection stay reachable through the collapsed drawer.
    expect(
      document.querySelector(".console-cockpit__side > .console-evidence-preparation"),
    ).toBeTruthy();
    expect(within(document.body).getByRole("checkbox", { name: "발표 도움말 표시" })).toBeTruthy();
    expect(document.querySelector("[data-capture-status]")).toBeTruthy();
    const drawer = document.querySelector<HTMLDetailsElement>(
      ".console-cockpit__side > details.console-preparation-drawer",
    );
    expect(drawer?.querySelector(".console-reference-documents")).toBeTruthy();
    expect(drawer?.querySelector("[data-audience-screen-panel]")).toBeTruthy();
  });
});

test("keeps ko and en locale key sets equal", () => {
  expect(Object.keys(messages("ko")).sort()).toEqual(Object.keys(messages("en")).sort());
});
