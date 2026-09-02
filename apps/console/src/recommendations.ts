// Recommendation requests against the private backend and the closed parsing of
// recommendation outcomes into provenance-checked evidence cards.

import {
  externalSourceUrl,
  mutationHeaders,
  optionalUrl,
  type PrivateClientContext,
  responseBody,
} from "./private-transport";

export interface RecommendationRequest {
  readonly query: string;
  readonly deckVersion: string;
  readonly manifestHash: string;
  /**
   * Anchors the request to one slide. The browser can only name a slide by its accessible
   * name, which is the deck title and an ordinal; the ordinal lets the private side ground
   * the request in that slide's own indexed text instead.
   */
  readonly slideOrdinal?: number;
  readonly maxResults: number;
}

interface EvidenceCardProvenance {
  readonly evidenceId: string;
  readonly title: string;
  readonly sourceUrl: string | null;
  readonly sourceDate: string | null;
}

export type PrivateEvidenceCardView =
  | Readonly<
      EvidenceCardProvenance & {
        kind: "INTERNAL";
        rights: "APPROVED";
      }
    >
  | Readonly<
      EvidenceCardProvenance & {
        kind: "EXTERNAL";
        sourceUrl: string;
        rights: "UNKNOWN";
      }
    >;

export type RecommendationOutcome =
  | Readonly<{
      outcome: "RECOMMEND";
      recommendation: Readonly<{ claim: string }>;
      evidence: readonly PrivateEvidenceCardView[];
      completedAtMs: number;
      latencyMs: number;
    }>
  | Readonly<{
      outcome: "ABSTAIN";
      reason: string;
      completedAtMs: number;
      latencyMs: number;
    }>;

function privateEvidenceCard(value: unknown): PrivateEvidenceCardView | null {
  if (typeof value !== "object" || value === null) return null;
  const evidenceId = Reflect.get(value, "evidenceId");
  const sourceId = Reflect.get(value, "sourceId");
  const title = Reflect.get(value, "title");
  const canonicalUrl = Reflect.get(value, "canonicalUrl");
  const sourceDate = Reflect.get(value, "sourceDate");
  const rights = Reflect.get(value, "rights");
  if (
    typeof evidenceId !== "string" ||
    typeof sourceId !== "string" ||
    typeof title !== "string" ||
    title.length === 0 ||
    (typeof sourceDate !== "string" && sourceDate !== null)
  ) {
    return null;
  }
  if (rights === "APPROVED") {
    const sourceUrl = optionalUrl(canonicalUrl);
    return sourceUrl === undefined
      ? null
      : { kind: "INTERNAL", evidenceId, title, sourceUrl, sourceDate, rights };
  }
  if (
    rights === "UNKNOWN" &&
    evidenceId.startsWith("external:") &&
    sourceId.startsWith("external-search:")
  ) {
    const sourceUrl = externalSourceUrl(canonicalUrl);
    return sourceUrl === null
      ? null
      : { kind: "EXTERNAL", evidenceId, title, sourceUrl, sourceDate, rights };
  }
  return null;
}

function recommendationOutcome(value: unknown): RecommendationOutcome | null {
  if (typeof value !== "object" || value === null) return null;
  const outcome = Reflect.get(value, "outcome");
  const completedAtMs = Reflect.get(value, "completedAtMs");
  const latencyMs = Reflect.get(value, "latencyMs");
  if (typeof completedAtMs !== "number" || typeof latencyMs !== "number") return null;
  if (outcome === "ABSTAIN") {
    const reason = Reflect.get(value, "reason");
    return typeof reason === "string" ? { outcome, reason, completedAtMs, latencyMs } : null;
  }
  if (outcome !== "RECOMMEND") return null;
  const recommendation = Reflect.get(value, "recommendation");
  const evidence = Reflect.get(value, "evidence");
  const claim =
    typeof recommendation === "object" && recommendation !== null
      ? Reflect.get(recommendation, "claim")
      : null;
  if (typeof claim !== "string" || !Array.isArray(evidence)) {
    return null;
  }
  const cards = evidence
    .map(privateEvidenceCard)
    .filter((card): card is PrivateEvidenceCardView => card !== null);
  return {
    outcome,
    recommendation: { claim },
    evidence: cards,
    completedAtMs,
    latencyMs,
  };
}

export async function recommend(
  context: PrivateClientContext,
  csrfToken: string,
  request: RecommendationRequest,
  signal?: AbortSignal,
): Promise<RecommendationOutcome> {
  const response = await fetch(`${context.baseUrl}/v1/recommendations`, {
    method: "POST",
    credentials: "include",
    headers: mutationHeaders(csrfToken),
    body: JSON.stringify(request),
    ...(signal === undefined ? {} : { signal }),
  });
  const body = await responseBody(response);
  const outcome = recommendationOutcome(body);
  if (!response.ok || outcome === null) {
    throw new Error("Recommendation request failed.");
  }
  return outcome;
}
