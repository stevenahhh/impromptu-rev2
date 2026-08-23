import { afterAll, afterEach, describe, expect, jest, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());

const { act, cleanup, fireEvent, render, within } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");
const { CHROME_HIDE_IDLE_MS, RECONCILE_RECOVERY_LIMIT, StageRoutes } = await import("./App");
const copy = (await import("./locales/ko.json")).default;

import type {
  StageEventObserver,
  StagePlaybackEvent,
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

afterEach(() => cleanup());

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
      accessibilityLabel: "Slide one",
    },
    {
      publicSlideKey: "slide_two",
      ordinal: 2,
      imageUrl: "https://public.test/two.png",
      imageContentHash: "d".repeat(64),
      accessibilityLabel: "Slide two",
    },
  ],
  publicPlaybackRevision: "pbr_0",
  blackout: false,
  occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
};

function playbackEvent(
  commandId: string,
  publicPlaybackRevision: string,
  occurrenceSeq: number,
  publicSlideKey: string,
): StagePlaybackEvent {
  return {
    commandId,
    presentationSessionEpoch: "pse_1",
    displayBindingEpoch: "dbe_1",
    acceptedControlRevision: "cr_1",
    publicPlaybackRevision,
    occurrence: { publicSlideKey, occurrenceSeq },
    blackout: false,
  };
}

function stageClient(
  observerSignal: ReturnType<typeof deferred<StageEventObserver>>,
  value: StageSnapshotView = snapshot,
): StageSessionClient {
  return {
    async createJoin() {
      throw new Error("not used");
    },
    async claim() {},
    async snapshot() {
      return value;
    },
    async subscribe(observer) {
      observerSignal.resolve(observer);
      return { close() {} };
    },
    async recordApplied() {
      return { status: "STAGE_APPLIED" };
    },
  };
}

