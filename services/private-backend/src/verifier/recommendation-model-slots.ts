import type { RetrievedEvidence } from "@impromptu/contracts/retrieval";
import { StructuredRecommendationSchema } from "@impromptu/contracts/retrieval";
import type {
  DeadlineScheduler,
  ModelErrorCode,
  ServerModelRouter,
  TrustedModelContext,
} from "@impromptu/model-router";
import { z } from "zod";
import { TERMINAL_DEADLINE_GUARD_MS } from "./recommendation-outcome.ts";

export type RecommendationModelStageEvent = Readonly<{
  stage: "embedding" | "rerank" | "llm" | "verifier";
  outcome: "SUCCESS" | "FAILED";
  latencyMs: number;
  errorCode?: ModelErrorCode;
}>;

export type RecommendationReconciliationEvent = Readonly<{
  category: "NUMBER" | "UNIT" | "DATE" | "ENTITY" | "SOURCE";
  /** The rejected fact token itself; never claim or evidence prose. */
  value: string;
}>;

export type RecommendationHedgeEvent = Readonly<{
  stage: "rerank" | "llm" | "verifier";
  outcome: "STARTED" | "PRIMARY_WON" | "HEDGE_WON" | "BOTH_FAILED";
}>;

export interface RecommendationStageObserver {
  observe(event: RecommendationModelStageEvent): void;
  observeReconciliation?(event: RecommendationReconciliationEvent): void;
  observeHedge?(event: RecommendationHedgeEvent): void;
}

/**
 * The hedge offsets below were tuned by measurement against a 5,000ms budget, and a duplicate that
 * starts later rescues fewer runs. Widening the terminal budget therefore has to buy tail room for
 * a slow call rather than permission to wait longer before duplicating, so the schedule keeps
 * using the budget it was tuned on while the abort follows the real one.
 */
export const HEDGE_SCHEDULE_BUDGET_MS = 5_000;
/**
 * Slot hedging budget, derived from the hedged 20-run provider profile in
 * `.omo/evidence/task-37`. The verifier runs serially after the pair, so the pair must leave
 * behind enough room for the verifier tail rather than its median: reserving the p50 leaves the
 * verifier short on half of all runs, which is exactly the abort the reserve exists to prevent.
 * The reserve is therefore the measured verifier p90 (1,934ms). The per-slot figures are the
 * measured p50 of each slot, because that is how long a duplicate typically needs in order to
 * be worth starting at all.
 */
export const HEDGE_VERIFIER_RESERVE_MS = 1_934;
const HEDGE_TYPICAL_CALL_MS = { rerank: 967, llm: 1_284, verifier: 1_644 } as const;
/**
 * The fastest durations either slot was observed to return in. Deferring a duplicate to a point
 * earlier than this can never avoid starting one - no call settles that early - so the delay
 * would only shorten the duplicate's runway. Both hedged profiles recorded llm duplicates on
 * every single run, which is exactly that situation.
 */
const HEDGE_FAST_PATH_MS = { rerank: 750, llm: 1_000, verifier: 1_200 } as const;
/**
 * Above this many in-flight model calls on this pipeline, slot duplicates stop being started.
 * A duplicate only rescues a run when it settles while the primary is an isolated straggler;
 * when the provider is already saturated - measured on a twenty-slide burst, where nearly
 * every slot spawned a duplicate and the cancelled arms outnumbered the survivors - both arms
 * queue equally, so the duplicate adds provider load and deepens everyone's latency instead of
 * rescuing anything. Solo and small multi-viewer sessions stay far below the limit and keep
 * the full tuned schedule.
 */
const HEDGE_SATURATION_LIMIT = 8;

/** The verifier model sees at most this many evidence entries. */
export const MAX_MODEL_EVIDENCE = 2;

/** Maximum content length of one evidence entry shown to a model slot. */
const MAX_MODEL_CONTENT_CHARACTERS = 700;

export const embeddingOutputSchema = z
  .object({ vector: z.array(z.number().finite()).min(1).max(8_192) })
  .strict();
export const rerankOutputSchema = z
  .object({ orderedEvidenceIds: z.array(z.string().min(1)).min(1).max(MAX_MODEL_EVIDENCE) })
  .strict();

export interface AliasedEvidence {
  readonly alias: string;
  readonly evidence: RetrievedEvidence;
}

/**
 * Prepares the model-visible evidence window: at most MAX_MODEL_EVIDENCE entries, each aliased
 * e1..en and truncated, with the first entry alone feeding the generation slot.
 */
