import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());

const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");

const { StageRoutes } = await import("./App");

import type { StageSessionClient } from "./stage-client";

afterEach(() => {
  cleanup();
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    value: null,
  });
});

function renderStage(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <StageRoutes />
    </MemoryRouter>,
  );
}

describe("public Stage boundary", () => {
  test("keeps both Stage routes public and audience-only", () => {
    renderStage("/");
    expect(
      within(document.body).getByRole("heading", { name: "A clean screen for the room" }),
    ).toBeTruthy();
    expect(within(document.body).queryByText("Private workspace")).toBeNull();

    cleanup();
    renderStage("/display/rehearsal");
    expect(
      within(document.body).getByRole("heading", { name: "Evidence, without the detour" }),
    ).toBeTruthy();
    expect(within(document.body).queryByText("Private workspace")).toBeNull();
  });

  test("uses exact join and approval actions without granting controller authority", async () => {
    const actions: string[] = [];
    const client: StageSessionClient = {
      async createJoin(identity, deckVersion) {
        actions.push("join-created");
        return {
          ...identity,
          deckVersion,
          displayJoinId: `join_${"a".repeat(32)}`,
          expiresAtMs: 90_000,
        };
      },
      async claim() {
        actions.push("display-claimed");
      },
      async snapshot() {
        actions.push("snapshot-read");
        return {
          occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
          cards: [],
          publicCardRevision: "pcr_0",
          tombstoneWatermark: "pcr_0",
          tombstoneRetentionMs: 60_000,
        };
      },
    };
    render(
      <MemoryRouter initialEntries={["/"]}>
        <StageRoutes client={client} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(within(document.body).getByText("AAAAAAAA")).toBeTruthy();
    });
    expect(within(document.body).queryByText("Private workspace")).toBeNull();
    fireEvent.click(within(document.body).getByRole("button", { name: "Continue after approval" }));
    await waitFor(() => {
      expect(
        within(document.body).getByRole("heading", { name: "Evidence, without the detour" }),
      ).toBeTruthy();
    });
    expect(actions).toEqual(["join-created", "display-claimed", "snapshot-read"]);
  });

  test("enters and exits fullscreen only from a Stage-local action", () => {
    const requestFullscreen = mock(async () => {
      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        value: document.documentElement,
      });
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    const exitFullscreen = mock(async () => {
      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        value: null,
      });
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      value: exitFullscreen,
    });

    renderStage("/display/rehearsal");
    fireEvent.click(within(document.body).getByRole("button", { name: "Enter fullscreen" }));

    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    expect(within(document.body).getByRole("button", { name: "Exit fullscreen" })).toBeTruthy();

    fireEvent.click(within(document.body).getByRole("button", { name: "Exit fullscreen" }));
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    expect(within(document.body).getByRole("button", { name: "Enter fullscreen" })).toBeTruthy();
  });
});