describe("slide-only public Stage", () => {
  test("renders no evidence or source DOM even when a malicious snapshot object carries cards", async () => {
    const observerSignal = deferred<StageEventObserver>();
    const snapshotApplied = nextStageEvent("impromptu:snapshot-applied");
    const injected = {
      ...snapshot,
      cards: [
        {
          projectionId: "projection_curated",
          status: "PUBLISHED",
          mode: "CURATED",
          claim: "CURATED CARD SENTINEL",
          supportSummary: "SUPPORT SENTINEL",
          sourceLabel: "SOURCE SENTINEL",
          publicCardRevision: "pcr_1",
        },
        {
          projectionId: "projection_live",
          status: "PUBLISHED",
          mode: "LIVE",
          claim: "LIVE CARD SENTINEL",
          supportSummary: "LIVE SUPPORT SENTINEL",
          sourceLabel: "LIVE SOURCE SENTINEL",
          publicCardRevision: "pcr_2",
        },
      ],
    };
    render(
      <MemoryRouter initialEntries={["/display/display_alpha"]}>
        <StageRoutes client={stageClient(observerSignal, injected)} />
      </MemoryRouter>,
    );

    await act(async () => snapshotApplied);
    expect(within(document.body).getByRole("img", { name: "Slide one" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("CURATED CARD SENTINEL");
    expect(document.body.textContent).not.toContain("LIVE CARD SENTINEL");
    expect(document.body.textContent).not.toContain("SOURCE SENTINEL");
    expect(document.querySelector(".stage-evidence")).toBeNull();
    await observerSignal.promise;
  });

  test("applies contiguous slide playback and does not apply a revision gap", async () => {
    const observerSignal = deferred<StageEventObserver>();
    const snapshotApplied = nextStageEvent("impromptu:snapshot-applied");
    render(
      <MemoryRouter initialEntries={["/display/display_alpha"]}>
        <StageRoutes client={stageClient(observerSignal)} />
      </MemoryRouter>,
    );
    await act(async () => snapshotApplied);
    const observer = await observerSignal.promise;
    const visible = nextStageEvent("impromptu:visible-playback");
    await act(async () =>
      observer.onPlayback({
        commandId: "cmd_one",
        presentationSessionEpoch: "pse_1",
        displayBindingEpoch: "dbe_1",
        acceptedControlRevision: "cr_1",
        publicPlaybackRevision: "pbr_1",
        occurrence: { publicSlideKey: "slide_two", occurrenceSeq: 2 },
        blackout: false,
      }),
    );
    expect(await visible).toMatchObject({ commandId: "cmd_one" });
    expect(within(document.body).getByRole("img", { name: "Slide two" })).toBeTruthy();

    const reconcile = nextStageEvent("impromptu:reconcile-required");
    const reconciledSnapshot = nextStageEvent("impromptu:snapshot-applied");
    await act(async () =>
      observer.onPlayback({
        commandId: "cmd_gap",
        presentationSessionEpoch: "pse_1",
        displayBindingEpoch: "dbe_1",
        acceptedControlRevision: "cr_3",
        publicPlaybackRevision: "pbr_3",
        occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 3 },
        blackout: false,
      }),
    );
    expect(await reconcile).toEqual({ reason: "REVISION_GAP" });
    // The gapped command is never applied directly; recovery re-fetches the authoritative
    // snapshot, which still sits at the pre-gap revision.
    expect(await reconciledSnapshot).toMatchObject({ publicPlaybackRevision: "pbr_0" });
  });

  test("keeps applied playback when a reconnect snapshot still lags the recorded receipt", async () => {
    const observers: StageEventObserver[] = [];
    const appliedCommandIds: string[] = [];
    const client: StageSessionClient = {
      async createJoin() {
        throw new Error("not used");
      },
      async claim() {},
      async snapshot() {
        // The gateway records a revision only once the Stage receipt round-trips, so a reconnect
        // inside that window keeps serving the pre-command revision.
        return snapshot;
      },
      async subscribe(observer) {
        observers.push(observer);
        return { close() {} };
      },
      async recordApplied(event) {
        appliedCommandIds.push(event.commandId);
        return {
          status: "STAGE_APPLIED",
          commandId: event.commandId,
          presentationSessionEpoch: event.presentationSessionEpoch,
          displayBindingEpoch: event.displayBindingEpoch,
          publicPlaybackRevision: event.publicPlaybackRevision,
          appliedAtMs: 1,
        };
      },
    };
    const firstSnapshotApplied = nextStageEvent("impromptu:snapshot-applied");
    render(
      <MemoryRouter initialEntries={["/display/display_alpha"]}>
        <StageRoutes client={client} />
      </MemoryRouter>,
    );
    await act(async () => firstSnapshotApplied);
    const observer = observers[0];
    if (observer === undefined) throw new Error("Stage did not subscribe");

    const firstReceipt = nextStageEvent("impromptu:playback-applied");
    await act(async () =>
      observer.onPlayback({
        commandId: "cmd_one",
        presentationSessionEpoch: "pse_1",
        displayBindingEpoch: "dbe_1",
        acceptedControlRevision: "cr_1",
        publicPlaybackRevision: "pbr_1",
        occurrence: { publicSlideKey: "slide_two", occurrenceSeq: 2 },
        blackout: false,
      }),
    );
    expect(await firstReceipt).toMatchObject({ commandId: "cmd_one" });

    const reconnectSnapshotApplied = nextStageEvent("impromptu:snapshot-applied");
    await act(async () => observer.onClose("NETWORK_ERROR"));
    expect(await reconnectSnapshotApplied).toMatchObject({ publicPlaybackRevision: "pbr_1" });

    const reconnectObserver = observers[observers.length - 1];
    if (reconnectObserver === undefined) throw new Error("Stage did not resubscribe");
    const secondReceipt = nextStageEvent("impromptu:playback-applied");
    await act(async () =>
      reconnectObserver.onPlayback({
        commandId: "cmd_two",
        presentationSessionEpoch: "pse_1",
        displayBindingEpoch: "dbe_1",
        acceptedControlRevision: "cr_2",
        publicPlaybackRevision: "pbr_2",
        occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 3 },
        blackout: false,
      }),
    );
    expect(await secondReceipt).toMatchObject({ commandId: "cmd_two" });
    expect(appliedCommandIds).toEqual(["cmd_one", "cmd_two"]);
  });

  test("recovers automatically after a revision gap by re-fetching the authoritative snapshot", async () => {
    const observers: StageEventObserver[] = [];
    const recoveredSnapshot: StageSnapshotView = {
      ...snapshot,
      publicPlaybackRevision: "pbr_3",
      occurrence: { publicSlideKey: "slide_two", occurrenceSeq: 4 },
    };
    let snapshotFetches = 0;
    const client: StageSessionClient = {
      async createJoin() {
        throw new Error("not used");
      },
      async claim() {},
      async snapshot() {
        snapshotFetches += 1;
        return snapshotFetches === 1 ? snapshot : recoveredSnapshot;
      },
      async subscribe(observer) {
        observers.push(observer);
        return { close() {} };
      },
      async recordApplied() {
        return { status: "STAGE_APPLIED" };
      },
    };
    const initialSnapshotApplied = nextStageEvent("impromptu:snapshot-applied");
    render(
      <MemoryRouter initialEntries={["/display/display_alpha"]}>
        <StageRoutes client={client} />
      </MemoryRouter>,
    );
    await act(async () => initialSnapshotApplied);
    const observer = observers[0];
    if (observer === undefined) throw new Error("Stage did not subscribe");

    const visible = nextStageEvent("impromptu:visible-playback");
    await act(async () => observer.onPlayback(playbackEvent("cmd_one", "pbr_1", 2, "slide_two")));
    expect(await visible).toMatchObject({ commandId: "cmd_one" });

    const reconcile = nextStageEvent("impromptu:reconcile-required");
    const recovered = nextStageEvent("impromptu:snapshot-applied");
    await act(async () => observer.onPlayback(playbackEvent("cmd_gap", "pbr_3", 3, "slide_one")));
    expect(await reconcile).toEqual({ reason: "REVISION_GAP" });
    expect(await recovered).toMatchObject({ publicPlaybackRevision: "pbr_3" });
    expect(snapshotFetches).toBe(2);

    const display = document.querySelector(".stage-display");
    expect(display?.getAttribute("data-audience-readiness")).toBe("READY");
    expect(within(document.body).getByRole("img", { name: "Slide two" })).toBeTruthy();

    const resumed = nextStageEvent("impromptu:visible-playback");
    await act(async () => observer.onPlayback(playbackEvent("cmd_four", "pbr_4", 5, "slide_one")));
    expect(await resumed).toMatchObject({ commandId: "cmd_four" });
    expect(within(document.body).getByRole("img", { name: "Slide one" })).toBeTruthy();
  });

  test("projects a bare slide and reveals controls only while the presenter interacts", async () => {
    const observerSignal = deferred<StageEventObserver>();
    const snapshotApplied = nextStageEvent("impromptu:snapshot-applied");
    render(
      <MemoryRouter initialEntries={["/display/display_alpha"]}>
        <StageRoutes client={stageClient(observerSignal)} />
      </MemoryRouter>,
    );
    await act(async () => snapshotApplied);
    expect(within(document.body).getByRole("img", { name: "Slide one" })).toBeTruthy();

    // Audience-only chrome is gone from the DOM outright — not merely styled away — so it can
    // never reappear on a projector.
    const display = document.querySelector(".stage-display");
    const visibleText = document.body.textContent ?? "";
    for (const noise of ["청중 전용", "미리보기", "확장", "복제", "청중 화면"]) {
      expect(visibleText).not.toContain(noise);
    }

    // The drive controls stay mounted for gesture-driven use, but hidden until local input.
    expect(display?.getAttribute("data-stage-chrome")).toBe("hidden");
    expect(document.querySelector("[data-stage-fullscreen]")).toBeInstanceOf(HTMLElement);
    expect(document.querySelector("[data-stage-placement]")).toBeInstanceOf(HTMLElement);

    // Fake timers must already govern the clock when the input lands, so the idle timeout the
    // reveal schedules is one we can advance deterministically.
    // bun-types@1.2.20 omits the fake-clock controls from its jest typing even though the
    // runtime implements them, hence the structural cast.
    const fakeClock = jest as unknown as {
      useFakeTimers(): void;
      advanceTimersByTime(milliseconds: number): void;
      useRealTimers(): void;
    };
    fakeClock.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.keyDown(window, { key: "b" });
      });
      expect(display?.getAttribute("data-stage-chrome")).toBe("visible");

      await act(async () => {
        fakeClock.advanceTimersByTime(CHROME_HIDE_IDLE_MS + 1_000);
      });
      expect(display?.getAttribute("data-stage-chrome")).toBe("hidden");
    } finally {
      fakeClock.useRealTimers();
    }
  });

  test("bounds automatic recovery refetches when the snapshot never becomes usable", async () => {
    const observers: StageEventObserver[] = [];
    const pendingRefetches: ReturnType<typeof deferred<StageSnapshotView>>[] = [];
    let initialFetchDone = false;
    const client: StageSessionClient = {
      async createJoin() {
        throw new Error("not used");
      },
      async claim() {},
      async snapshot() {
        if (!initialFetchDone) {
          initialFetchDone = true;
          return snapshot;
        }
        const pending = deferred<StageSnapshotView>();
        pendingRefetches.push(pending);
        return pending.promise;
      },
      async subscribe(observer) {
        observers.push(observer);
        return { close() {} };
      },
      async recordApplied() {
        return { status: "STAGE_APPLIED" };
      },
    };
    const initialSnapshotApplied = nextStageEvent("impromptu:snapshot-applied");
    render(
      <MemoryRouter initialEntries={["/display/display_alpha"]}>
        <StageRoutes client={client} />
      </MemoryRouter>,
    );
    await act(async () => initialSnapshotApplied);
    const observer = observers[0];
    if (observer === undefined) throw new Error("Stage did not subscribe");

    const visible = nextStageEvent("impromptu:visible-playback");
    await act(async () => observer.onPlayback(playbackEvent("cmd_one", "pbr_1", 2, "slide_two")));
    expect(await visible).toMatchObject({ commandId: "cmd_one" });

    for (let attempt = 0; attempt < RECONCILE_RECOVERY_LIMIT; attempt += 1) {
      const reconcile = nextStageEvent("impromptu:reconcile-required");
      await act(async () =>
        observer.onPlayback(playbackEvent(`cmd_gap_${attempt}`, "pbr_5", 9, "slide_one")),
      );
      expect(await reconcile).toEqual({ reason: "REVISION_GAP" });
      const pending = pendingRefetches[attempt];
      if (pending === undefined) throw new Error(`Recovery refetch ${attempt} did not run`);
      const recoveredApplied = nextStageEvent("impromptu:snapshot-applied");
      pending.resolve(snapshot);
      expect(await recoveredApplied).toMatchObject({ publicPlaybackRevision: "pbr_0" });
    }
    expect(pendingRefetches.length).toBe(RECONCILE_RECOVERY_LIMIT);

    // The limit is reached: a further gap must publish reconcile-required without refetching.
    const finalReconcile = nextStageEvent("impromptu:reconcile-required");
    await act(async () =>
      observer.onPlayback(playbackEvent("cmd_gap_final", "pbr_5", 9, "slide_one")),
    );
    expect(await finalReconcile).toEqual({ reason: "REVISION_GAP" });
    expect(pendingRefetches.length).toBe(RECONCILE_RECOVERY_LIMIT);
    expect(document.querySelector(".stage-display")?.getAttribute("data-audience-readiness")).toBe(
      "RECOVERING",
    );
  });
});

