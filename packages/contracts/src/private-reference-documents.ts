import { z } from "zod";
import { Sha256Schema } from "./common.ts";

/**
 * Reference documents are presenter-uploaded files (a project folder's worth
 * of context) attached to one presentation session. Their extracted text is
 * chunked and embedded into the same private retrieval store the deck corpus
 * uses, so recommendations can cite an uploaded reference document.
 */

/**
 * INDEXED: extracted text chunks were embedded and are searchable.
 * STORED_INDEX_PENDING: the document is stored and has extractable text, but
 *   zero chunks were indexed (e.g. the embedding provider was unavailable).
 * EMPTY: the document is stored but extraction produced no chunkable text.
 */
export const ReferenceDocumentStatusSchema = z.enum(["INDEXED", "STORED_INDEX_PENDING", "EMPTY"]);
export type ReferenceDocumentStatus = z.infer<typeof ReferenceDocumentStatusSchema>;

export const ReferenceDocumentRejectionReasonSchema = z.enum([
  "EMPTY_INPUT",
  "MALFORMED_INPUT",
  "UNSUPPORTED_TYPE",
  "UNSAFE_FILENAME",
  "TOO_LARGE",
  "TOO_MANY_FILES",
  "EXTRACTION_FAILED",
  "PRESENTATION_UNKNOWN",
]);
export type ReferenceDocumentRejectionReason = z.infer<
  typeof ReferenceDocumentRejectionReasonSchema
>;

export const ReferenceDocumentSummarySchema = z
  .object({
    documentId: Sha256Schema,
    presentationSessionId: z.string().min(1).max(128),
    filename: z.string().min(1).max(255),
    contentType: z.string().min(1).max(128),
    byteLength: z.number().int().positive(),
    chunkCount: z.number().int().nonnegative(),
    status: ReferenceDocumentStatusSchema,
  })
  .strict();
export type ReferenceDocumentSummary = z.infer<typeof ReferenceDocumentSummarySchema>;

export const ReferenceDocumentUploadOutcomeSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("ACCEPTED"),
      documents: z.array(ReferenceDocumentSummarySchema).min(1),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("REJECTED"),
      reason: ReferenceDocumentRejectionReasonSchema,
    })
    .strict(),
]);
export type ReferenceDocumentUploadOutcome = z.infer<typeof ReferenceDocumentUploadOutcomeSchema>;

export const ReferenceDocumentListResponseSchema = z
  .object({
    documents: z.array(ReferenceDocumentSummarySchema),
  })
  .strict();
export type ReferenceDocumentListResponse = z.infer<typeof ReferenceDocumentListResponseSchema>;
