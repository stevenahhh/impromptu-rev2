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
  StageEventObserver,
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

function textMutation(text: string, visible: boolean) {
  const present = () => document.body.textContent?.includes(text) === true;
  if (present() === visible) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const observer = new MutationObserver(() => {
      if (present() === visible) {
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    AbortSignal.timeout(2_000).addEventListener(
      "abort",
      () => {
        observer.disconnect();
        reject(new Error(`text mutation timeout: ${text}`));
      },
      { once: true },
    );
  });
}

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
      async subscribe() {
        actions.push("events-subscribed");
        return { close() {} };
      },
      async recordApplied() {
        actions.push("receipt-recorded");
        return null;
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
        role: "PUBLIC_STAGE",
        stateHash: "a".repeat(64),
        presentationSessionId: "ps_alpha",
        presentationSessionEpoch: "pse_1",
        displayBindingEpoch: "dbe_1",
        deckVersion: "deck_alpha",
        manifestHash: "b".repeat(64),
        deckSlides: [
          {
            publicSlideKey: "slide_one",
            ordinal: 1,
            imageUrl: "https://public.test/one.png",
            imageContentHash: "c".repeat(64),
            accessibilityLabel: "One",
          },
        ],
        publicPlaybackRevision: "pbr_0",
        blackout: false,
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
    expect(actions).toEqual([
      "join-created",
      "display-claimed",
      "events-subscribed",
      "snapshot-read",
    ]);
  });

  test("observes topology transitions through the same platform event handler", () => {
    renderStage("/display/rehearsal");
    fireEvent(
      window,
      new CustomEvent("impromptu:platform-topology-change", {
        detail: { observedMode: "duplicate", screenCount: 1 },
      }),
    );

    expect(within(document.body).getByText("duplicate / 1 screen")).toBeTruthy();

  test("observes one visible effect, keeps verified curated offline, and hides on session epoch change", async () => {
    let observer: StageEventObserver | null = null;
    const snapshotApplied = deferred<unknown>();
    const visibleEffects: unknown[] = [];
    window.addEventListener(
      "impromptu:snapshot-applied",
      (event) => snapshotApplied.resolve(event instanceof CustomEvent ? event.detail : null),
      { once: true },
    );
    window.addEventListener("impromptu:visible-playback", (event) => {
      visibleEffects.push(event instanceof CustomEvent ? event.detail : null);
    });
    const snapshot: StageSnapshotView = {
      role: "PUBLIC_STAGE",
      stateHash: "a".repeat(64),
      presentationSessionId: "ps_alpha",
      presentationSessionEpoch: "pse_1",
      displayBindingEpoch: "dbe_1",
      deckVersion: "deck_alpha",
      manifestHash: "b".repeat(64),
      deckSlides: [
        {
          publicSlideKey: "slide_one",
          ordinal: 1,
          imageUrl: "https://public.test/one.png",
          imageContentHash: "c".repeat(64),
          accessibilityLabel: "One",
        },
        {
          publicSlideKey: "slide_two",
          ordinal: 2,
          imageUrl: "https://public.test/two.png",
          imageContentHash: "d".repeat(64),
          accessibilityLabel: "Two",
        },
      ],
      publicPlaybackRevision: "pbr_0",
      blackout: false,
      occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
      cards: [
        {
          projectionId: "projection_curated",
          status: "PUBLISHED",
          mode: "CURATED",
          leaseExpiresAtMs: null,
          offlinePackage: {
            offlineDisplayAllowed: true,
            localExpiresAtMs: Date.now() + 60_000,
            signature: "signed",
            signatureVerified: true,
          },
          claim: "Verified offline claim",
          supportSummary: "Signed package",
          sourceLabel: "Public source",
          publicCardRevision: "pcr_1",
        },
      ],
      publicCardRevision: "pcr_1",
      tombstoneWatermark: "pcr_0",
      tombstoneRetentionMs: 60_000,
    };
    let snapshotReads = 0;
    const client: StageSessionClient = {
      async createJoin() {
        throw new Error("not used");
      },
      async claim() {},
      async snapshot() {
        snapshotReads += 1;
        return snapshotReads === 1
          ? snapshot
          : {
              ...snapshot,
              stateHash: "e".repeat(64),
              publicPlaybackRevision: "pbr_1",
              occurrence: { publicSlideKey: "slide_two", occurrenceSeq: 2 },
            };
      },
      async subscribe(nextObserver) {
        observer = nextObserver;
        return { close() {} };
      },
      async recordApplied() {
        return { status: "STAGE_APPLIED" };
      },
    };
    const waitVisible = textMutation("Verified offline claim", true);
    render(
      <MemoryRouter initialEntries={["/display/display_alpha"]}>
        <StageRoutes client={client} />
      </MemoryRouter>,
    );
    const appliedSnapshot = await act(async () => snapshotApplied.promise);
    expect(appliedSnapshot).toEqual({
      stateHash: "a".repeat(64),
      publicPlaybackRevision: "pbr_0",
      publicCardRevision: "pcr_1",
      visibleCardIds: ["projection_curated"],
    });
    await act(async () => waitVisible);
    expect(within(document.body).getByText("Verified offline claim")).toBeTruthy();
    if (observer === null) throw new Error("Stage observer was not installed");
    const playback = {
      commandId: "cmd_one",
      presentationSessionEpoch: "pse_1",
      displayBindingEpoch: "dbe_1",
      acceptedControlRevision: "cr_1",
      publicPlaybackRevision: "pbr_1",
      occurrence: { publicSlideKey: "slide_two", occurrenceSeq: 2 },
      blackout: false,
    };
    await act(async () => {
      observer?.onPlayback(playback);
      observer?.onPlayback(playback);
    });
    expect(visibleEffects).toHaveLength(1);
    await act(async () => observer?.onClose("NETWORK_ERROR"));
    expect(within(document.body).getByText("Verified offline claim")).toBeTruthy();
    await act(async () =>
      observer?.onPlayback({
        ...playback,
        commandId: "cmd_stale_epoch",
        presentationSessionEpoch: "pse_2",
        publicPlaybackRevision: "pbr_2",
      }),
    );
    expect(within(document.body).queryByText("Verified offline claim")).toBeNull();
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
