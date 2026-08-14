import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());

const { act, cleanup, fireEvent, render, within } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");

const { StageRoutes } = await import("./App");

import type {
  DisplayIdentity,
  DisplayJoinView,
  StageSessionClient,
  StageSnapshotView,
} from "./stage-client";

function deferred<Value>() {
  let resolve: ((value: Value) => void) | null = null;
  const promise = new Promise<Value>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return {
    promise,
    resolve(value: Value) {
      if (resolve === null) throw new Error("signal already resolved");
      const current = resolve;
      resolve = null;
      current(value);
    },
  };
}

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
    const joinSignal = deferred<DisplayJoinView>();
    const claimSignal = deferred<void>();
    const snapshotSignal = deferred<StageSnapshotView>();
    let identity: DisplayIdentity = { displayId: "", displayFingerprint: "" };
    let requestedDeckVersion = "";
    const client: StageSessionClient = {
      createJoin(nextIdentity, deckVersion) {
        actions.push("join-created");
        identity = nextIdentity;
        requestedDeckVersion = deckVersion;
        return joinSignal.promise;
      },
      claim() {
        actions.push("display-claimed");
        return claimSignal.promise;
      },
      snapshot() {
        actions.push("snapshot-read");
        return snapshotSignal.promise;
      },
    };
    render(
      <MemoryRouter initialEntries={["/"]}>
        <StageRoutes client={client} />
      </MemoryRouter>,
    );
    if (actions[0] !== "join-created")
      throw new Error("join subscription was not installed by render");
    await act(async () => {
      joinSignal.resolve({
        ...identity,
        deckVersion: requestedDeckVersion,
        displayJoinId: `join_${"a".repeat(32)}`,
        expiresAtMs: 90_000,
      });
      await joinSignal.promise;
    });
    expect(within(document.body).getByText("AAAAAAAA")).toBeTruthy();
    expect(within(document.body).queryByText("Private workspace")).toBeNull();
    fireEvent.click(within(document.body).getByRole("button", { name: "Continue after approval" }));
    await act(async () => {
      claimSignal.resolve(undefined);
      await claimSignal.promise;
    });
    await act(async () => {
      snapshotSignal.resolve({
        occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
        cards: [],
        publicCardRevision: "pcr_0",
        tombstoneWatermark: "pcr_0",
        tombstoneRetentionMs: 60_000,
      });
      await snapshotSignal.promise;
    });
    expect(
      within(document.body).getByRole("heading", { name: "Evidence, without the detour" }),
    ).toBeTruthy();
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