export function prepareModelEvidenceInput(evidence: readonly RetrievedEvidence[]): {
  readonly aliasedEvidence: readonly AliasedEvidence[];
  readonly rerankData: ReadonlyArray<Readonly<{ evidenceId: string; content: string }>>;
  readonly generationData: ReadonlyArray<Readonly<{ evidenceId: string; content: string }>>;
} {
  const aliasedEvidence = evidence.slice(0, MAX_MODEL_EVIDENCE).map((item, index) => ({
    alias: `e${index + 1}`,
    evidence: item,
  }));
  const rerankData = aliasedEvidence.map((item) => ({
    evidenceId: item.alias,
    content: item.evidence.content.slice(0, MAX_MODEL_CONTENT_CHARACTERS),
  }));
  return { aliasedEvidence, rerankData, generationData: rerankData.slice(0, 1) };
}

export type ModelSlotResult<Output> =
  | Readonly<{ ok: true; output: Output }>
  | Readonly<{ ok: false; errorCode: ModelErrorCode }>;

/** The moment on the tuned 5,000ms hedge schedule where terminal guarding begins. */
export function hedgedScheduleEndMs(startedAtMs: number): number {
  return startedAtMs + HEDGE_SCHEDULE_BUDGET_MS - TERMINAL_DEADLINE_GUARD_MS;
}

/**
 * Returns the moment a slot's duplicate should start, or null when the slot must run alone
 * because not even one typical call fits in the remaining budget.
 */
export function hedgeAtMs(
  slot: "rerank" | "llm" | "verifier",
  startedAtMs: number,
  budgetMs: number,
): number | null {
  const offset = budgetMs - HEDGE_TYPICAL_CALL_MS[slot];
  // Not even one typical call fits, so a duplicate cannot finish either: run the slot alone.
  if (offset <= 0) return null;
  // Waiting past the point where no call has ever settled cannot avoid the duplicate, so the
  // delay would only cost the duplicate runway it needs. Such a slot starts its duplicate at
  // once; a slot whose delay genuinely avoids duplicates keeps waiting.
  const deferrable = offset >= HEDGE_FAST_PATH_MS[slot];
  return startedAtMs + (deferrable ? offset : 0);
}

export interface RecommendationModelSlots {
  invoke<Output>(
    capability: "embedding" | "rerank" | "llm" | "verifier",
    input: unknown,
    schema: z.ZodType<Output>,
    context: TrustedModelContext,
  ): Promise<ModelSlotResult<Output>>;
  /**
   * Runs one model slot with at most ONE duplicate in flight, inside the caller's existing
   * deadline and against the same model, schema and trusted context. The duplicate starts only
   * while the primary is still pending at `hedgeAtMs`, so a slot that settles at its usual
   * latency never doubles provider load. This is not a retry: a primary that settles with an
   * error is reported as-is and never causes a new call to be started.
   */
  hedgedInvoke<Output>(
    capability: "rerank" | "llm" | "verifier",
    input: unknown,
    schema: z.ZodType<Output>,
    context: TrustedModelContext,
    hedgeAtMs: number | null,
  ): Promise<ModelSlotResult<Output>>;
  /** Runs the concurrent rerank + structured-recommendation pair on their tuned hedge schedule.
   * Both slots inspect the same ACL-approved candidates; their outputs are intersected later by
   * the deterministic gate, so running them concurrently does not weaken evidence gates. */
  invokeRerankAndLlmPair(dependencies: {
    readonly query: string;
    readonly rerankData: ReadonlyArray<Readonly<{ evidenceId: string; content: string }>>;
    readonly generationData: ReadonlyArray<Readonly<{ evidenceId: string; content: string }>>;
    readonly context: TrustedModelContext;
    readonly pairStartedAtMs: number;
    readonly pairBudgetMs: number;
  }): Promise<
    readonly [
      ModelSlotResult<z.infer<typeof rerankOutputSchema>>,
      ModelSlotResult<z.infer<typeof StructuredRecommendationSchema>>,
    ]
  >;
}

