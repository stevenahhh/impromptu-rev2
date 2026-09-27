import { afterEach, describe, expect, test } from "bun:test";
import { registerDom } from "@impromptu/test-harness";

registerDom();

const { act, cleanup, render } = await import("@testing-library/react");
const { useEffect } = await import("react");

const { useAudienceScreen } = await import("./audience-screen");

import type {
  AudienceScreenController,
  AudienceScreenOutcome,
  UseAudienceScreenInput,
} from "./audience-screen";
import type { DisplayJoinView } from "./session-client";

afterEach(cleanup);

const STAGE_ORIGIN = "https://stage.example";
const DECK_VERSION = "deck_v7";
const STAGE_URL = `${STAGE_ORIGIN}/?deck=${DECK_VERSION}`;

function makeJoin(deckVersion: string = DECK_VERSION): DisplayJoinView {
  return {
    displayJoinId: "join_1",
    displayId: "display_room",
    displayFingerprint: "fp_room",
    deckVersion,
    expiresAtMs: Number.MAX_SAFE_INTEGER,
  };
}

interface InputOverrides {
  readonly approveJoin?: UseAudienceScreenInput["approveJoin"];
  readonly onBound?: UseAudienceScreenInput["onBound"];
  readonly joinTimeoutMs?: number;
}

function makeInput(overrides: InputOverrides = {}): UseAudienceScreenInput {
  return {
    stageOrigin: STAGE_ORIGIN,
    stageUrl: STAGE_URL,
    deckVersion: DECK_VERSION,
    approveJoin:
      overrides.approveJoin ??
      (async () => {
        return { displayBindingEpoch: "epoch_1" };
      }),
    onBound: overrides.onBound ?? (() => {}),
    ...(overrides.joinTimeoutMs === undefined ? {} : { joinTimeoutMs: overrides.joinTimeoutMs }),
  };
}

function Probe({
  input,
  controllerBox,
}: {
  readonly input: UseAudienceScreenInput;
  readonly controllerBox: { current: AudienceScreenController | null };
}) {
  const controller = useAudienceScreen(input);
  useEffect(() => {
    controllerBox.current = controller;
  });
  return (
    <p
      data-audience-status={controller.status}
      data-pending-display={controller.pendingJoin?.displayId ?? ""}
    />
  );
}

function renderProbe(input: UseAudienceScreenInput) {
  const controllerBox: { current: AudienceScreenController | null } = { current: null };
  const view = render(<Probe input={input} controllerBox={controllerBox} />);
  const controller = (): AudienceScreenController => {
    if (controllerBox.current === null) throw new Error("probe controller missing");
    return controllerBox.current;
  };
  return { view, controller };
}

interface OpenCall {
  readonly url: string;
  readonly target: string;
  readonly features: string;
}

function stubWindowOpen(open: () => Window | null) {
  const calls: OpenCall[] = [];
  const originalOpen = window.open;
  window.open = ((url?: string | URL, target?: string, features?: string) => {
    calls.push({ url: String(url), target: String(target), features: String(features) });
    return open();
  }) as typeof window.open;
  return {
    calls,
    restore(): void {
      window.open = originalOpen;
    },
  };
}

function dispatchDisplayJoin(options: {
  readonly origin?: string;
  readonly source?: Window | null;
  readonly join?: DisplayJoinView;
  readonly data?: unknown;
}): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      origin: options.origin ?? STAGE_ORIGIN,
      ...(options.source === undefined ? {} : { source: options.source }),
      data: options.data ?? { kind: "impromptu:display-join", join: options.join ?? makeJoin() },
    }),
  );
}

function recordingApprove(approvals: DisplayJoinView[], epoch: string) {
  return async (join: DisplayJoinView) => {
    approvals.push(join);
    return { displayBindingEpoch: epoch };
  };
}

