// The coalesced recheck chain behind the QA cockpit's ask window. While a submission's
// window is LIVE, exactly ONE timer is ever pending at the earliest known deadline; the
// tick performs exactly one refetch and re-arms only while the server still says LIVE.
// Terminal verdicts — EXPIRED, EMPTY (never opened), ENDED (owner-closed) — disarm the
// chain permanently, and consecutive LIVE verdicts past the deadline are bounded so a
// pathological stale read cannot refetch forever. No clock opinion lives here: delay,
// now and the actual refetch are all injected.

/** What the caller hands the clock after each authoritative read (open, submit, recheck). */
export type QaWindowObservation = Readonly<{
  /** LIVE re-arms; every other status is terminal. ENDED is caller-synthesized. */
  status: "EMPTY" | "LIVE" | "EXPIRED" | "ENDED";
  askableUntilMs: number | null;
}>;

export interface QaRecheckTimerHandle {
  cancel(): void;
}

export interface QaRecheckClockOptions {
  readonly now: () => number;
  readonly schedule: (delayMs: number, fire: () => void) => QaRecheckTimerHandle;
  readonly cancel: (handle: QaRecheckTimerHandle) => void;
  /** The refetch — resolves with the server's current verdict for this window. */
  readonly recheck: () => Promise<QaWindowObservation>;
  readonly onObservation: (observation: QaWindowObservation) => void;
  /**
   * A rejected recheck or an exhausted still-LIVE chain ends here: the window can no longer
   * be watched, which is a failure surface, never silent staleness.
   */
  readonly onFailure: (error: unknown) => void;
  /** Consecutive recheck cap per chain; mirrors RECONCILE_RECOVERY_LIMIT's intent. */
  readonly maxRechecks?: number;
}

const DEFAULT_MAX_RECHECKS = 4;

export class QaRecheckClock {
  #timer: QaRecheckTimerHandle | null = null;
  #deadlineMs: number | null = null;
  #inFlight = false;
  #disposed = false;
  #rechecks = 0;
  #maxRechecks: number;

  constructor(private readonly options: QaRecheckClockOptions) {
    this.#maxRechecks = options.maxRechecks ?? DEFAULT_MAX_RECHECKS;
  }

  /**
   * Feed the freshest authoritative verdict. Coalesced: while a timer is already pending for
   * an earlier-or-equal deadline this call keeps it; a strictly earlier deadline replaces it.
   * Terminal statuses disarm immediately and permanently.
   */
  observe(observation: QaWindowObservation): void {
    if (this.#disposed) return;
    if (observation.status !== "LIVE") {
      this.#disarm();
      return;
    }
    if (observation.askableUntilMs === null) {
      throw new TypeError("a LIVE Q&A window must carry its askableUntilMs deadline");
    }
    if (
      this.#timer !== null &&
      this.#deadlineMs !== null &&
      this.#deadlineMs <= observation.askableUntilMs
    ) {
      return; // Already watching an earlier-or-equal deadline: one pending recheck total.
    }
    this.#disarm();
    this.#deadlineMs = observation.askableUntilMs;
    if (!this.#inFlight) this.#rechecks = 0; // A genuinely new deadline earns a fresh budget.
    this.#arm();
  }

  dispose(): void {
    this.#disposed = true;
    this.#disarm();
  }

  #disarm(): void {
    if (this.#timer !== null) {
      const timer = this.#timer;
      this.#timer = null;
      this.options.cancel(timer);
    }
    this.#deadlineMs = null;
  }

  #arm(): void {
    if (this.#timer !== null || this.#deadlineMs === null) return;
    const delayMs = Math.max(0, this.#deadlineMs - this.options.now());
    this.#timer = this.options.schedule(delayMs, () => {
      this.#timer = null;
      void this.#tick();
    });
  }

  async #tick(): Promise<void> {
    if (this.#disposed || this.#inFlight) return;
    if (this.#rechecks >= this.#maxRechecks) {
      // A window that keeps answering LIVE past its own deadline is an exhausted recovery
      // chain: surface the failure once instead of refetching forever.
      this.#disarm();
      this.options.onFailure(new Error("Q&A window rechecks exhausted"));
      return;
    }
    this.#inFlight = true;
    this.#rechecks += 1;
    try {
      const observation = await this.options.recheck();
      if (this.#disposed) return;
      this.options.onObservation(observation);
      this.observe(observation);
    } catch (error) {
      if (this.#disposed) return;
      this.#disarm();
      this.options.onFailure(error);
    } finally {
      this.#inFlight = false;
    }
  }
}