describe("console-led pairing", () => {
  const consoleOrigin = "http://localhost:4173";

  function landingClient(approved: { value: boolean }): StageSessionClient {
    return {
      async createJoin(identity, deckVersion) {
        return {
          ...identity,
          displayJoinId: "join_console_led",
          deckVersion,
          expiresAtMs: Date.now() + 60_000,
        };
      },
      async claim() {
        if (!approved.value) throw new Error("PENDING_APPROVAL");
      },
      async snapshot() {
        throw new Error("not used");
      },
      async subscribe() {
        throw new Error("not used");
      },
      async recordApplied() {
        return { status: "STAGE_APPLIED" };
      },
    };
  }

  /**
   * Renders the landing page and deterministically drains the join-creation microtasks inside
   * an act scope, so the resulting state commit is flushed before the assertions below.
   */
  async function renderLanding(client: StageSessionClient) {
    const view = render(
      <MemoryRouter initialEntries={["/?deck=deck_alpha"]}>
        <StageRoutes client={client} />
      </MemoryRouter>,
    );
    await act(async () => {
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
    });
    return view;
  }

  function installOpener(postMessage: (data: unknown, origin: string) => void): () => void {
    const referrerDescriptor = Object.getOwnPropertyDescriptor(document, "referrer");
    Object.defineProperty(document, "referrer", {
      value: `${consoleOrigin}/session`,
      configurable: true,
    });
    const openerDescriptor = Object.getOwnPropertyDescriptor(window, "opener");
    Object.defineProperty(window, "opener", { value: { postMessage }, configurable: true });
    return () => {
      if (referrerDescriptor === undefined) delete (document as { referrer?: string }).referrer;
      else Object.defineProperty(document, "referrer", referrerDescriptor);
      if (openerDescriptor === undefined) delete (window as { opener?: unknown }).opener;
      else Object.defineProperty(window, "opener", openerDescriptor);
    };
  }

  test("hands the display join to the console window that opened it", async () => {
    const posted: Array<{ data: unknown; origin: string }> = [];
    const removeOpener = installOpener((data, origin) => posted.push({ data, origin }));
    const approved = { value: false };
    try {
      await renderLanding(landingClient(approved));

      // The join handoff must reach the opener without any presenter interaction.
      expect(posted.length).toBe(1);
      expect(posted[0]?.origin).toBe(consoleOrigin);
      const data = posted[0]?.data as Record<string, unknown> | undefined;
      expect(data?.kind).toBe("impromptu:display-join");
      const join = data?.join as Record<string, unknown> | undefined;
      expect(join?.displayJoinId).toBe("join_console_led");
      expect(join?.displayId).toBeTruthy();
    } finally {
      removeOpener();
    }
  });

  // Both of these encode the current product decision: the bare Stage URL is NOT self-service.
  // A window the Console did not open stays inert, so the security property still holds — a
  // screen can only attach itself through a join the presenter's Console created and approved.
  test("shows only a neutral notice when no console window opened it", async () => {
    await renderLanding(landingClient({ value: false }));

    expect(document.body.textContent).toContain(copy.consoleOnlyNotice);
    expect(document.querySelector(".stage-placement-hint")).toBeNull();
    expect(document.querySelector("[data-display-claim]")).toBeNull();
    expect(document.querySelector(".stage-connection-code")).toBeNull();
    expect(document.querySelector("[data-topology-instructions]")).toBeNull();
    expect(document.body.textContent).not.toContain("join_console_led");
  });

  test("never creates a join or offers any way to attach itself without an opener", async () => {
    let joinsCreated = 0;
    let claimsAttempted = 0;
    const inertClient: StageSessionClient = {
      ...landingClient({ value: true }),
      async createJoin(identity, deckVersion) {
        joinsCreated += 1;
        return landingClient({ value: true }).createJoin(identity, deckVersion);
      },
      async claim() {
        claimsAttempted += 1;
      },
    };
    await renderLanding(inertClient);
    // Drain every effect/microtask the page could possibly schedule before judging it inert.
    await act(async () => {
      for (let tick = 0; tick < 32; tick += 1) await Promise.resolve();
    });

    expect(joinsCreated).toBe(0);
    expect(claimsAttempted).toBe(0);
    expect(document.querySelectorAll("button, input").length).toBe(0);
  });
});
