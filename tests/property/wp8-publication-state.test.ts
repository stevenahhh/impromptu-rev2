import { describe, expect, test } from "bun:test";
import {
  CandidateIdSchema,
  candidateRevision,
  PresentationSessionIdSchema,
} from "@impromptu/contracts/private";
import { PublishedAudienceCardSchema, presentationSessionEpoch } from "@impromptu/contracts/public";
import { createCandidateLifecycle, reduceCandidateLifecycle } from "@impromptu/state";

const identity = {
  presentationSessionId: PresentationSessionIdSchema.parse("ps_wp8-state"),
  presentationSessionEpoch: presentationSessionEpoch(1),
  candidateId: CandidateIdSchema.parse("candidate_wp8-state"),
  candidateVersion: "candidate-version-1",
} as const;

function operation(type: "QUALIFY" | "MARK_STALE" | "PUBLISH", expectedRevision: number) {
  return {
    type,
    ...identity,
    expectedRevision: candidateRevision(expectedRevision),
    ...(type === "PUBLISH"
      ? { projectionId: "projection_wp8-state", publicCardRevision: "pcr_1" }
      : {}),
  };
}

describe("WP8 independent candidate state", () => {
  test("tracks verdict, publication, and freshness independently under candidate-version CAS", () => {
    const initial = createCandidateLifecycle({ ...identity, contentHash: "a".repeat(64) });
    expect(initial).toMatchObject({
      verdict: "PENDING",
      publicationState: "PRIVATE",
      freshness: "FRESH",
    });

    const qualified = reduceCandidateLifecycle(initial, operation("QUALIFY", 0));
    expect(qualified.outcome).toBe("APPLIED");
    if (qualified.outcome !== "APPLIED") throw new Error("qualification failed");
    expect(qualified.state).toMatchObject({
      verdict: "SUPPORTED",
      publicationState: "PRIVATE",
      freshness: "FRESH",
    });

    const published = reduceCandidateLifecycle(qualified.state, operation("PUBLISH", 1));
    expect(published.outcome).toBe("APPLIED");
    if (published.outcome !== "APPLIED") throw new Error("publication failed");
    const stale = reduceCandidateLifecycle(published.state, operation("MARK_STALE", 2));
    expect(stale.outcome).toBe("APPLIED");
    if (stale.outcome !== "APPLIED") throw new Error("freshness transition failed");
    expect(stale.state).toMatchObject({
      verdict: "SUPPORTED",
      publicationState: "PUBLISHED",
      freshness: "STALE",
    });
  });

  test("requires a bounded lease and complete causal binding for live public cards", () => {
    const base = {
      projectionId: "projection_wp8-live",
      status: "PUBLISHED",
      mode: "LIVE",
      claim: "검증된 주장",
      supportSummary: "권위 있는 근거",
      sourceLabel: "공개 출처",
      publishedAtMs: 1_000,
      expiresAtMs: 4_000,
      leaseExpiresAtMs: 4_000,
      publicCardRevision: "pcr_1",
      deckVersion: "deck_wp8",
      manifestHash: "b".repeat(64),
      occurrence: { publicSlideKey: "slide_wp8", occurrenceSeq: 2 },
      liveBinding: {
        presentationSessionEpoch: "pse_1",
        publicSlideOccurrence: { publicSlideKey: "slide_wp8", occurrenceSeq: 2 },
        publicationPolicyVersion: "publication-policy-1",
        cardVersion: "card-version-1",
      },
    } as const;
    expect(PublishedAudienceCardSchema.safeParse(base).success).toBe(true);
    expect(
      PublishedAudienceCardSchema.safeParse({ ...base, leaseExpiresAtMs: 4_001 }).success,
    ).toBe(false);
    expect(PublishedAudienceCardSchema.safeParse({ ...base, liveBinding: undefined }).success).toBe(
      false,
    );
  });
});
