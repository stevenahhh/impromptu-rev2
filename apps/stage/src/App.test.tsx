import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());

const { act, cleanup, render, within } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");
const { StageRoutes } = await import("./App");

import type { StageEventObserver, StageSessionClient, StageSnapshotView } from "./stage-client";

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
    expect(document.querySelector(".stage-slide")).toBeNull();
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
});
