import { z } from "zod";
import { Sha256Schema, VersionIdSchema } from "./common.ts";
import { DeckVersionIdSchema } from "./public-identifiers.ts";

export const RetrievalFailureCodeSchema = z.enum([
  "INVALID_REQUEST",
  "POLICY_UNAVAILABLE",
  "STALE_AUTHORIZATION_METADATA",
  "UNAUTHORIZED",
  "STALE_DECK",
  "STALE_SOURCE",
  "FETCH_REJECTED",
  "FETCH_LIMIT_EXCEEDED",
  "MODEL_FAILURE",
  "BUDGET_EXCEEDED",
  "DEADLINE_EXCEEDED",
  "INSUFFICIENT_EVIDENCE",
  "CONFLICTING_EVIDENCE",
  "DETERMINISTIC_MISMATCH",
]);
export type RetrievalFailureCode = z.infer<typeof RetrievalFailureCodeSchema>;

export const RetrievalRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(2_000),
    deckVersion: DeckVersionIdSchema,
    manifestHash: Sha256Schema,
    /**
     * Anchors the request to one slide. A browser only knows a slide's public key and its
     * accessible name, which is the deck title followed by an ordinal — asking for evidence
     * with that as the query made the model assert the ordinal as a fact the deck never
     * states, and the deterministic gate rightly refused every slide. Given the key, the
     * private side substitutes the slide's own indexed text, which is what the presenter
     * actually wants evidence for.
     */
    slideOrdinal: z.number().int().min(1).max(10_000).optional(),
    maxResults: z.number().int().min(1).max(3).default(3),
  })
  .strict();
export type RetrievalRequest = z.infer<typeof RetrievalRequestSchema>;

export const EvidenceFactSetSchema = z
  .object({
    numbers: z.array(z.string().min(1)).max(32),
    units: z.array(z.string().min(1)).max(32),
    dates: z.array(z.string().min(1)).max(32),
    entities: z.array(z.string().min(1)).max(32),
  })
  .strict();
export type EvidenceFactSet = z.infer<typeof EvidenceFactSetSchema>;

export const RetrievedEvidenceSchema = z
  .object({
    evidenceId: z.string().min(1),
    sourceId: z.string().min(1),
    sourceRevision: VersionIdSchema,
    sourceHash: Sha256Schema,
    deckVersion: DeckVersionIdSchema,
    manifestHash: Sha256Schema,
    title: z.string().min(1),
    content: z.string().min(1),
    quote: z.string().min(1),
    anchor: z.string().min(1),
    canonicalUrl: z.string().url().nullable(),
    sourceDate: z.string().min(1).nullable(),
    rights: z.enum(["APPROVED", "UNKNOWN", "DENIED"]),
    containsPii: z.boolean(),
    authorizationVersion: VersionIdSchema,
  })
  .strict();
export type RetrievedEvidence = z.infer<typeof RetrievedEvidenceSchema>;

export const StructuredRecommendationSchema = z
  .object({
    claim: z.string().trim().min(1).max(2_000),
    evidenceIds: z.array(z.string().min(1)).min(1).max(3),
    facts: EvidenceFactSetSchema,
  })
  .strict();
export type StructuredRecommendation = z.infer<typeof StructuredRecommendationSchema>;

export const VerifierModelOutputSchema = z
  .object({
    verdict: z.enum(["SUPPORTED", "INSUFFICIENT", "CONFLICTING"]),
    rationaleCode: z.string().min(1).max(100),
  })
  .strict();
export type VerifierModelOutput = z.infer<typeof VerifierModelOutputSchema>;

export const RecommendationOutcomeSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("RECOMMEND"),
      recommendation: StructuredRecommendationSchema,
      evidence: z.array(RetrievedEvidenceSchema).min(1).max(3),
      completedAtMs: z.number().finite().nonnegative(),
      latencyMs: z.number().finite().nonnegative(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("ABSTAIN"),
      reason: RetrievalFailureCodeSchema,
      completedAtMs: z.number().finite().nonnegative(),
      latencyMs: z.number().finite().nonnegative(),
    })
    .strict(),
]);
export type RecommendationOutcome = z.infer<typeof RecommendationOutcomeSchema>;