describe("useAudienceScreen", () => {
  test("opens the stage popup synchronously and reports a blocked popup", async () => {
    const stub = stubWindowOpen(() => null);
    try {
      const { controller } = renderProbe(makeInput());
      let outcome: AudienceScreenOutcome | undefined;
      await act(async () => {
        outcome = await controller().openAndBind();
      });
      expect(stub.calls).toEqual([
        { url: STAGE_URL, target: "impromptu-stage", features: "popup" },
      ]);
      expect(outcome).toEqual({ kind: "POPUP_BLOCKED" });
      expect(controller().status).toBe("POPUP_BLOCKED");
    } finally {
      stub.restore();
    }
  });

  test("binds the window it opened with no second confirmation", async () => {
    const child = {} as Window;
    const stub = stubWindowOpen(() => child);
    const approvals: DisplayJoinView[] = [];
    const boundEpochs: string[] = [];
    try {
      const { controller } = renderProbe(
        makeInput({
          approveJoin: recordingApprove(approvals, "epoch_42"),
          onBound: (epoch) => boundEpochs.push(epoch),
          joinTimeoutMs: 200,
        }),
      );
      const pendingBox: { current: Promise<AudienceScreenOutcome> | null } = { current: null };
      await act(async () => {
        pendingBox.current = controller().openAndBind();
      });
      expect(controller().status).toBe("WAITING_JOIN");
      const pending = pendingBox.current;
      if (pending === null) throw new Error("openAndBind did not start");
      let outcome: AudienceScreenOutcome | undefined;
      await act(async () => {
        dispatchDisplayJoin({ source: child });
        outcome = await pending;
      });
      expect(outcome).toEqual({ kind: "CONNECTED", displayBindingEpoch: "epoch_42" });
      expect(controller().status).toBe("CONNECTED");
      expect(approvals).toEqual([makeJoin()]);
      expect(boundEpochs).toEqual(["epoch_42"]);
      expect(controller().pendingJoin).toBeNull();
    } finally {
      stub.restore();
    }
  });

  test("times out when the opened screen never sends a join", async () => {
    const stub = stubWindowOpen(() => ({}) as Window);
    const approvals: DisplayJoinView[] = [];
    try {
      const { controller } = renderProbe(
        makeInput({ joinTimeoutMs: 20, approveJoin: recordingApprove(approvals, "epoch_x") }),
      );
      let outcome: AudienceScreenOutcome | undefined;
      await act(async () => {
        outcome = await controller().openAndBind();
      });
      expect(outcome).toEqual({ kind: "JOIN_TIMEOUT" });
      expect(controller().status).toBe("JOIN_TIMEOUT");
      expect(approvals).toEqual([]);
    } finally {
      stub.restore();
    }
  });

  test("holds a join from a different window for explicit approval and never auto-binds it", async () => {
    const child = {} as Window;
    const stranger = {} as Window;
    const stub = stubWindowOpen(() => child);
    const approvals: DisplayJoinView[] = [];
    try {
      const { controller } = renderProbe(
        makeInput({ joinTimeoutMs: 20, approveJoin: recordingApprove(approvals, "epoch_1") }),
      );
      const pendingBox: { current: Promise<AudienceScreenOutcome> | null } = { current: null };
      await act(async () => {
        pendingBox.current = controller().openAndBind();
      });
      const pending = pendingBox.current;
      if (pending === null) throw new Error("openAndBind did not start");
      await act(async () => {
        dispatchDisplayJoin({ source: stranger });
      });
      expect(controller().pendingJoin?.displayId).toBe("display_room");
      expect(controller().status).toBe("WAITING_JOIN");
      expect(approvals).toEqual([]);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await act(async () => {});
      expect(settled).toBe(false);
      let outcome: AudienceScreenOutcome | undefined;
      await act(async () => {
        outcome = await pending;
      });
      expect(outcome).toEqual({ kind: "JOIN_TIMEOUT" });
      expect(approvals).toEqual([]);
    } finally {
      stub.restore();
    }
  });

  test("holds a join with no source at all for explicit approval", async () => {
    const child = {} as Window;
    const stub = stubWindowOpen(() => child);
    const approvals: DisplayJoinView[] = [];
    try {
      const { controller } = renderProbe(
        makeInput({ joinTimeoutMs: 20, approveJoin: recordingApprove(approvals, "epoch_1") }),
      );
      const pendingBox: { current: Promise<AudienceScreenOutcome> | null } = { current: null };
      await act(async () => {
        pendingBox.current = controller().openAndBind();
      });
      await act(async () => {
        dispatchDisplayJoin({});
      });
      expect(controller().pendingJoin?.displayId).toBe("display_room");
      expect(approvals).toEqual([]);
    } finally {
      stub.restore();
    }
  });

  test("ignores messages from foreign origins entirely", async () => {
    const child = {} as Window;
    const stub = stubWindowOpen(() => child);
    try {
      const { controller } = renderProbe(makeInput({ joinTimeoutMs: 20 }));
      await act(async () => {
        dispatchDisplayJoin({ origin: "https://evil.example" });
      });
      expect(controller().status).toBe("IDLE");
      expect(controller().pendingJoin).toBeNull();
      const pendingBox: { current: Promise<AudienceScreenOutcome> | null } = { current: null };
      await act(async () => {
        pendingBox.current = controller().openAndBind();
      });
      const pending = pendingBox.current;
      if (pending === null) throw new Error("openAndBind did not start");
      await act(async () => {
        dispatchDisplayJoin({ origin: "https://evil.example", source: child });
      });
      expect(controller().pendingJoin).toBeNull();
      expect(controller().status).toBe("WAITING_JOIN");
      let outcome: AudienceScreenOutcome | undefined;
      await act(async () => {
        outcome = await pending;
      });
      expect(outcome).toEqual({ kind: "JOIN_TIMEOUT" });
    } finally {
      stub.restore();
    }
  });

  test("ignores joins whose deck version differs from the session", async () => {
    const child = {} as Window;
    const stub = stubWindowOpen(() => child);
    const approvals: DisplayJoinView[] = [];
    try {
      const { controller } = renderProbe(
        makeInput({ joinTimeoutMs: 20, approveJoin: recordingApprove(approvals, "epoch_1") }),
      );
      const pendingBox: { current: Promise<AudienceScreenOutcome> | null } = { current: null };
      await act(async () => {
        pendingBox.current = controller().openAndBind();
      });
      const pending = pendingBox.current;
      if (pending === null) throw new Error("openAndBind did not start");
      await act(async () => {
        dispatchDisplayJoin({ source: child, join: makeJoin("deck_other") });
      });
      expect(controller().pendingJoin).toBeNull();
      expect(approvals).toEqual([]);
      let outcome: AudienceScreenOutcome | undefined;
      await act(async () => {
        outcome = await pending;
      });
      expect(outcome).toEqual({ kind: "JOIN_TIMEOUT" });
      expect(approvals).toEqual([]);
    } finally {
      stub.restore();
    }
  });

  test("ignores payloads that are not display-join envelopes", async () => {
    const child = {} as Window;
    const stub = stubWindowOpen(() => child);
    const approvals: DisplayJoinView[] = [];
    try {
      const { controller } = renderProbe(
        makeInput({ joinTimeoutMs: 20, approveJoin: recordingApprove(approvals, "epoch_1") }),
      );
      const pendingBox: { current: Promise<AudienceScreenOutcome> | null } = { current: null };
      await act(async () => {
        pendingBox.current = controller().openAndBind();
      });
      const pending = pendingBox.current;
      if (pending === null) throw new Error("openAndBind did not start");
      await act(async () => {
        dispatchDisplayJoin({ source: child, data: { kind: "impromptu:something-else" } });
      });
      await act(async () => {
        dispatchDisplayJoin({
          source: child,
          data: { kind: "impromptu:display-join", join: { displayId: "incomplete" } },
        });
      });
      expect(controller().pendingJoin).toBeNull();
      expect(approvals).toEqual([]);
      let outcome: AudienceScreenOutcome | undefined;
      await act(async () => {
        outcome = await pending;
      });
      expect(outcome).toEqual({ kind: "JOIN_TIMEOUT" });
      expect(approvals).toEqual([]);
    } finally {
      stub.restore();
    }
  });

  test("approve binds an explicitly approved pending join and clears it", async () => {
    const child = {} as Window;
    const stranger = {} as Window;
    const stub = stubWindowOpen(() => child);
    const boundEpochs: string[] = [];
    try {
      const { controller } = renderProbe(
        makeInput({ onBound: (epoch) => boundEpochs.push(epoch), joinTimeoutMs: 200 }),
      );
      const pendingBox: { current: Promise<AudienceScreenOutcome> | null } = { current: null };
      await act(async () => {
        pendingBox.current = controller().openAndBind();
      });
      await act(async () => {
        dispatchDisplayJoin({ source: stranger });
      });
      const held = controller().pendingJoin;
      if (held === null) throw new Error("unopened-source join was not held for approval");
      let outcome: AudienceScreenOutcome | undefined;
      await act(async () => {
        outcome = await controller().approve(held);
      });
      expect(outcome).toEqual({ kind: "CONNECTED", displayBindingEpoch: "epoch_1" });
      expect(controller().status).toBe("CONNECTED");
      expect(controller().pendingJoin).toBeNull();
      expect(boundEpochs).toEqual(["epoch_1"]);
    } finally {
      stub.restore();
    }
  });

  test("tells the screen it opened that the binding landed", async () => {
    const posted: Array<{ data: unknown; origin: string }> = [];
    const child = {
      postMessage: (data: unknown, origin: string) => {
        posted.push({ data, origin });
      },
    } as unknown as Window;
    const stub = stubWindowOpen(() => child);
    try {
      const { controller } = renderProbe(makeInput({ joinTimeoutMs: 20 }));
      const pendingBox: { current: Promise<AudienceScreenOutcome> | null } = { current: null };
      await act(async () => {
        pendingBox.current = controller().openAndBind();
      });
      const pending = pendingBox.current;
      if (pending === null) throw new Error("openAndBind did not start");
      await act(async () => {
        dispatchDisplayJoin({ source: child });
        await pending;
      });

      // Without this the screen only discovers the approval on its own next retry, which is dead
      // time on a projector while the deck is already projectable.
      expect(posted.length).toBe(1);
      expect(posted[0]?.origin).toBe(STAGE_ORIGIN);
      const data = posted[0]?.data as Record<string, unknown> | undefined;
      expect(data?.kind).toBe("impromptu:display-bound");
      expect(data?.displayJoinId).toBe("join_1");
    } finally {
      stub.restore();
    }
  });

  test("a screen that can no longer be messaged does not fail a landed binding", async () => {
    const child = {
      postMessage: () => {
        throw new Error("the screen was closed");
      },
    } as unknown as Window;
    const stub = stubWindowOpen(() => child);
    try {
      const { controller } = renderProbe(makeInput({ joinTimeoutMs: 20 }));
      const pendingBox: { current: Promise<AudienceScreenOutcome> | null } = { current: null };
      await act(async () => {
        pendingBox.current = controller().openAndBind();
      });
      const pending = pendingBox.current;
      if (pending === null) throw new Error("openAndBind did not start");
      let outcome: AudienceScreenOutcome | undefined;
      await act(async () => {
        dispatchDisplayJoin({ source: child });
        outcome = await pending;
      });

      // The binding exists server-side by then; a notification is not allowed to retract it.
      expect(outcome?.kind).toBe("CONNECTED");
      expect(controller().status).toBe("CONNECTED");
    } finally {
      stub.restore();
    }
  });

  test("approve rejects a null or mismatched join without calling approveJoin", async () => {
    const approvals: DisplayJoinView[] = [];
    const { controller } = renderProbe(
      makeInput({ approveJoin: recordingApprove(approvals, "epoch_1") }),
    );
    let blocked: AudienceScreenOutcome | undefined;
    await act(async () => {
      blocked = await controller().approve(null);
    });
    expect(blocked).toEqual({ kind: "BIND_FAILED" });
    let mismatched: AudienceScreenOutcome | undefined;
    await act(async () => {
      mismatched = await controller().approve(makeJoin("deck_other"));
    });
    expect(mismatched).toEqual({ kind: "BIND_FAILED" });
    expect(approvals).toEqual([]);
    expect(controller().status).toBe("BIND_FAILED");
  });

  test("approve surfaces a failed binding", async () => {
    const { controller } = renderProbe(
      makeInput({
        approveJoin: async () => {
          throw new Error("backend down");
        },
      }),
    );
    let outcome: AudienceScreenOutcome | undefined;
    await act(async () => {
      outcome = await controller().approve(makeJoin());
    });
    expect(outcome).toEqual({ kind: "BIND_FAILED" });
    expect(controller().status).toBe("BIND_FAILED");
  });

  test("reopens and rebinds a fresh screen after a connection", async () => {
    const firstChild = {} as Window;
    const secondChild = {} as Window;
    let nextChild: Window = firstChild;
    const stub = stubWindowOpen(() => nextChild);
    let epochCounter = 0;
    const boundEpochs: string[] = [];
    try {
      const { controller } = renderProbe(
        makeInput({
          approveJoin: async () => {
            epochCounter += 1;
            return { displayBindingEpoch: `epoch_${epochCounter}` };
          },
          onBound: (epoch) => boundEpochs.push(epoch),
          joinTimeoutMs: 200,
        }),
      );
      const bindThrough = async (): Promise<AudienceScreenOutcome> => {
        const pendingBox: { current: Promise<AudienceScreenOutcome> | null } = { current: null };
        await act(async () => {
          pendingBox.current = controller().openAndBind();
        });
        const pending = pendingBox.current;
        if (pending === null) throw new Error("openAndBind did not start");
        let outcome: AudienceScreenOutcome | undefined;
        await act(async () => {
          dispatchDisplayJoin({ source: nextChild });
          outcome = await pending;
        });
        return outcome as AudienceScreenOutcome;
      };
      const first = await bindThrough();
      expect(first).toEqual({ kind: "CONNECTED", displayBindingEpoch: "epoch_1" });
      nextChild = secondChild;
      const second = await bindThrough();
      expect(second).toEqual({ kind: "CONNECTED", displayBindingEpoch: "epoch_2" });
      expect(controller().status).toBe("CONNECTED");
      expect(stub.calls.map((call) => call.url)).toEqual([STAGE_URL, STAGE_URL]);
      expect(boundEpochs).toEqual(["epoch_1", "epoch_2"]);
    } finally {
      stub.restore();
    }
  });

  test("removes the message listener and clears the join timer on unmount", async () => {
    const child = {} as Window;
    const stub = stubWindowOpen(() => child);
    const approvals: DisplayJoinView[] = [];
    const originalClearTimeout = window.clearTimeout;
    let clearedAfterStart = false;
    try {
      const { view, controller } = renderProbe(
        makeInput({ joinTimeoutMs: 20, approveJoin: recordingApprove(approvals, "epoch_1") }),
      );
      await act(async () => {
        void controller().openAndBind();
      });
      window.clearTimeout = ((id: number | undefined) => {
        clearedAfterStart = true;
        return originalClearTimeout(id);
      }) as typeof window.clearTimeout;
      view.unmount();
      expect(clearedAfterStart).toBe(true);
      await act(async () => {
        dispatchDisplayJoin({ source: child });
      });
      expect(approvals).toEqual([]);
    } finally {
      window.clearTimeout = originalClearTimeout;
      stub.restore();
    }
  });
});
