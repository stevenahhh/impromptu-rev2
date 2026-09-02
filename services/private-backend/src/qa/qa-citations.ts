import type { QaCitation } from "@impromptu/contracts/private";
import type { RetrievedEvidence } from "@impromptu/contracts/retrieval";

/**
 * Pure mapping from retrieved evidence to a showable citation. No I/O, no clock, no
 * randomness.
 *
 * Anchor shapes, as produced by ingestion:
 * - deck slides (`deck-artifact-scan.ts`): `slide=<N>&chunk=<M>`, ordinal >= 1
 * - reference documents (`reference-documents.ts`): `chunk=<n>`, ordinal >= 1
 *
 * Honest-behavior decision for an evidence item whose anchor matches NEITHER shape:
 * if the item carries a canonicalUrl it is an external source and becomes an
 * EXTERNAL_SOURCE citation; otherwise it is SKIPPED with a reason rather than guessed
 * into a wrong bucket. It never crashes the answer — callers filter the skipped items
 * out and the outcome module decides whether enough citations survive.
 */
export type CitationMapping =
  | { readonly kind: "MAPPED"; readonly citation: QaCitation }
  | { readonly kind: "SKIPPED"; readonly reason: string };

const SLIDE_ANCHOR = /^slide=(\d+)&chunk=(\d+)$/;
const CHUNK_ANCHOR = /^chunk=(\d+)$/;

function positiveOrdinal(text: string): number | null {
  const value = Number.parseInt(text, 10);
  // Ordinals are 1-based everywhere; a 0 would fail the contract's min(1).
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

export function toQaCitation(evidence: RetrievedEvidence): CitationMapping {
  const slideMatch = SLIDE_ANCHOR.exec(evidence.anchor);
  if (slideMatch !== null) {
    const slideOrdinal = positiveOrdinal(slideMatch[1] ?? "");
    const chunkOrdinal = positiveOrdinal(slideMatch[2] ?? "");
    if (slideOrdinal !== null && chunkOrdinal !== null) {
      return {
        kind: "MAPPED",
        citation: {
          kind: "DECK_SLIDE",
          evidenceId: evidence.evidenceId,
          slideOrdinal,
          title: evidence.title,
          quote: evidence.quote,
        },
      };
    }
  }

  const chunkMatch = CHUNK_ANCHOR.exec(evidence.anchor);
  if (chunkMatch !== null) {
    const chunkOrdinal = positiveOrdinal(chunkMatch[1] ?? "");
    if (chunkOrdinal !== null) {
      return {
        kind: "MAPPED",
        citation: {
          kind: "REFERENCE_DOCUMENT",
          evidenceId: evidence.evidenceId,
          documentTitle: evidence.title,
          chunkOrdinal,
          quote: evidence.quote,
        },
      };
    }
  }

  if (evidence.canonicalUrl !== null && evidence.canonicalUrl !== "") {
    return {
      kind: "MAPPED",
      citation: {
        kind: "EXTERNAL_SOURCE",
        evidenceId: evidence.evidenceId,
        title: evidence.title,
        url: evidence.canonicalUrl,
        quote: evidence.quote,
      },
    };
  }

  return {
    kind: "SKIPPED",
    reason: `evidence ${evidence.evidenceId} has unrecognized anchor "${evidence.anchor}" and no canonicalUrl; refusing to guess a citation kind`,
  };
}

export function qaCitations(evidence: readonly RetrievedEvidence[]): {
  readonly citations: QaCitation[];
  readonly skipped: string[];
} {
  const citations: QaCitation[] = [];
  const skipped: string[] = [];
  for (const item of evidence) {
    const mapping = toQaCitation(item);
    if (mapping.kind === "MAPPED") citations.push(mapping.citation);
    else skipped.push(mapping.reason);
  }
  return { citations, skipped };
}
