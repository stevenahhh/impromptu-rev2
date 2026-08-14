import type { TrustedModelContext } from "./context.ts";
import { ModelRouterError } from "./errors.ts";

export type Clock = () => number;

export interface DeadlineScheduler {
  schedule(deadlineAtMs: number, run: () => void): () => void;
}

export class SystemDeadlineScheduler implements DeadlineScheduler {
  readonly #clock: Clock;

  constructor(clock: Clock = Date.now) {
    this.#clock = clock;
  }

  schedule(deadlineAtMs: number, run: () => void): () => void {
    const timer = setTimeout(run, Math.max(0, deadlineAtMs - this.#clock()));
    return () => clearTimeout(timer);
  }
}

export class CancellationScope {
  readonly signal: AbortSignal;
  readonly #controller = new AbortController();
  readonly #cancelPromise: Promise<never>;
  readonly #removeDeadline: () => void;
  readonly #externalSignal: AbortSignal;
  readonly #onExternalAbort: () => void;
  #rejectCancellation: (error: ModelRouterError) => void = () => undefined;

  constructor(context: TrustedModelContext, clock: Clock, scheduler: DeadlineScheduler) {
    this.signal = this.#controller.signal;
    this.#externalSignal = context.signal;
    this.#cancelPromise = new Promise<never>(
      (_resolve, reject: (error: ModelRouterError) => void) => {
        this.#rejectCancellation = reject;
      },
    );
    this.#onExternalAbort = () => {
      this.abort(new ModelRouterError("cancelled", "Model invocation was cancelled", false));
    };
    context.signal.addEventListener("abort", this.#onExternalAbort, { once: true });
    this.#removeDeadline = scheduler.schedule(context.deadlineAtMs, () => {
      this.abort(new ModelRouterError("deadline_exceeded", "The model deadline elapsed", true));
    });

    const initialError = cancellationError(context, clock());
    if (initialError !== undefined) this.abort(initialError);
  }

  async race<Value>(operation: () => Promise<Value>): Promise<Value> {
    this.throwIfCancelled();
    return await Promise.race([operation(), this.#cancelPromise]);
  }

  throwIfCancelled(): void {
    if (!this.signal.aborted) return;
    throw this.signal.reason instanceof ModelRouterError
      ? this.signal.reason
      : new ModelRouterError("cancelled", "Model invocation was cancelled", false);
  }

  abort(error = new ModelRouterError("cancelled", "Model invocation was cancelled", false)): void {
    if (this.#controller.signal.aborted) return;
    this.#controller.abort(error);
    this.#rejectCancellation(error);
  }

  dispose(): void {
    this.#removeDeadline();
    this.#externalSignal.removeEventListener("abort", this.#onExternalAbort);
  }
}

export function cancellationError(
  context: TrustedModelContext,
  nowMs: number,
): ModelRouterError | undefined {
  if (nowMs >= context.deadlineAtMs) {
    return new ModelRouterError("deadline_exceeded", "The model deadline elapsed", true);
  }
  if (context.signal.aborted) {
    return new ModelRouterError("cancelled", "Model invocation was cancelled", false);
  }
  return undefined;
}
