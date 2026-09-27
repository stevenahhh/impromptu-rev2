import { afterEach, describe, expect, test } from "bun:test";
import { registerDom } from "@impromptu/test-harness";

registerDom();

const { act, cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");
const { RECONCILE_RECOVERY_LIMIT, StageRoutes } = await import("./App");
const copy = (await import("./locales/ko.json")).default;

import { StrictMode } from "react";
import type {
  DisplayIdentity,
  StageEventObserver,
  StagePlaybackEvent,
  StageSessionClient,
  StageSnapshotView,
} from "./stage-client";
import { DisplayJoinError } from "./stage-client";

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

function nextStageEvent(type: string, timeoutMs = 2_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(timeoutMs);
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

/** happy-dom's history.replaceState does not rewrite window.location, so the suite navigates
 * with location.href (which real navigation semantics resolve) and observes scrubbing through
 * a spy that bridges the replaceState URL onto the location, matching real browser behavior. */
function setStageUrl(url: string): void {
  window.location.href = url.startsWith("http") ? url : `https://stage.test${url}`;
}

function installHistorySpy(): { readonly calls: string[]; restore(): void } {
  const original = window.history.replaceState;
  const calls: string[] = [];
  const spy = function (
    this: History,
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ): void {
    calls.push(url === null || url === undefined ? "" : String(url));
    if (url !== undefined && url !== null) setStageUrl(String(url));
    original.call(this, data, unused, url);
  };
  window.history.replaceState = spy;
  return {
    calls,
    restore() {
      window.history.replaceState = original;
    },
  };
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

  test("projects a bare slide and renders no interactive control of any kind", async () => {
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

    // The audience surface offers nothing clickable: no buttons, links, form fields, or anything
    // masquerading as a button — fullscreen and placement controls included.
    const interactive = () =>
      document.querySelectorAll(
        "button, a[href], input, select, textarea, [role='button'], [tabindex]",
      );
    expect(interactive().length).toBe(0);
    expect(document.querySelector("[data-stage-fullscreen]")).toBeNull();
    expect(document.querySelector("[data-stage-placement]")).toBeNull();

    // Local input must not resurrect any chrome either.
    await act(async () => {
      fireEvent.keyDown(window, { key: "b" });
      fireEvent.pointerMove(window);
    });
    expect(interactive().length).toBe(0);
    expect(display?.getAttribute("data-stage-chrome")).toBe("hidden");
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
      // Resolving the deferred snapshot commits a DisplayPage state update, so resolution and
      // the resulting snapshot-applied event stay inside the same act scope.
      await act(async () => {
        pending.resolve(snapshot);
        expect(await recoveredApplied).toMatchObject({ publicPlaybackRevision: "pbr_0" });
      });
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
      <MemoryRouter initialEntries={["/?deck=deck_alpha&lang=ko"]}>
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

  test("ignores an invite fragment when a console window opened the page", async () => {
    const token = `dinv_${"d".repeat(64)}`;
    const posted: Array<{ data: unknown; origin: string }> = [];
    const removeOpener = installOpener((data, origin) => posted.push({ data, origin }));
    const joins: Array<{
      identity: DisplayIdentity;
      deckVersion: string;
      token: string | undefined;
    }> = [];
    const recordingClient: StageSessionClient = {
      ...landingClient({ value: false }),
      async createJoin(identity, deckVersion, invitationToken) {
        joins.push({ identity, deckVersion, token: invitationToken });
        return {
          ...identity,
          displayJoinId: "join_opener_path",
          deckVersion,
          expiresAtMs: Date.now() + 60_000,
        };
      },
    };
    const spy = installHistorySpy();
    setStageUrl(`/?deck=deck_alpha&lang=ko#invite=${token}`);
    try {
      await renderLanding(recordingClient);

      // The opener handshake keeps its existing shape: no invitation token is attached, and the
      // fragment is still scrubbed so the one-use secret cannot linger in the address bar.
      expect(joins.length).toBe(1);
      expect(joins[0]?.token).toBeUndefined();
      expect(spy.calls.some((url) => !url.includes("#"))).toBe(true);
      expect(window.location.hash).toBe("");
      expect(posted.length).toBe(1);
      expect(posted[0]?.origin).toBe(consoleOrigin);
    } finally {
      removeOpener();
      spy.restore();
      setStageUrl("/");
    }
  });

  // Both of these encode the current product decision: the bare Stage URL is NOT self-service.
  // A window the Console did not open stays inert, so the security property still holds — a
  // screen can only attach itself through a join the presenter's Console created and approved.
  test("shows only a neutral notice when no console window opened it", async () => {
    await renderLanding(landingClient({ value: false }));

    const en = await importEn();
    expect(document.body.textContent).toContain(en.consoleOnlyNotice);
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

describe("invitation-led pairing", () => {
  const validToken = `dinv_${"f".repeat(64)}`;
  let historySpy: ReturnType<typeof installHistorySpy> | null = null;

  afterEach(() => {
    historySpy?.restore();
    historySpy = null;
    setStageUrl("/");
  });

  function invitationClient(options?: {
    readonly joinError?: { current: Error | undefined };
    readonly expiresAtMs?: number;
    readonly approved?: { value: boolean };
  }) {
    const joins: Array<{
      identity: DisplayIdentity;
      deckVersion: string;
      invitationToken: string | undefined;
    }> = [];
    let claims = 0;
    const approved = options?.approved ?? { value: false };
    const client: StageSessionClient = {
      async createJoin(identity, deckVersion, invitationToken) {
        joins.push({ identity, deckVersion, invitationToken });
        const failure = options?.joinError?.current;
        if (failure !== undefined) throw failure;
        return {
          ...identity,
          displayJoinId: "join_invited",
          deckVersion,
          expiresAtMs: options?.expiresAtMs ?? Date.now() + 60_000,
        };
      },
      async claim() {
        claims += 1;
        if (!approved.value) throw new Error("PENDING_APPROVAL");
      },
      async snapshot() {
        return snapshot;
      },
      async subscribe() {
        return { close() {} };
      },
      async recordApplied() {
        return { status: "STAGE_APPLIED" };
      },
    };
    return { client, joins, claims: () => claims };
  }

  function joinError(status: number | undefined, reason?: string): Error {
    return new DisplayJoinError("Display join could not be created.", status, reason);
  }

  function renderInvitedLanding(client: StageSessionClient, strict = false) {
    historySpy = installHistorySpy();
    const routes = (
      <MemoryRouter initialEntries={["/"]}>
        <StageRoutes client={client} />
      </MemoryRouter>
    );
    render(strict ? <StrictMode>{routes}</StrictMode> : routes);
  }

  test("consumes the invite fragment once, shows the pending display identity, and joins on approval", async () => {
    const approval = { value: false };
    const { client, joins } = invitationClient({ approved: approval });
    const joined = nextStageEvent("impromptu:display-join");
    setStageUrl(`/?deck=deck_alpha&lang=ko#invite=${validToken}`);
    renderInvitedLanding(client);

    await act(async () => joined);
    // Exactly one join carries the token; the locator is not authority by itself.
    expect(joins.length).toBe(1);
    expect(joins[0]?.invitationToken).toBe(validToken);
    expect(joins[0]?.deckVersion).toBe("deck_alpha");
    // The fragment is gone from the address bar and history before the exchange resolves.
    expect(historySpy?.calls.some((url) => url.includes("#"))).toBe(false);
    expect(historySpy?.calls).toContain("/?deck=deck_alpha&lang=ko");
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(validToken);
    // The token stays in memory only: nothing reaches storage, cookies, or the DOM.
    expect(window.localStorage.getItem("invite")).toBeNull();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).not.toContain(validToken);
    expect(document.body.textContent).not.toContain(validToken);
    expect(document.querySelector(".stage-invitation")).not.toBeNull();
    expect(document.body.textContent).toContain(copy.waitingApproval);
    const joinedIdentity = joins[0]?.identity;
    if (joinedIdentity === undefined) throw new Error("join identity missing");
    expect(document.querySelector("[data-display-id]")?.textContent).toBe(joinedIdentity.displayId);
    expect(document.querySelector("[data-display-fingerprint]")?.textContent).toBe(
      joinedIdentity.displayFingerprint,
    );

    // Only the presenter's approval — modeled by claim() starting to succeed — moves the
    // Stage onto the public display surface. waitFor keeps an act scope alive around each
    // check so the interval-driven claim, navigation and display snapshot can commit.
    const applied = nextStageEvent("impromptu:snapshot-applied", 8_000);
    approval.value = true;
    await waitFor(
      () =>
        expect(
          document.querySelector(".stage-display")?.getAttribute("data-audience-readiness"),
        ).toBe("READY"),
      { timeout: 8_000 },
    );
    expect(await applied).toMatchObject({ publicPlaybackRevision: "pbr_0" });
    expect(within(document.body).getByRole("img", { name: "Slide one" })).toBeTruthy();
  });

  test("sends the join exactly once even under StrictMode double-mount", async () => {
    const { client, joins } = invitationClient();
    const joined = nextStageEvent("impromptu:display-join");
    setStageUrl(`/?deck=deck_alpha&lang=ko#invite=${validToken}`);
    renderInvitedLanding(client, true);

    await act(async () => joined);
    expect(joins.length).toBe(1);
    expect(joins[0]?.invitationToken).toBe(validToken);
  });

  test.each([
    ["INVITATION_UNKNOWN", 404],
    ["INVITATION_CONSUMED", 409],
    ["INVITATION_DECK_MISMATCH", 409],
  ])(
    "rejects a %s invitation (%i) without claiming or navigating",
    async (reason: string, status: number) => {
      const { client, joins, claims } = invitationClient({
        joinError: { current: joinError(status, reason) },
      });
      const failed = nextStageEvent("impromptu:invitation-failed");
      setStageUrl(`/?deck=deck_alpha&lang=ko#invite=${validToken}`);
      renderInvitedLanding(client);

      await act(async () => {
        await failed;
      });
      expect((await failed) as { reason: string }).toMatchObject({ reason });
      expect(joins.length).toBe(1);
      expect(claims()).toBe(0);
      expect(document.body.textContent).toContain(copy.invitationInvalid);
      expect(document.body.textContent).not.toContain(validToken);
      expect(document.querySelector(".stage-display")).toBeNull();
      // A rejected link is dead: no retry affordance that would just replay the same refusal.
      expect(document.querySelector("[data-invitation-retry]")).toBeNull();
    },
  );

  test("shows the expired state for an expired invitation", async () => {
    const { client, claims } = invitationClient({
      joinError: { current: joinError(410, "INVITATION_EXPIRED") },
    });
    const failed = nextStageEvent("impromptu:invitation-failed");
    setStageUrl(`/?deck=deck_alpha&lang=ko#invite=${validToken}`);
    renderInvitedLanding(client);

    await act(async () => {
      await failed;
    });
    expect((await failed) as { reason: string }).toMatchObject({
      reason: "INVITATION_EXPIRED",
    });
    expect(document.body.textContent).toContain(copy.invitationExpired);
    expect(claims()).toBe(0);
  });

  test("shows the expired state when the pending join outlives its window", async () => {
    const { client, joins } = invitationClient({ expiresAtMs: Date.now() - 1 });
    const expired = nextStageEvent("impromptu:invitation-expired");
    setStageUrl(`/?deck=deck_alpha&lang=ko#invite=${validToken}`);
    renderInvitedLanding(client);

    // The expiry check lives in the claim-polling effect, which React only flushes while an act
    // scope drains — awaiting the event inside act() would deadlock against that flush.
    await act(async () => {
      for (let tick = 0; tick < 16; tick += 1) await Promise.resolve();
    });
    expect(await expired).toEqual({ reason: "JOIN_EXPIRED" });
    expect(joins.length).toBe(1);
    expect(document.body.textContent).toContain(copy.invitationExpired);
    expect(document.querySelector(".stage-display")).toBeNull();
  });

  test("treats a malformed invite fragment as an invalid link without any join", async () => {
    const { client, joins } = invitationClient();
    setStageUrl("/?deck=deck_alpha&lang=ko#invite=not-a-token");
    renderInvitedLanding(client);
    await act(async () => {
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
    });

    expect(joins.length).toBe(0);
    expect(document.body.textContent).toContain(copy.invitationInvalid);
    expect(window.location.hash).toBe("");
  });

  test("offers a retry only for transient join failures", async () => {
    const transient = { current: joinError(503) as Error | undefined };
    const { client, joins } = invitationClient({ joinError: transient });
    const failed = nextStageEvent("impromptu:invitation-failed");
    setStageUrl(`/?deck=deck_alpha&lang=ko#invite=${validToken}`);
    renderInvitedLanding(client);

    await act(async () => failed);
    expect(document.body.textContent).toContain(copy.invitationRetryable);
    const retry = document.querySelector("[data-invitation-retry]");
    expect(retry).not.toBeNull();
    expect(joins.length).toBe(1);

    // With the transient failure cleared, the retry consumes the same in-memory token once more
    // and lands in the pending-approval state without any URL involvement.
    transient.current = undefined;
    const joined = nextStageEvent("impromptu:display-join");
    await act(async () => {
      fireEvent.click(retry as Element);
      await joined;
    });
    expect(joins.length).toBe(2);
    expect(joins[1]?.invitationToken).toBe(validToken);
    expect(document.body.textContent).toContain(copy.waitingApproval);
    expect(window.location.hash).toBe("");
  });
});

async function importEn() {
  return (await import("./locales/en.json")).default;
}

describe("audience language", () => {
  test("resolves the browser language, honors an explicit ?lang= override, and defaults to Korean", async () => {
    const { resolveStageLocale, stageMessages } = await import("./stage-i18n");
    expect(resolveStageLocale("", ["en-US", "en"])).toBe("en");
    expect(resolveStageLocale("", ["fr-FR", "ko-KR"])).toBe("ko");
    expect(resolveStageLocale("", [])).toBe("ko");
    expect(resolveStageLocale("?lang=en", ["ko-KR"])).toBe("en");
    expect(resolveStageLocale("?lang=ko", ["en-US"])).toBe("ko");
    expect(resolveStageLocale("?lang=zh", ["en-US"])).toBe("en");
    // Both catalogs expose the same key set so a resolved locale never renders a missing string.
    const koKeys = Object.keys(stageMessages("ko")).sort();
    expect(Object.keys(stageMessages("en")).sort()).toEqual(koKeys);
  });

  test("renders the Korean notice by default and the English one for an English device", async () => {
    const { stageMessages } = await import("./stage-i18n");
    const renderWithLanguages = async (languages: string[]) => {
      const original = Object.getOwnPropertyDescriptor(window.navigator, "languages");
      Object.defineProperty(window.navigator, "languages", {
        configurable: true,
        value: languages,
      });
      try {
        render(
          <MemoryRouter initialEntries={["/"]}>
            <StageRoutes client={stageClient(deferred())} />
          </MemoryRouter>,
        );
        await act(async () => {});
      } finally {
        if (original === undefined) {
          delete (window.navigator as { languages?: readonly string[] }).languages;
        } else {
          Object.defineProperty(window.navigator, "languages", original);
        }
      }
    };

    await renderWithLanguages(["en-US"]);
    expect(document.body.textContent).toContain(stageMessages("en").consoleOnlyNotice);
    cleanup();

    await renderWithLanguages(["ko-KR"]);
    expect(document.body.textContent).toContain(stageMessages("ko").consoleOnlyNotice);
    cleanup();
  });
});

describe("truthful slide failure", () => {
  test("a slide whose image cannot load reports SLIDE_FAILED instead of a blank READY", async () => {
    const observerSignal = deferred<StageEventObserver>();
    const snapshotApplied = nextStageEvent("impromptu:snapshot-applied");
    render(
      <MemoryRouter initialEntries={["/display/display_alpha?lang=ko"]}>
        <StageRoutes client={stageClient(observerSignal)} />
      </MemoryRouter>,
    );
    await act(async () => snapshotApplied);
    const display = document.querySelector(".stage-display");
    expect(display?.getAttribute("data-audience-readiness")).toBe("READY");

    const img = document.querySelector("img.stage-slide");
    expect(img).not.toBeNull();
    await act(async () => {
      fireEvent.error(img as Element);
    });

    expect(display?.getAttribute("data-audience-readiness")).toBe("SLIDE_FAILED");
    const en = await importEn();
    expect(document.body.textContent).toContain(en.slideUnavailable);
  });
});
