import { z } from "zod";
import { PublicSlideOccurrenceSchema, Sha256Schema, VersionIdSchema } from "./common.ts";
import {
  CandidateIdSchema,
  SourceIdSchema,
  TranscriptFinalIdSchema,
} from "./private-identifiers.ts";
import { DeckVersionIdSchema, DisplayBindingEpochSchema } from "./public-identifiers.ts";
import {
  PresentationSessionEpochSchema,
  PresentationSessionIdSchema,
} from "./session-identifiers.ts";

export const SourceRevisionSchema = z
  .object({
    sourceId: SourceIdSchema,
    revision: VersionIdSchema,
    contentHash: Sha256Schema,
  })
  .strict();

export const DecisionVersionsSchema = z
  .object({
    acl: VersionIdSchema,
    publicationPolicy: VersionIdSchema,
    rights: VersionIdSchema,
    dlp: VersionIdSchema,
  })
  .strict();

export const CausalEnvelopeSchema = z
  .object({
    presentationSessionId: PresentationSessionIdSchema,
    presentationSessionEpoch: PresentationSessionEpochSchema,
    displayBindingEpoch: DisplayBindingEpochSchema,
    deckVersion: DeckVersionIdSchema,
    manifestHash: Sha256Schema,
    occurrence: PublicSlideOccurrenceSchema,
    transcriptFinalId: TranscriptFinalIdSchema.nullable(),
    source: SourceRevisionSchema,
    decisions: DecisionVersionsSchema,
  })
  .strict();

export const EvidenceCandidateSchema = z
  .object({
    candidateId: CandidateIdSchema,
    candidateVersion: VersionIdSchema,
    provenance: z.enum(["CURATED_PREAPPROVED", "LIVE_VERIFIED"]),
    verdict: z.literal("SUPPORTED"),
    claimText: z.string().min(1),
    evidenceExcerpt: z.string().min(1),
    privateSourceUri: z.string().min(1),
    causal: CausalEnvelopeSchema,
  })
  .strict()
  .superRefine((candidate, context) => {
    if (candidate.provenance === "LIVE_VERIFIED" && candidate.causal.transcriptFinalId === null) {
      context.addIssue({
        code: "custom",
        message: "live verified evidence requires a final transcript identity",
        path: ["causal", "transcriptFinalId"],
      });
    }
  });

export type CausalEnvelope = z.infer<typeof CausalEnvelopeSchema>;
export type EvidenceCandidate = z.infer<typeof EvidenceCandidateSchema>;
