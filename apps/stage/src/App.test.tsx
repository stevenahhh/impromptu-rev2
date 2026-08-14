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

function nextStageEvent(type: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(2_000);
    window.addEventListener(
      type,
      (event) => resolve(event instanceof CustomEvent ? event.detail : null),
      { once: true, signal },
    );
    signal.addEventListener("abort", () => reject(new Error(`Stage event timeout: ${type}`)), {
      once: true,
    });
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

  test("observes one visible effect, renders cached navigation, and hides on stale playback", async () => {
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
    expect(within(document.body).getByRole("img", { name: "One" }).getAttribute("src")).toBe(
      "https://public.test/one.png",
    );
    const localSlide = deferred<unknown>();
    window.addEventListener(
      "impromptu:local-slide",
      (event) => localSlide.resolve(event instanceof CustomEvent ? event.detail : null),
      { once: true },
    );
    await act(async () => fireEvent.keyDown(window, { key: "ArrowRight" }));
    expect(await localSlide.promise).toEqual({
      publicSlideKey: "slide_two",
      occurrenceSeq: 2,
    });
    expect(within(document.body).getByRole("img", { name: "Two" }).getAttribute("src")).toBe(
      "https://public.test/two.png",
    );
    const installedObserver = observer as StageEventObserver | null;
    if (installedObserver === null) throw new Error("Stage observer was not installed");
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
      installedObserver.onPlayback(playback);
      installedObserver.onPlayback(playback);
    });
    expect(visibleEffects).toHaveLength(1);
    const staleHidden = deferred<unknown>();
    const waitHidden = textMutation("Verified offline claim", false);
    window.addEventListener(
      "impromptu:card-hidden",
      (event) => staleHidden.resolve(event instanceof CustomEvent ? event.detail : null),
      { once: true },
    );
    await act(async () =>
      installedObserver.onPlayback({
        ...playback,
        commandId: "cmd_stale_playback",
        publicPlaybackRevision: "pbr_3",
      }),
    );
    expect(await staleHidden.promise).toEqual({ reason: "STALE_EVENT" });
    await act(async () => waitHidden);
  });

  test("hides a visible card on an observed stale card event", async () => {
    let observer: StageEventObserver | null = null;
    const snapshotApplied = deferred<unknown>();
    window.addEventListener("impromptu:snapshot-applied", () => snapshotApplied.resolve(null), {
      once: true,
    });
    const liveCard: StageSnapshotView["cards"][number] = {
      projectionId: "projection_live",
      status: "PUBLISHED",
      mode: "LIVE",
      leaseExpiresAtMs: Date.now() + 2_000,
      claim: "Fresh live claim",
      supportSummary: "Visible support",
      sourceLabel: "Public source",
      publicCardRevision: "pcr_2",
    };
    const snapshot: StageSnapshotView = {
      role: "PUBLIC_STAGE",
      stateHash: "a".repeat(64),
      presentationSessionId: "ps_alpha",
      presentationSessionEpoch: "pse_1",
      displayBindingEpoch: "dbe_1",
      deckVersion: "deck_alpha",
      manifestHash: "b".repeat(64),
      deckSlides: [],
      publicPlaybackRevision: "pbr_0",
      blackout: false,
      occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
      cards: [liveCard],
      publicCardRevision: "pcr_2",
      tombstoneWatermark: "pcr_0",
      tombstoneRetentionMs: 60_000,
    };
    const client: StageSessionClient = {
      async createJoin() {
        throw new Error("not used");
      },
      async claim() {},
      async snapshot() {
        return snapshot;
      },
      async subscribe(nextObserver) {
        observer = nextObserver;
        return { close() {} };
      },
      async recordApplied() {
        return null;
      },
    };
    const waitVisible = textMutation("Fresh live claim", true);
    render(
      <MemoryRouter initialEntries={["/display/display_alpha"]}>
        <StageRoutes client={client} />
      </MemoryRouter>,
    );
    await act(async () => snapshotApplied.promise);
    await act(async () => waitVisible);
    const installedObserver = observer as StageEventObserver | null;
    if (installedObserver === null) throw new Error("Stage observer was not installed");
    const staleHidden = deferred<unknown>();
    const waitHidden = textMutation("Fresh live claim", false);
    window.addEventListener(
      "impromptu:card-hidden",
      (event) => staleHidden.resolve(event instanceof CustomEvent ? event.detail : null),
      { once: true },
    );
    await act(async () => installedObserver.onCard({ ...liveCard, publicCardRevision: "pcr_1" }));
    expect(await staleHidden.promise).toEqual({ reason: "STALE_EVENT" });
    await act(async () => waitHidden);
  });

  test("hides a verified curated card at local expiry while partitioned", async () => {
    let observer: StageEventObserver | null = null;
    const reconnectSnapshot = deferred<StageSnapshotView>();
    const localExpiresAtMs = Date.now() + 500;
    const snapshot: StageSnapshotView = {
      role: "PUBLIC_STAGE",
      stateHash: "a".repeat(64),
      presentationSessionId: "ps_alpha",
      presentationSessionEpoch: "pse_1",
      displayBindingEpoch: "dbe_1",
      deckVersion: "deck_alpha",
      manifestHash: "b".repeat(64),
      deckSlides: [],
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
            localExpiresAtMs,
            signature: "verified-fixture",
            signatureVerified: true,
          },
          claim: "Expiring curated claim",
          supportSummary: "Partition-safe only until expiry",
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
      snapshot() {
        snapshotReads += 1;
        return snapshotReads === 1 ? Promise.resolve(snapshot) : reconnectSnapshot.promise;
      },
      async subscribe(nextObserver) {
        observer = nextObserver;
        return { close() {} };
      },
      async recordApplied() {
        return null;
      },
    };
    const snapshotApplied = nextStageEvent("impromptu:snapshot-applied");
    const waitVisible = textMutation("Expiring curated claim", true);
    render(
      <MemoryRouter initialEntries={["/display/display_alpha"]}>
        <StageRoutes client={client} />
      </MemoryRouter>,
    );
    await act(async () => snapshotApplied);
    await act(async () => waitVisible);
    const installedObserver = observer as StageEventObserver | null;
    if (installedObserver === null) throw new Error("Stage observer was not installed");
    const hidden = nextStageEvent("impromptu:card-hidden");
    await act(async () => installedObserver.onClose("NETWORK_ERROR"));
    expect(await act(async () => hidden)).toEqual({
      projectionId: "projection_curated",
      reason: "LOCAL_EXPIRY",
    });
    expect(within(document.body).queryByText("Expiring curated claim")).toBeNull();
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
