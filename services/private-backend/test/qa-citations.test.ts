import { describe, expect, test } from "bun:test";
import { type RetrievedEvidence, RetrievedEvidenceSchema } from "@impromptu/contracts/retrieval";
import { toQaCitation } from "../src/qa/qa-citations.ts";

const manifestHash = "b".repeat(64);

type EvidenceOverrides = Partial<RetrievedEvidence>;

/**
 * Builds a RetrievedEvidence in the exact shape internal retrieval materializes for deck
 * slides and reference documents (canonicalUrl and sourceDate hard-coded to null), with the
 * anchor formats produced by deck-artifact-scan.ts (`slide=<N>&chunk=<M>`) and
 * reference-documents.ts (`chunk=<n>`). The schema parse keeps fixtures honest.
 */
function evidence(overrides: EvidenceOverrides): RetrievedEvidence {
  return RetrievedEvidenceSchema.parse({
    evidenceId: `internal:${overrides.anchor}:${overrides.sourceRevision ?? "rev-1"}`,
    sourceId: "source-1",
    sourceRevision: "rev-1",
    sourceHash: new Bun.CryptoHasher("sha256")
      .update(overrides.content ?? "Revenue was 42 million USD in 2025.")
      .digest("hex"),
    deckVersion: "deck_2026launch",
    manifestHash,
    title: "Slide 3",
    content: "Revenue was 42 million USD in 2025.",
    quote: "Revenue was 42 million USD in 2025.",
    anchor: "slide=3&chunk=1",
    canonicalUrl: null,
    sourceDate: null,
    rights: "APPROVED",
    containsPii: false,
    authorizationVersion: "auth-9",
    ...overrides,
  });
}

describe("toQaCitation", () => {
  test("maps a slide anchor to a DECK_SLIDE citation", () => {
    const item = evidence({ anchor: "slide=3&chunk=2", title: "Slide 3" });
    expect(toQaCitation(item)).toEqual({
      kind: "MAPPED",
      citation: {
        kind: "DECK_SLIDE",
        evidenceId: "internal:slide=3&chunk=2:rev-1",
        slideOrdinal: 3,
        title: "Slide 3",
        quote: "Revenue was 42 million USD in 2025.",
      },
    });
  });

  test("maps chunk 1 of the first slide independently of later chunks", () => {
    const item = evidence({
      anchor: "slide=7&chunk=1",
      title: "Slide 7",
      content: "Churn fell to 2.1 percent.",
      quote: "Churn fell to 2.1 percent.",
    });
    expect(toQaCitation(item)).toEqual({
      kind: "MAPPED",
      citation: {
        kind: "DECK_SLIDE",
        evidenceId: "internal:slide=7&chunk=1:rev-1",
        slideOrdinal: 7,
        title: "Slide 7",
        quote: "Churn fell to 2.1 percent.",
      },
    });
  });

  test("maps a reference-document anchor to a REFERENCE_DOCUMENT citation", () => {
    const item = evidence({
      anchor: "chunk=5",
      title: "q3-financials.pdf",
      content: "Gross margin improved to 61 percent quarter over quarter.",
      quote: "Gross margin improved to 61 percent quarter over quarter.",
    });
    expect(toQaCitation(item)).toEqual({
      kind: "MAPPED",
      citation: {
        kind: "REFERENCE_DOCUMENT",
        evidenceId: "internal:chunk=5:rev-1",
        documentTitle: "q3-financials.pdf",
        chunkOrdinal: 5,
        quote: "Gross margin improved to 61 percent quarter over quarter.",
      },
    });
  });

  test("maps an unrecognized anchor with a canonicalUrl to an EXTERNAL_SOURCE citation", () => {
    const url = "https://example.com/reports/q3.pdf";
    const item = evidence({
      anchor: "url=https://example.com/reports/q3.pdf#page=4",
      title: "Q3 industry report",
      content: "The category grew 14 percent year over year.",
      quote: "The category grew 14 percent year over year.",
      canonicalUrl: url,
      sourceDate: "2026-03-01",
    });
    expect(toQaCitation(item)).toEqual({
      kind: "MAPPED",
      citation: {
        kind: "EXTERNAL_SOURCE",
        evidenceId: "internal:url=https://example.com/reports/q3.pdf#page=4:rev-1",
        title: "Q3 industry report",
        url,
        quote: "The category grew 14 percent year over year.",
      },
    });
  });

  test("skips an unrecognized anchor when there is no canonicalUrl instead of guessing", () => {
    const item = evidence({ anchor: "page=4" });
    const result = toQaCitation(item);
    if (result.kind !== "SKIPPED") throw new Error(`expected SKIPPED, got ${result.kind}`);
    expect(result.reason).toContain("page=4");
  });

  test("skips an out-of-range ordinal rather than emitting an invalid citation", () => {
    // Anchors produced by ingestion always start at 1; slide=0 would violate the contract.
    const result = toQaCitation(evidence({ anchor: "slide=0&chunk=1" }));
    if (result.kind !== "SKIPPED") throw new Error(`expected SKIPPED, got ${result.kind}`);
    expect(result.reason).toContain("slide=0&chunk=1");
  });
});
