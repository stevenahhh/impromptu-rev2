import { z } from "zod";
import { TimestampMsSchema } from "./common.ts";
import { RetrievalFailureCodeSchema } from "./retrieval.ts";
import { PresentationSessionIdSchema } from "./session-identifiers.ts";

/**
 * Wire contract for one Q&A exchange during a private presentation defense. The Console
 * renders against this shape; keep it byte-stable across releases.
 */

export const QaQuestionOriginSchema = z.enum(["TYPED", "SPOKEN"]);
export type QaQuestionOrigin = z.infer<typeof QaQuestionOriginSchema>;

export const QaCitationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("DECK_SLIDE"),
      evidenceId: z.string().min(1),
      slideOrdinal: z.number().int().min(1),
      title: z.string().min(1),
      quote: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("REFERENCE_DOCUMENT"),
      evidenceId: z.string().min(1),
      documentTitle: z.string().min(1),
      chunkOrdinal: z.number().int().min(1),
      quote: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("EXTERNAL_SOURCE"),
      evidenceId: z.string().min(1),
      title: z.string().min(1),
      url: z.url(),
      quote: z.string().min(1),
    })
    .strict(),
]);
export type QaCitation = z.infer<typeof QaCitationSchema>;

export const QaDefenseRequestSchema = z
  .object({
    presentationSessionId: PresentationSessionIdSchema,
    questionText: z.string().trim().min(1).max(2_000),
    origin: QaQuestionOriginSchema,
  })
  .strict();
export type QaDefenseRequest = z.infer<typeof QaDefenseRequestSchema>;

/**
 * Latency mirrors RecommendationOutcome's own latencyMs (`z.number().finite().nonnegative()`)
 * so any RecommendationOutcome parses without lossy rounding at this boundary.
 * completedAtMs reuses TimestampMsSchema.
 */
export const QaDefenseOutcomeSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("ANSWERED"),
      answer: z.string().min(1),
      citations: z.array(QaCitationSchema).min(1).max(3),
      completedAtMs: TimestampMsSchema,
      latencyMs: z.number().finite().nonnegative(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("ABSTAINED"),
      reason: RetrievalFailureCodeSchema,
      retryable: z.boolean(),
      completedAtMs: TimestampMsSchema,
      latencyMs: z.number().finite().nonnegative(),
    })
    .strict(),
]);
export type QaDefenseOutcome = z.infer<typeof QaDefenseOutcomeSchema>;

// ---------------------------------------------------------------------------
// FIVE-MINUTE ASK WINDOW. Once the owner opens post-talk Q&A, questions stay
// askable for exactly QA_ASK_WINDOW_MS after qaStartedAtMs: an accepted
// submission echoes the typed askableUntilMs expiry, an ask at or past it is
// refused with the typed qa_expired rejection, and the read-only recheck view
// reports the window LIVE -> EXPIRED so a submission whose window lapses while
// the presenter waits can never sit silently as 'asking'.
// ---------------------------------------------------------------------------
export const QA_ASK_WINDOW_MS = 300_000 as const;

/**
 * Terminal verdicts are explicit: EMPTY means no Q&A window was ever opened for the
 * session (asking is refused before opening) and EXPIRED means the window's deadline
 * passed. Only LIVE submissions may be re-checked; EMPTY/EXPIRED never re-arm.
 */
export const QaWindowStatusSchema = z.enum(["EMPTY", "LIVE", "EXPIRED"]);
export type QaWindowStatus = z.infer<typeof QaWindowStatusSchema>;

export const QaDefenseWindowSchema = z
  .object({
    status: QaWindowStatusSchema,
    /** Deadline the window asks until; null only for a never-opened (EMPTY) window. */
    askableUntilMs: TimestampMsSchema.nullable(),
  })
  .strict();
export type QaDefenseWindow = z.infer<typeof QaDefenseWindowSchema>;

/**
 * The accepted submission: the defense outcome plus the typed expiry of the window it
 * was accepted under. Closed — a response without the deadline fails to parse rather
 * than silently reading as unbounded.
 */
export const QaAskResultSchema = z.discriminatedUnion("outcome", [
  QaDefenseOutcomeSchema.options[0].extend({ askableUntilMs: TimestampMsSchema }),
  QaDefenseOutcomeSchema.options[1].extend({ askableUntilMs: TimestampMsSchema }),
]);
export type QaAskResult = z.infer<typeof QaAskResultSchema>;
