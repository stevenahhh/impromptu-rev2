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
