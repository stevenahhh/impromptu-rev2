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
import {
  DisplayApprovalRejectedError,
  DisplayInvitationError,
  type DisplayJoinView,
} from "./session-client";

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

const INVITATION_ID = `dinvite_${"cd".repeat(16)}`;
const INVITATION_TOKEN = `dinv_${"ab".repeat(32)}`;

interface InputOverrides {
  readonly approveJoin?: UseAudienceScreenInput["approveJoin"];
  readonly onBound?: UseAudienceScreenInput["onBound"];
  readonly joinTimeoutMs?: number;
  readonly displayBindingEpoch?: string | null;
  readonly issueInvitation?: UseAudienceScreenInput["issueInvitation"];
  readonly readInvitation?: UseAudienceScreenInput["readInvitation"];
}

function makeInput(overrides: InputOverrides = {}): UseAudienceScreenInput {
  return {
    stageOrigin: STAGE_ORIGIN,
    stageUrl: STAGE_URL,
    deckVersion: DECK_VERSION,
    // Explicit null matters: it is the "reloaded, nothing held" state that must force a
    // fresh CAS read instead of a dbe_0 guess.
    displayBindingEpoch:
      overrides.displayBindingEpoch === undefined ? "dbe_0" : overrides.displayBindingEpoch,
    approveJoin:
      overrides.approveJoin ??
      (async () => {
        return { displayBindingEpoch: "epoch_1" };
      }),
    onBound: overrides.onBound ?? (() => {}),
    ...(overrides.joinTimeoutMs === undefined ? {} : { joinTimeoutMs: overrides.joinTimeoutMs }),
    ...(overrides.issueInvitation === undefined
      ? {}
      : { issueInvitation: overrides.issueInvitation }),
    ...(overrides.readInvitation === undefined ? {} : { readInvitation: overrides.readInvitation }),
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

interface RecordedApproval {
  readonly join: DisplayJoinView;
  readonly epoch: string | null;
}

function recordingApproveWithEpoch(
  approvals: RecordedApproval[],
  epoch: string,
): UseAudienceScreenInput["approveJoin"] {
  return async (join, expectedDisplayBindingEpoch) => {
    approvals.push({ join, epoch: expectedDisplayBindingEpoch });
    return { displayBindingEpoch: epoch };
  };
}

function issuedInvitation(overrides: Partial<{ deckVersion: string; expiresAtMs: number }> = {}) {
  const deckVersion = overrides.deckVersion ?? DECK_VERSION;
  return {
    invitationId: INVITATION_ID,
    deckVersion,
    expiresAtMs: overrides.expiresAtMs ?? 1_000_090,
    stagePath: `/?deck=${deckVersion}#invite=${INVITATION_TOKEN}`,
  };
}

function pendingView(
  overrides: Partial<{
    status: "PENDING" | "JOINED" | "EXPIRED";
    deckVersion: string;
    displayBindingEpoch: string;
    join: DisplayJoinView | null;
  }> = {},
) {
  return {
    invitationId: INVITATION_ID,
    presentationSessionId: "ps_active",
    deckVersion: overrides.deckVersion ?? DECK_VERSION,
    expiresAtMs: 1_000_090,
    status: overrides.status ?? "PENDING",
    displayBindingEpoch: overrides.displayBindingEpoch ?? "dbe_0",
    join: overrides.join === undefined ? null : overrides.join,
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
    expect(blocked).toEqual({ kind: "BIND_FAILED", reason: null });
    let mismatched: AudienceScreenOutcome | undefined;
    await act(async () => {
      mismatched = await controller().approve(makeJoin("deck_other"));
    });
    expect(mismatched).toEqual({ kind: "BIND_FAILED", reason: null });
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
    expect(outcome).toEqual({ kind: "BIND_FAILED", reason: null });
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

  test("copyInvitationLink mints a one-use invitation and returns the fragment-token URL", async () => {
    const issues: number[] = [];
    const { controller } = renderProbe(
      makeInput({
        issueInvitation: async () => {
          issues.push(1);
          return issuedInvitation();
        },
      }),
    );
    let url: string | null = null;
    await act(async () => {
      url = await controller().copyInvitationLink();
    });
    expect(issues).toHaveLength(1);
    if (url === null) throw new Error("invitation link was not produced");
    const parsed = new URL(url);
    expect(parsed.origin).toBe(STAGE_ORIGIN);
    expect(parsed.searchParams.get("invite")).toBeNull();
    expect(parsed.hash).toBe(`#invite=${INVITATION_TOKEN}`);
    expect(controller().invitation).toMatchObject({
      kind: "OPEN",
      invitationId: INVITATION_ID,
      expiresAtMs: 1_000_090,
    });
    // Nothing about minting touched the approval surface.
    expect(controller().pendingJoin).toBeNull();
    expect(controller().status).toBe("IDLE");
  });

  test("copyInvitationLink reports failure when the mint is unavailable", async () => {
    const { controller } = renderProbe(makeInput({}));
    let url: string | null = null;
    await act(async () => {
      url = await controller().copyInvitationLink();
    });
    expect(url).toBeNull();
    expect(controller().invitation.kind).toBe("ISSUE_FAILED");
  });

  test("checkInvitation reports an unredeemed link as still open", async () => {
    const { controller } = renderProbe(
      makeInput({
        issueInvitation: async () => issuedInvitation(),
        readInvitation: async () => pendingView({ status: "PENDING" }),
      }),
    );
    await act(async () => {
      await controller().copyInvitationLink();
    });
    await act(async () => {
      await controller().checkInvitation();
    });
    expect(controller().invitation).toMatchObject({ kind: "OPEN", checking: false });
    expect(controller().pendingJoin).toBeNull();
  });

  test("checkInvitation surfaces the exact pending display identity and CAS for approval", async () => {
    const join = makeJoin();
    const { controller } = renderProbe(
      makeInput({
        issueInvitation: async () => issuedInvitation(),
        readInvitation: async () =>
          pendingView({ status: "JOINED", displayBindingEpoch: "dbe_5", join }),
      }),
    );
    await act(async () => {
      await controller().copyInvitationLink();
    });
    await act(async () => {
      await controller().checkInvitation();
    });
    expect(controller().invitation.kind).toBe("JOINED");
    expect(controller().pendingJoin).toEqual(join);
    // The identity check the presenter approves against: the read CAS, not a guess.
    expect(controller().pendingEpoch).toBe("dbe_5");
  });

  test("approving an invitation join sends the freshly read CAS epoch", async () => {
    const join = makeJoin();
    const approvals: RecordedApproval[] = [];
    const boundEpochs: string[] = [];
    const { controller } = renderProbe(
      makeInput({
        displayBindingEpoch: null,
        approveJoin: recordingApproveWithEpoch(approvals, "dbe_5"),
        onBound: (epoch) => boundEpochs.push(epoch),
        issueInvitation: async () => issuedInvitation(),
        readInvitation: async () =>
          pendingView({ status: "JOINED", displayBindingEpoch: "dbe_5", join }),
      }),
    );
    await act(async () => {
      await controller().copyInvitationLink();
    });
    await act(async () => {
      await controller().checkInvitation();
    });
    const held = controller().pendingJoin;
    if (held === null) throw new Error("joined display was not held for approval");
    let outcome: AudienceScreenOutcome | undefined;
    await act(async () => {
      outcome = await controller().approve(held);
    });
    expect(outcome).toEqual({ kind: "CONNECTED", displayBindingEpoch: "dbe_5" });
    expect(approvals).toEqual([{ join, epoch: "dbe_5" }]);
    expect(boundEpochs).toEqual(["dbe_5"]);
    expect(controller().status).toBe("CONNECTED");
    expect(controller().pendingJoin).toBeNull();
    expect(controller().invitation.kind).toBe("NONE");
  });

  test("a stale CAS refreshes through a fresh read and retries the approval once", async () => {
    const join = makeJoin();
    const approvals: RecordedApproval[] = [];
    let attempts = 0;
    let reads = 0;
    const boundEpochs: string[] = [];
    const { controller } = renderProbe(
      makeInput({
        displayBindingEpoch: null,
        approveJoin: async (candidate, epoch) => {
          attempts += 1;
          approvals.push({ join: candidate, epoch });
          if (attempts === 1) throw new DisplayApprovalRejectedError("STALE_DISPLAY_BINDING");
          return { displayBindingEpoch: "dbe_9" };
        },
        onBound: (epoch) => boundEpochs.push(epoch),
        issueInvitation: async () => issuedInvitation(),
        readInvitation: async () => {
          reads += 1;
          return pendingView({
            status: "JOINED",
            displayBindingEpoch: reads === 1 ? "dbe_7" : "dbe_9",
            join,
          });
        },
      }),
    );
    await act(async () => {
      await controller().copyInvitationLink();
    });
    await act(async () => {
      await controller().checkInvitation();
    });
    const held = controller().pendingJoin;
    if (held === null) throw new Error("joined display was not held for approval");
    let outcome: AudienceScreenOutcome | undefined;
    await act(async () => {
      outcome = await controller().approve(held);
    });
    expect(outcome).toEqual({ kind: "CONNECTED", displayBindingEpoch: "dbe_9" });
    // First attempt went out with the read epoch, the retry with the refreshed one — and the
    // refusal reason never became a silent success.
    expect(approvals).toEqual([
      { join, epoch: "dbe_7" },
      { join, epoch: "dbe_9" },
    ]);
    expect(reads).toBe(2);
    expect(boundEpochs).toEqual(["dbe_9"]);
    expect(controller().status).toBe("CONNECTED");
  });

  test("a stale CAS that cannot be refreshed lands as BIND_FAILED with the reason intact", async () => {
    const join = makeJoin();
    const { controller } = renderProbe(
      makeInput({
        displayBindingEpoch: null,
        approveJoin: async () => {
          throw new DisplayApprovalRejectedError("STALE_DISPLAY_BINDING");
        },
        issueInvitation: async () => issuedInvitation(),
        readInvitation: async () =>
          pendingView({ status: "JOINED", displayBindingEpoch: "dbe_7", join }),
      }),
    );
    await act(async () => {
      await controller().copyInvitationLink();
    });
    await act(async () => {
      await controller().checkInvitation();
    });
    const held = controller().pendingJoin;
    if (held === null) throw new Error("joined display was not held for approval");
    let outcome: AudienceScreenOutcome | undefined;
    await act(async () => {
      outcome = await controller().approve(held);
    });
    // Same epoch came back from the refresh, so no doomed retry was posted.
    expect(outcome).toEqual({ kind: "BIND_FAILED", reason: "STALE_DISPLAY_BINDING" });
    expect(controller().status).toBe("BIND_FAILED");
    expect(controller().failureReason).toBe("STALE_DISPLAY_BINDING");
  });

  test("an expired invitation is reported honestly and never leaves a pending join", async () => {
    const { controller } = renderProbe(
      makeInput({
        issueInvitation: async () => issuedInvitation(),
        readInvitation: async () => pendingView({ status: "EXPIRED", join: null }),
      }),
    );
    await act(async () => {
      await controller().copyInvitationLink();
    });
    await act(async () => {
      await controller().checkInvitation();
    });
    expect(controller().invitation.kind).toBe("EXPIRED");
    expect(controller().pendingJoin).toBeNull();
  });

  test("an invitation the server forgot is gone, not still pending", async () => {
    const { controller } = renderProbe(
      makeInput({
        issueInvitation: async () => issuedInvitation(),
        readInvitation: async () => {
          throw new DisplayInvitationError(404, "invitation_not_found");
        },
      }),
    );
    await act(async () => {
      await controller().copyInvitationLink();
    });
    await act(async () => {
      await controller().checkInvitation();
    });
    expect(controller().invitation.kind).toBe("EXPIRED");
  });

  test("a pending view for another deck marks the link outdated instead of surfacing it", async () => {
    const { controller } = renderProbe(
      makeInput({
        issueInvitation: async () => issuedInvitation({ deckVersion: "deck_old" }),
        readInvitation: async () =>
          pendingView({ status: "JOINED", deckVersion: "deck_old", join: makeJoin("deck_old") }),
      }),
    );
    await act(async () => {
      await controller().copyInvitationLink();
    });
    expect(controller().invitation.kind).toBe("OUTDATED");
  });

  test("a failed check keeps the invitation open and flagged, never connected", async () => {
    let reads = 0;
    const { controller } = renderProbe(
      makeInput({
        issueInvitation: async () => issuedInvitation(),
        readInvitation: async () => {
          reads += 1;
          if (reads === 1) throw new DisplayInvitationError(503, "projection_unavailable");
          return pendingView({ status: "JOINED", displayBindingEpoch: "dbe_2", join: makeJoin() });
        },
      }),
    );
    await act(async () => {
      await controller().copyInvitationLink();
    });
    await act(async () => {
      await controller().checkInvitation();
    });
    expect(controller().invitation).toMatchObject({ kind: "OPEN", checkFailed: true });
    // The retry recovers.
    await act(async () => {
      await controller().checkInvitation();
    });
    expect(controller().invitation.kind).toBe("JOINED");
    expect(controller().pendingJoin?.displayId).toBe("display_room");
  });

  test("after a reload there is no held epoch, so the CAS is resolved fresh instead of dbe_0", async () => {
    const child = {} as Window;
    const stub = stubWindowOpen(() => child);
    const approvals: RecordedApproval[] = [];
    const mints: string[] = [];
    try {
      const { controller } = renderProbe(
        makeInput({
          displayBindingEpoch: null,
          approveJoin: recordingApproveWithEpoch(approvals, "dbe_7"),
          issueInvitation: async () => {
            mints.push("mint");
            return issuedInvitation();
          },
          readInvitation: async () =>
            pendingView({ status: "PENDING", displayBindingEpoch: "dbe_7" }),
          joinTimeoutMs: 200,
        }),
      );
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
      expect(outcome).toEqual({ kind: "CONNECTED", displayBindingEpoch: "dbe_7" });
      // The approval carried the server-authoritative epoch; the constant dbe_0 is gone.
      expect(approvals).toEqual([{ join: makeJoin(), epoch: "dbe_7" }]);
      expect(mints).toHaveLength(1);
    } finally {
      stub.restore();
    }
  });

  test("a stale held epoch on an opened-screen rebind refreshes and retries instead of failing", async () => {
    const child = {} as Window;
    const stub = stubWindowOpen(() => child);
    const approvals: RecordedApproval[] = [];
    let attempts = 0;
    try {
      const { controller } = renderProbe(
        makeInput({
          // The stored epoch is what the task-2 repro held: dbe_1 while the server sits at dbe_2.
          displayBindingEpoch: "dbe_1",
          approveJoin: async (join, epoch) => {
            attempts += 1;
            approvals.push({ join, epoch });
            if (attempts === 1) throw new DisplayApprovalRejectedError("STALE_DISPLAY_BINDING");
            return { displayBindingEpoch: "dbe_2" };
          },
          issueInvitation: async () => issuedInvitation(),
          readInvitation: async () =>
            pendingView({ status: "PENDING", displayBindingEpoch: "dbe_2" }),
          joinTimeoutMs: 200,
        }),
      );
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
      expect(outcome).toEqual({ kind: "CONNECTED", displayBindingEpoch: "dbe_2" });
      expect(approvals).toEqual([
        { join: makeJoin(), epoch: "dbe_1" },
        { join: makeJoin(), epoch: "dbe_2" },
      ]);
      expect(controller().status).toBe("CONNECTED");
    } finally {
      stub.restore();
    }
  });

  test("the opener path still binds without a second confirmation when no resolver is wired", async () => {
    const child = {} as Window;
    const stub = stubWindowOpen(() => child);
    const approvals: RecordedApproval[] = [];
    try {
      const { controller } = renderProbe(
        makeInput({
          displayBindingEpoch: "dbe_0",
          approveJoin: recordingApproveWithEpoch(approvals, "dbe_1"),
          joinTimeoutMs: 200,
        }),
      );
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
      expect(outcome).toEqual({ kind: "CONNECTED", displayBindingEpoch: "dbe_1" });
      expect(approvals).toEqual([{ join: makeJoin(), epoch: "dbe_0" }]);
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
