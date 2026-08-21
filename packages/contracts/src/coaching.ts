import { z } from "zod";

export const COACHING_ROLLING_WINDOW_MS = 30_000 as const;

const CoachingSessionGenerationSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const CoachingSequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const CoachingSegmentIdSchema = z.string().min(1).max(200);

export const CoachingFinalWordSchema = z
  .object({
    text: z.string().trim().min(1),
    startSessionMs: z.number().int().nonnegative(),
    endSessionMs: z.number().int().nonnegative(),
  })
  .strict()
  .refine((word) => word.endSessionMs >= word.startSessionMs, {
    message: "word end must not precede word start",
  });

const CoachingTranscriptBaseShape = {
  sessionGeneration: CoachingSessionGenerationSchema,
  sequence: CoachingSequenceSchema,
  segmentId: CoachingSegmentIdSchema,
} as const;

const CoachingPreviewEventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...CoachingTranscriptBaseShape,
      kind: z.literal("PARTIAL"),
      preview: z.string(),
    })
    .strict(),
  z
    .object({
      ...CoachingTranscriptBaseShape,
      kind: z.literal("REPLACE"),
      replacesSequence: CoachingSequenceSchema,
      preview: z.string(),
    })
    .strict(),
]);

export const CoachingFinalEventSchema = z
  .object({
    ...CoachingTranscriptBaseShape,
    kind: z.literal("FINAL"),
    finalSegmentId: CoachingSegmentIdSchema,
    finalizedAtSessionMs: z.number().int().nonnegative(),
    words: z.array(CoachingFinalWordSchema),
  })
  .strict()
  .superRefine((event, context) => {
    let previousEndSessionMs = 0;
    for (const [index, word] of event.words.entries()) {
      if (word.startSessionMs < previousEndSessionMs) {
        context.addIssue({
          code: "custom",
          message: "final word timestamps must be monotonic",
          path: ["words", index, "startSessionMs"],
        });
      }
      if (word.endSessionMs > event.finalizedAtSessionMs) {
        context.addIssue({
          code: "custom",
          message: "final word end must not exceed finalization time",
          path: ["words", index, "endSessionMs"],
        });
      }
      previousEndSessionMs = word.endSessionMs;
    }
  });

const CoachingUnavailableEventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      sessionGeneration: CoachingSessionGenerationSchema,
      sequence: CoachingSequenceSchema,
      kind: z.literal("PROVIDER_LAG"),
    })
    .strict(),
  z
    .object({
      sessionGeneration: CoachingSessionGenerationSchema,
      sequence: CoachingSequenceSchema,
      kind: z.literal("NETWORK_ABORT"),
    })
    .strict(),
]);

export const CoachingEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("OPT_IN"), enabled: z.boolean() }).strict(),
  z.object({ kind: z.literal("MUTE"), muted: z.boolean() }).strict(),
  ...CoachingPreviewEventSchema.options,
  CoachingFinalEventSchema,
  ...CoachingUnavailableEventSchema.options,
]);

export const CoachingMeasurementSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("AVAILABLE"),
      currentWordsPerMinute: z.number().finite().nonnegative(),
      previousWordsPerMinute: z.number().finite().nonnegative(),
      deltaWordsPerMinute: z.number().finite(),
    })
    .strict(),
  z.object({ outcome: z.literal("MEASUREMENT_UNAVAILABLE") }).strict(),
]);

export type CoachingFinalWord = z.infer<typeof CoachingFinalWordSchema>;
export type CoachingFinalEvent = z.infer<typeof CoachingFinalEventSchema>;
export type CoachingEvent = z.infer<typeof CoachingEventSchema>;
export type CoachingMeasurement = z.infer<typeof CoachingMeasurementSchema>;
