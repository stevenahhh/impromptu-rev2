import { describe, expect, test } from "bun:test";
import {
  ReferenceDocumentRejectionReasonSchema,
  ReferenceDocumentStatusSchema,
  ReferenceDocumentUploadOutcomeSchema,
} from "./private-reference-documents.ts";

/**
 * Regression pins for the reference-document upload outcome contract:
 * the document status distinguishes indexed from stored-but-unindexed, and the
 * rejection reasons stay closed to reasons producers actually emit.
 */

describe("private reference document contract", () => {
  test("accepts exactly the honest terminal states for a stored document", () => {
    for (const status of ["INDEXED", "STORED_INDEX_PENDING", "EMPTY"] as const) {
      expect(ReferenceDocumentStatusSchema.parse(status)).toBe(status);
    }
  });

  test("rejects the dead EMBEDDING_UNAVAILABLE rejection reason", () => {
    expect(ReferenceDocumentRejectionReasonSchema.safeParse("EMBEDDING_UNAVAILABLE").success).toBe(
      false,
    );
  });

  test("parses an accepted upload carrying a stored-but-unindexed document", () => {
    const outcome = ReferenceDocumentUploadOutcomeSchema.parse({
      outcome: "ACCEPTED",
      documents: [
        {
          documentId: "d".repeat(64),
          presentationSessionId: "ps_1",
          filename: "notes.md",
          contentType: "text/markdown",
          byteLength: 32,
          chunkCount: 0,
          status: "STORED_INDEX_PENDING",
        },
      ],
    });
    expect(outcome.outcome).toBe("ACCEPTED");
  });
});
