import { describe, expect, test } from "bun:test";
import { QaRecheckClock, type QaWindowObservation } from "./qa-recheck-clock";

/**
 * The coalesced recheck chain behind the Q&A cockpit's ask window: while an accepted
 * submission's window is LIVE exactly one recheck is ever pending at the earliest known
 * deadline; the first terminal verdict (EXPIRED/EMPTY/ENDED) ends the chain, and a window
 * that keeps reading LIVE past its own deadline is bounded rather than refetching forever.
 */

const flushMicrotasks = async (): Promise<void> => {
  // Drain chained promise continuations deterministically — no timers, no real time.
  for (let depth = 0; depth < 8; depth += 1) await Promise.resolve();
};

interface PendingTimer {
  readonly delayMs: number;
  fire(): void;
  cancel(): void;
  readonly cancelled: { readonly value: boolean };
  readonly fired: { readonly value: boolean };
}

function harness() {
  const timers: PendingTimer[] = [];
  const live = (): PendingTimer[] =>
    timers.filter((timer) => !timer.cancelled.value && !timer.fired.value);
  const rechecks: Array<{
    resolve(observation: QaWindowObservation): void;
    reject(error: unknown): void;
    promise: Promise<QaWindowObservation>;
  }> = [];
  const observed: QaWindowObservation[] = [];
  const failures: unknown[] = [];
  const clock = new QaRecheckClock({
    now: () => 0,
    schedule(delayMs, fire) {
      const cancelled = { value: false };
      const fired = { value: false };
      const timer: PendingTimer = {
        delayMs,
        fire: () => {
          fired.value = true;
          if (!cancelled.value) fire();
        },
        cancel: () => {
          cancelled.value = true;
        },
        cancelled,
        fired,
      };
      timers.push(timer);
      return timer;
    },
    cancel: (handle) => handle.cancel(),
    recheck: () =>
      new Promise<QaWindowObservation>((resolve, reject) => {
        rechecks.push({ resolve, reject, promise: Promise.resolve() as never });
      }),
    onObservation: (observation) => observed.push(observation),
    onFailure: (error) => failures.push(error),
  });
  return { clock, timers, live, rechecks, observed, failures };
}

describe("QaRecheckClock", () => {
  test("a LIVE window arms exactly one recheck at its deadline; an EXPIRED verdict ends the chain", async () => {
    const h = harness();
    h.clock.observe({ status: "LIVE", askableUntilMs: 300_000 });
    expect(h.live()).toHaveLength(1);
    expect(h.live()[0]?.delayMs).toBe(300_000);

    h.live()[0]?.fire();
    expect(h.rechecks).toHaveLength(1);
    h.rechecks[0]?.resolve({ status: "EXPIRED", askableUntilMs: 300_000 });
    await flushMicrotasks();

    // Terminal verdict: surfaced verbatim, no follow-up timer — the chain is over.
    expect(h.observed).toEqual([{ status: "EXPIRED", askableUntilMs: 300_000 }]);
    expect(h.live()).toHaveLength(0);
  });

  test("only LIVE refetches: EMPTY and ENDED observations never schedule and disarm an armed timer", async () => {
    const h = harness();
    h.clock.observe({ status: "LIVE", askableUntilMs: 300_000 });
    expect(h.live()).toHaveLength(1);

    // An EMPTY verdict (the window was never open / is gone) cancels the pending recheck.
    h.clock.observe({ status: "EMPTY", askableUntilMs: null });
    expect(h.live()).toHaveLength(0);

    // ENDED — a window the owner closed — is terminal too: it must never re-arm.
    h.clock.observe({ status: "ENDED", askableUntilMs: null });
    expect(h.timers).toHaveLength(1);
    h.timers[0]?.fire();
    expect(h.rechecks).toHaveLength(0);

    // Fired-after-cancel timers are inert: nothing leaked into a recheck.
    await flushMicrotasks();
    expect(h.rechecks).toHaveLength(0);
    expect(h.observed).toHaveLength(0);
  });

  test("observations coalesce: a later LIVE with an earlier deadline replaces the pending timer", async () => {
    const h = harness();
    h.clock.observe({ status: "LIVE", askableUntilMs: 300_000 });
    h.clock.observe({ status: "LIVE", askableUntilMs: 120_000 });
    expect(h.live()).toHaveLength(1);
    expect(h.live()[0]?.delayMs).toBe(120_000);
    expect(h.timers[0]?.cancelled.value).toBe(true);

    // The coalesced tick still performs exactly one recheck.
    h.live()[0]?.fire();
    expect(h.rechecks).toHaveLength(1);
    h.rechecks[0]?.resolve({ status: "EXPIRED", askableUntilMs: 120_000 });
    await flushMicrotasks();
    expect(h.live()).toHaveLength(0);
  });

  test("a window still LIVE past its deadline chains the recheck again instead of trusting the stale read", async () => {
    const h = harness();
    h.clock.observe({ status: "LIVE", askableUntilMs: 300_000 });
    h.live()[0]?.fire();
    // Server clock disagrees: still LIVE. The chain MUST re-arm — a clip that expired while
    // the presenter waits cannot be left sitting as 'asking' on one stale verdict.
    h.rechecks[0]?.resolve({ status: "LIVE", askableUntilMs: 300_000 });
    await flushMicrotasks();
    expect(h.observed).toEqual([{ status: "LIVE", askableUntilMs: 300_000 }]);
    expect(h.rechecks).toHaveLength(1);
    expect(h.live()).toHaveLength(1);
  });

  test("a recheck chain that never goes terminal is bounded and reports failure instead of refetching forever", async () => {
    const h = harness();
    h.clock.observe({ status: "LIVE", askableUntilMs: 300_000 });
    // Every verdict claims the same LIVE window — pathological stale reads must not spin.
    for (let step = 0; step < 12 && h.rechecks.length === step; step += 1) {
      const timer = h.live()[0];
      if (timer === undefined) break;
      timer.fire();
      const recheck = h.rechecks[step];
      recheck?.resolve({ status: "LIVE", askableUntilMs: 300_000 });
      await flushMicrotasks();
    }
    expect(h.failures).toHaveLength(1);
    expect(h.live()).toHaveLength(0);
    expect(h.rechecks.length).toBeGreaterThan(0);
    expect(h.rechecks.length).toBeLessThanOrEqual(5);
  });

  test("a rejected recheck surfaces the failure once and leaves no timer behind", async () => {
    const h = harness();
    h.clock.observe({ status: "LIVE", askableUntilMs: 300_000 });
    h.live()[0]?.fire();
    h.rechecks[0]?.reject(new Error("network down"));
    await flushMicrotasks();
    expect(h.failures).toHaveLength(1);
    expect(h.live()).toHaveLength(0);
  });

  test("dispose cancels the pending timer and swallows nothing after teardown", async () => {
    const h = harness();
    h.clock.observe({ status: "LIVE", askableUntilMs: 300_000 });
    h.clock.dispose();
    expect(h.live()).toHaveLength(0);
    h.timers[0]?.fire();
    await flushMicrotasks();
    expect(h.rechecks).toHaveLength(0);
  });
});
