import type { DeadlineScheduler } from "@impromptu/model-router";
import { TERMINAL_DEADLINE_GUARD_MS } from "./recommendation-outcome.ts";

/**
 * Terminal deadline control for one recommendation run: schedules the abort at deadline minus
 * guard, races the run against that terminal outcome, and tears the deadline down once the
 * outcome is decided so an aborted run always reports inside its own budget.
 */
export async function raceWithTerminalDeadline<Outcome>(dependencies: {
  readonly scheduler: DeadlineScheduler;
  readonly startedAtMs: number;
  readonly budgetMs: number;
  readonly expireReason: string;
  readonly completeReason: string;
  readonly onExpire: () => Outcome;
  readonly run: (signal: AbortSignal) => Promise<Outcome>;
}): Promise<Outcome> {
  const controller = new AbortController();
  const deadlineAtMs = dependencies.startedAtMs + dependencies.budgetMs;
  let resolveDeadline: (outcome: Outcome) => void = () => undefined;
  const deadline = new Promise<Outcome>((resolve) => {
    resolveDeadline = resolve;
  });
  const removeDeadline = dependencies.scheduler.schedule(
    deadlineAtMs - TERMINAL_DEADLINE_GUARD_MS,
    () => {
      controller.abort(dependencies.expireReason);
      resolveDeadline(dependencies.onExpire());
    },
  );
  try {
    return await Promise.race([dependencies.run(controller.signal), deadline]);
  } finally {
    removeDeadline();
    // Cancels any evidence branch that is still in flight once the outcome is decided.
    controller.abort(dependencies.completeReason);
  }
}
