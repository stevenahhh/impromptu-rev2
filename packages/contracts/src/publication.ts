import { z } from "zod";
import {
  EpochSchema,
  OpaqueIdSchema,
  PublicSlideOccurrenceSchema,
  RevisionSchema,
  Sha256Schema,
  TimestampMsSchema,
  VersionIdSchema,
} from "./common.ts";

export const SourceRevisionSchema = z
  .object({
    sourceId: OpaqueIdSchema,
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
    presentationSessionId: OpaqueIdSchema,
    presentationSessionEpoch: EpochSchema,
    displayBindingEpoch: EpochSchema,
    deckVersion: VersionIdSchema,
    manifestHash: Sha256Schema,
    occurrence: PublicSlideOccurrenceSchema,
    transcriptFinalId: OpaqueIdSchema,
    source: SourceRevisionSchema,
    decisions: DecisionVersionsSchema,
  })
  .strict();

export const EvidenceCandidateSchema = z
  .object({
    candidateId: OpaqueIdSchema,
    candidateVersion: VersionIdSchema,
    provenance: z.enum(["CURATED_PREAPPROVED", "LIVE_VERIFIED"]),
    verdict: z.literal("SUPPORTED"),
    claimText: z.string().min(1),
    evidenceExcerpt: z.string().min(1),
    privateSourceUri: z.string().min(1),
    causal: CausalEnvelopeSchema,
  })
  .strict();

export const PublishedAudienceCardSchema = z
  .object({
    projectionId: OpaqueIdSchema,
    status: z.literal("PUBLISHED"),
    claim: z.string().min(1).max(2_000),
    supportSummary: z.string().min(1).max(4_000),
    sourceLabel: z.string().min(1).max(500),
    publishedAtMs: TimestampMsSchema,
    expiresAtMs: TimestampMsSchema.nullable(),
    publicCardRevision: RevisionSchema,
    deckVersion: VersionIdSchema,
    manifestHash: Sha256Schema,
    occurrence: PublicSlideOccurrenceSchema,
  })
  .strict();

export const PublicationTombstoneSchema = z
  .object({
    projectionId: OpaqueIdSchema,
    status: z.enum(["RETRACTED", "EXPIRED"]),
    publicCardRevision: RevisionSchema,
    occurredAtMs: TimestampMsSchema,
  })
  .strict();

const PublicationMutationHeaderSchema = z
  .object({
    presentationSessionId: OpaqueIdSchema,
    presentationSessionEpoch: EpochSchema,
    actorId: OpaqueIdSchema,
    authorityId: OpaqueIdSchema,
    commandId: OpaqueIdSchema,
    requestHash: Sha256Schema,
    expectedRevision: RevisionSchema,
  })
  .strict();

export const ApprovePublicationSchema = PublicationMutationHeaderSchema.extend({
  type: z.literal("APPROVE"),
  candidateId: OpaqueIdSchema,
  candidateVersion: VersionIdSchema,
}).strict();

export const RetractPublicationSchema = PublicationMutationHeaderSchema.extend({
  type: z.literal("RETRACT"),
  projectionId: OpaqueIdSchema,
}).strict();

export const ExpirePublicationSchema = PublicationMutationHeaderSchema.extend({
  type: z.literal("EXPIRE"),
  projectionId: OpaqueIdSchema,
}).strict();

export const PublicationMutationSchema = z.discriminatedUnion("type", [
  ApprovePublicationSchema,
  RetractPublicationSchema,
  ExpirePublicationSchema,
]);

export type CausalEnvelope = z.infer<typeof CausalEnvelopeSchema>;
export type EvidenceCandidate = z.infer<typeof EvidenceCandidateSchema>;
export type PublishedAudienceCard = z.infer<typeof PublishedAudienceCardSchema>;
export type PublicationTombstone = z.infer<typeof PublicationTombstoneSchema>;
export type PublicationMutation = z.infer<typeof PublicationMutationSchema>;