export function createRecommendationModelSlots(dependencies: {
  // The router itself, never its detached `invoke`: ServerModelRouter reads private state
  // through `this`, so a method pulled off the instance throws on the first real dispatch
  // while a plain-object test double keeps working.
  readonly router: Pick<ServerModelRouter, "invoke">;
  readonly scheduler: DeadlineScheduler;
  readonly stageObserver?: RecommendationStageObserver | undefined;
}): RecommendationModelSlots {
  const { router, scheduler, stageObserver } = dependencies;
  let inFlightModelCalls = 0;

  async function invokeSlot<Output>(
    capability: "embedding" | "rerank" | "llm" | "verifier",
    input: unknown,
    schema: z.ZodType<Output>,
    context: TrustedModelContext,
  ): Promise<ModelSlotResult<Output>> {
    const fail = (latencyMs: number, errorCode: ModelErrorCode): ModelSlotResult<never> => {
      stageObserver?.observe({ stage: capability, outcome: "FAILED", latencyMs, errorCode });
      return { ok: false, errorCode };
    };
    inFlightModelCalls += 1;
    // `finally` releases the in-flight slot on both settle paths and passes the router's own
    // result through untouched, so the count stays honest without an untyped binding.
    const result = await router.invoke({ capability, input }, context).finally(() => {
      inFlightModelCalls -= 1;
    });
    if (!result.ok) return fail(result.metadata.latencyMs, result.error.code);
    const parsed = schema.safeParse(result.output);
    if (!parsed.success) return fail(result.metadata.latencyMs, "provider_error");
    stageObserver?.observe({
      stage: capability,
      outcome: "SUCCESS",
      latencyMs: result.metadata.latencyMs,
    });
    return { ok: true, output: parsed.data };
  }

  return {
    invoke: invokeSlot,
    async hedgedInvoke<Output>(
      capability: "rerank" | "llm" | "verifier",
      input: unknown,
      schema: z.ZodType<Output>,
      context: TrustedModelContext,
      hedgeAtMs: number | null,
    ): Promise<ModelSlotResult<Output>> {
      // Under saturation a duplicate cannot settle ahead of its primary - they queue together -
      // so starting one only doubles provider demand. Run the slot unduplicated instead.
      if (hedgeAtMs !== null && inFlightModelCalls >= HEDGE_SATURATION_LIMIT) {
        hedgeAtMs = null;
      }
      const primary = invokeSlot(capability, input, schema, context);
      if (hedgeAtMs === null) return await primary;

      let removeTrigger: () => void = () => undefined;
      const triggered = new Promise<"HEDGE">((resolve) => {
        removeTrigger = scheduler.schedule(hedgeAtMs, () => resolve("HEDGE"));
      });
      const primaryArm = primary.then((result) => ({ from: "PRIMARY" as const, result }));
      // Marks the arm handled so a losing rejection is never reported as unhandled; the awaited
      // reference below still surfaces a genuine throw exactly as it did before hedging existed.
      void primaryArm.catch(() => undefined);
      let first: Awaited<typeof primaryArm> | "HEDGE";
      try {
        first = await Promise.race([primaryArm, triggered]);
      } finally {
        removeTrigger();
      }
      if (first !== "HEDGE") return first.result;

      stageObserver?.observeHedge?.({ stage: capability, outcome: "STARTED" });
      const hedgeArm = invokeSlot(capability, input, schema, context).then((result) => ({
        from: "HEDGE" as const,
        result,
      }));
      void hedgeArm.catch(() => undefined);
      const settled = await Promise.race([primaryArm, hedgeArm]);
      if (settled.result.ok) {
        stageObserver?.observeHedge?.({
          stage: capability,
          outcome: settled.from === "HEDGE" ? "HEDGE_WON" : "PRIMARY_WON",
        });
        return settled.result;
      }
      const other = await (settled.from === "PRIMARY" ? hedgeArm : primaryArm);
      if (!other.result.ok) {
        stageObserver?.observeHedge?.({ stage: capability, outcome: "BOTH_FAILED" });
        return settled.result;
      }
      stageObserver?.observeHedge?.({
        stage: capability,
        outcome: other.from === "HEDGE" ? "HEDGE_WON" : "PRIMARY_WON",
      });
      return other.result;
    },
    async invokeRerankAndLlmPair(dependencies) {
      // Every deadline abort in the 20-run provider profile was a run where one of these two slots
      // ran long enough to leave no room for the serial verifier, and the two never ran long in the
      // same run. One duplicate call therefore addresses exactly the observed failure. The trigger
      // is derived from the remaining budget instead of a fixed delay: a duplicate is only worth
      // starting while a typical call still fits before the verifier needs its slot, so once that
      // moment has passed the slot runs unduplicated.
      const hedgeAt = (slot: "rerank" | "llm"): number | null =>
        hedgeAtMs(slot, dependencies.pairStartedAtMs, dependencies.pairBudgetMs);
      return await Promise.all([
        this.hedgedInvoke(
          "rerank",
          {
            task: "RERANK_EVIDENCE",
            query: dependencies.query,
            untrustedData: dependencies.rerankData,
          },
          rerankOutputSchema,
          dependencies.context,
          hedgeAt("rerank"),
        ),
        this.hedgedInvoke(
          "llm",
          {
            task: "CREATE_STRUCTURED_RECOMMENDATION",
            constraints: {
              maySelectTools: false,
              maySelectUrls: false,
              mayAuthorize: false,
              mayPublish: false,
            },
            query: dependencies.query,
            untrustedData: dependencies.generationData,
          },
          StructuredRecommendationSchema,
          dependencies.context,
          hedgeAt("llm"),
        ),
      ] as const);
    },
  };
}
