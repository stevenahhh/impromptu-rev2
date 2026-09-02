/**
 * Serializes persisted Q&A exchanges per session behind chained writes. Appending works both
 * before and after report finalization: the exchange log is its own durable record, not part of
 * the finalized report's compare-and-swap state. Unexpected write failures are remembered so
 * end-time draining can refuse to finalize over missing data.
 *
 * NO IDEMPOTENCY MEMO. An earlier revision short-circuited repeats on exact exchange-id equality
 * WITHOUT touching the sink — which silently answered a genuine immediate re-ask over an
 * unrecorded row (audit hole). Deduplication belongs exclusively to the durable store's
 * byte-equality check; this layer must forward EVERY record call.
 */
import {
  generateQaExchangeId,
  parseQaExchangeDraft,
  type QaExchangeAppendResult,
  type QaExchangeItem,
} from "../qa/qa-exchange-ledger.ts";
import type { SessionReportPrincipal } from "./postgres-session-report-repository.ts";
import { SessionReportStateConflictError } from "./session-report-access-errors.ts";
import { sessionKey } from "./session-write-trackers.ts";

export type SerializedQaAppend = (
  input: SessionReportPrincipal & QaExchangeItem,
) => Promise<QaExchangeAppendResult>;

type Tracker = {
  writes: Promise<void>;
  failure: unknown | null;
};

export class SerializedQaExchangeRecorder {
  readonly #writes = new Map<string, Tracker>();

  constructor(private readonly append: SerializedQaAppend) {}

  async record(
    principal: SessionReportPrincipal,
    draft: QaExchangeItem,
  ): Promise<QaExchangeAppendResult> {
    const exchange = parseQaExchangeDraft(draft);
    const key = sessionKey(principal);
    const tracker = this.#writes.get(key) ?? { writes: Promise.resolve(), failure: null };
    const appended = tracker.writes.then(() => this.#appendTruthfully(principal, exchange));
    tracker.writes = appended.then(
      () => {},
      (error) => {
        tracker.failure ??= error;
      },
    );
    this.#writes.set(key, tracker);
    return await appended;
  }

  /**
   * Writes one exchange durably under ITS OWN truthful identity. Normal use never hits the
   * store's same-id-different-content guard because every ask carries a freshly minted random
   * id. If the guard still fires (an id collision, e.g. replaying historical bucket-era rows),
   * this layer retries ONCE under a replacement generated id so the genuine ask is recorded
   * instead of surfacing a 500-class failure; the store-level guard itself stays intact.
   */
  async #appendTruthfully(
    principal: SessionReportPrincipal,
    exchange: QaExchangeItem,
  ): Promise<QaExchangeAppendResult> {
    try {
      return await this.append({ ...principal, ...exchange });
    } catch (error) {
      if (!(error instanceof SessionReportStateConflictError)) throw error;
      const replacement: QaExchangeItem = { ...exchange, exchangeId: generateQaExchangeId() };
      const retried = await this.append({ ...principal, ...replacement });
      return retried.outcome === "APPENDED" ? { ...retried, exchange: replacement } : retried;
    }
  }

  /** Drains all queued exchange writes for the session; throws an earlier unexpected failure. */
  async drain(principal: SessionReportPrincipal): Promise<void> {
    const tracker = this.#writes.get(sessionKey(principal));
    if (tracker === undefined) return;
    await tracker.writes;
    if (tracker.failure !== null) throw tracker.failure;
  }
}
