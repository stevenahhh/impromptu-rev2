import { describe, expect, test } from "bun:test";
import type { QaCitation } from "@impromptu/contracts/private";
import { DeckVersionIdSchema } from "@impromptu/contracts/public";
import {
  type EvidenceFactSet,
  type RecommendationOutcome,
  type RetrievalFailureCode,
  RetrievalFailureCodeSchema,
  type RetrievedEvidence,
} from "@impromptu/contracts/retrieval";
import {
  isRetryableRetrievalFailureCode,
  qaDefenseOutcome,
  RETRYABLE_RETRIEVAL_FAILURE_CODES,
} from "../src/qa/qa-defense-outcomes.ts";

const manifestHash = "b".repeat(64);

function deckSlide(
  evidenceId: string,
  slideOrdinal: number,
  chunkOrdinal: number,
): RetrievedEvidence {
  const content = `Revenue was ${evidenceId} on slide ${slideOrdinal}.`;
  return {
    evidenceId,
    sourceId: "source-1",
    sourceRevision: "rev-1",
    sourceHash: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
    deckVersion: DeckVersionIdSchema.parse("deck_2026launch"),
    manifestHash,
    title: `Slide ${slideOrdinal}`,
    content,
    quote: content,
    anchor: `slide=${slideOrdinal}&chunk=${chunkOrdinal}`,
    canonicalUrl: null,
    sourceDate: null,
    rights: "APPROVED",
    containsPii: false,
    authorizationVersion: "auth-9",
  };
}

function recommend(overrides?: {
  claim?: string;
  evidenceIds?: string[];
  evidence?: RetrievedEvidence[];
  facts?: EvidenceFactSet;
}): RecommendationOutcome {
  return {
    outcome: "RECOMMEND",
    recommendation: {
      claim: overrides?.claim ?? "Revenue was 42 million USD in 2025.",
      evidenceIds: overrides?.evidenceIds ?? ["ev-1", "ev-2"],
      // Declared by default so every pre-existing ANSWERED fixture survives the
      // no-declared-facts abstention policy introduced after this suite was written.
      facts:
        overrides?.facts ??
        ({
          numbers: ["42"],
          units: ["million"],
          dates: [],
          entities: [],
        } satisfies EvidenceFactSet),
    },
    evidence:
      overrides?.evidence ??
      (
        [
          ["ev-1", 3, 1],
          ["ev-2", 4, 2],
        ] as const
      ).map(([id, slide, chunk]) => deckSlide(id, slide, chunk)),
    completedAtMs: 1_800_000_000_000,
    latencyMs: 950,
  };
}

function abstain(reason: RetrievalFailureCode): RecommendationOutcome {
  return { outcome: "ABSTAIN", reason, completedAtMs: 1_800_000_000_123, latencyMs: 4_400 };
}

describe("qaDefenseOutcome", () => {
  test("maps RECOMMEND to ANSWERED with citations in the model's cited order", () => {
    expect(qaDefenseOutcome(recommend())).toEqual({
      outcome: "ANSWERED",
      answer: "Revenue was 42 million USD in 2025.",
      citations: [
        {
          kind: "DECK_SLIDE",
          evidenceId: "ev-1",
          slideOrdinal: 3,
          title: "Slide 3",
          quote: "Revenue was ev-1 on slide 3.",
        },
        {
          kind: "DECK_SLIDE",
          evidenceId: "ev-2",
          slideOrdinal: 4,
          title: "Slide 4",
          quote: "Revenue was ev-2 on slide 4.",
        },
      ],
      completedAtMs: 1_800_000_000_000,
      latencyMs: 950,
    });
  });

  test("cites only the evidence the model actually cited", () => {
    const third = deckSlide("ev-3", 8, 1);
    const outcome = qaDefenseOutcome(
      recommend({
        evidenceIds: ["ev-2"],
        evidence: [deckSlide("ev-1", 3, 1), third, deckSlide("ev-2", 4, 2)],
      }),
    );
    if (outcome.outcome !== "ANSWERED") throw new Error(`expected ANSWERED, got ${outcome}`);
    expect(outcome.citations.map((c) => c.evidenceId)).toEqual(["ev-2"]);
  });

  test("skips uncitable evidence but keeps the citable rest", () => {
    const uncitable = { ...deckSlide("ev-x", 9, 9), anchor: "page=4" } satisfies RetrievedEvidence;
    const external = {
      ...deckSlide("ev-w", 0, 0),
      anchor: "url=https://example.com/a#p=1",
      canonicalUrl: "https://example.com/report.pdf",
      title: "External report",
    } satisfies RetrievedEvidence;
    const outcome = qaDefenseOutcome(
      recommend({ evidenceIds: ["ev-x", "ev-w", "ev-1"], evidence: [uncitable, external] }),
    );
    if (outcome.outcome !== "ANSWERED") throw new Error(`expected ANSWERED, got ${outcome}`);
    expect(outcome.citations.map((c) => c.kind)).toEqual(["EXTERNAL_SOURCE"]);
    // The external citation carries the real URL; the quote comes straight from the evidence.
    const expected: QaCitation = {
      kind: "EXTERNAL_SOURCE",
      evidenceId: "ev-w",
      title: "External report",
      url: "https://example.com/report.pdf",
      quote: external.quote,
    };
    expect(outcome.citations[0]).toEqual(expected);
  });

  test("abstains when zero usable citations survive extraction", () => {
    const outcome = qaDefenseOutcome(
      recommend({
        evidenceIds: ["ev-x"],
        evidence: [{ ...deckSlide("ev-x", 9, 9), anchor: "page=4" }],
      }),
    );
    expect(outcome).toEqual({
      outcome: "ABSTAINED",
      reason: "INSUFFICIENT_EVIDENCE",
      retryable: false,
      completedAtMs: 1_800_000_000_000,
      latencyMs: 950,
    });
  });

  test("abstains when the recommendation declares no checkable facts at all, even with a valid citation", () => {
    const outcome = qaDefenseOutcome(
      recommend({
        claim: "제공된 증거에는 이 시제품의 개발 비용에 대한 정보가 없습니다.",
        evidenceIds: ["ev-1"],
        evidence: [deckSlide("ev-1", 3, 1)],
        facts: { numbers: [], units: [], dates: [], entities: [] },
      }),
    );
    expect(outcome).toEqual({
      outcome: "ABSTAINED",
      reason: "INSUFFICIENT_EVIDENCE",
      retryable: false,
      completedAtMs: 1_800_000_000_000,
      latencyMs: 950,
    });
  });

  test("answers when the CLAIM TEXT states the checkable fact even though declared fact sets are empty", () => {
    // Regression pinned from live differential execution: a grounded claim whose text states
    // "64퍼센트" reconciles SUPPORTED via extractFacts(claim), yet the vacuity policy looked
    // only at the model's EMPTY declared facts and threw the answer away — 0 of 9 grounded
    // asks answered. Vacuity must use the same union the deterministic gate asserts.
    const outcome = qaDefenseOutcome(
      recommend({
        claim: "2월 현장 점검에서 저온 저장고의 내부 습도는 64퍼센트로 유지되었습니다.",
        evidenceIds: ["ev-1"],
        evidence: [deckSlide("ev-1", 3, 1)],
        facts: { numbers: [], units: [], dates: [], entities: [] },
      }),
    );
    if (outcome.outcome !== "ANSWERED") throw new Error(`expected ANSWERED, got ${outcome}`);
    expect(outcome.answer).toBe(
      "2월 현장 점검에서 저온 저장고의 내부 습도는 64퍼센트로 유지되었습니다.",
    );
    expect(outcome.citations.map((c) => c.evidenceId)).toEqual(["ev-1"]);
  });

  test("answers when exactly one number and one valid citation are declared", () => {
    const outcome = qaDefenseOutcome(
      recommend({
        evidenceIds: ["ev-1"],
        evidence: [deckSlide("ev-1", 3, 1)],
        facts: { numbers: ["42"], units: [], dates: [], entities: [] },
      }),
    );
    if (outcome.outcome !== "ANSWERED") throw new Error(`expected ANSWERED, got ${outcome}`);
    expect(outcome.citations.map((c) => c.evidenceId)).toEqual(["ev-1"]);
  });

  test("abstains on zero usable citations even when facts were declared", () => {
    const outcome = qaDefenseOutcome(
      recommend({
        evidenceIds: ["ev-x"],
        evidence: [{ ...deckSlide("ev-x", 9, 9), anchor: "page=4" }],
      }),
    );
    expect(outcome).toEqual({
      outcome: "ABSTAINED",
      reason: "INSUFFICIENT_EVIDENCE",
      retryable: false,
      completedAtMs: 1_800_000_000_000,
      latencyMs: 950,
    });
  });

  test("preserves abstain reason and marks transient codes retryable", () => {
    for (const code of ["MODEL_FAILURE", "BUDGET_EXCEEDED", "DEADLINE_EXCEEDED"] as const) {
      expect(qaDefenseOutcome(abstain(code))).toEqual({
        outcome: "ABSTAINED",
        reason: code,
        retryable: true,
        completedAtMs: 1_800_000_000_123,
        latencyMs: 4_400,
      });
    }
  });

  test("marks terminal codes non-retryable", () => {
    for (const code of [
      "INVALID_REQUEST",
      "POLICY_UNAVAILABLE",
      "STALE_AUTHORIZATION_METADATA",
      "UNAUTHORIZED",
      "STALE_DECK",
      "STALE_SOURCE",
      "FETCH_REJECTED",
      "FETCH_LIMIT_EXCEEDED",
      "INSUFFICIENT_EVIDENCE",
      "CONFLICTING_EVIDENCE",
      "DETERMINISTIC_MISMATCH",
    ] as const) {
      const result = qaDefenseOutcome(abstain(code));
      if (result.outcome !== "ABSTAINED") throw new Error(`expected ABSTAINED, got ${result}`);
      expect(result.reason).toBe(code);
      expect(result.retryable).toBe(false);
    }
  });

  test("the retryable set is exactly the three transient codes", () => {
    expect([...RETRYABLE_RETRIEVAL_FAILURE_CODES].sort()).toEqual([
      "BUDGET_EXCEEDED",
      "DEADLINE_EXCEEDED",
      "MODEL_FAILURE",
    ]);
    for (const code of RetrievalFailureCodeSchema.options) {
      expect(isRetryableRetrievalFailureCode(code)).toBe(
        RETRYABLE_RETRIEVAL_FAILURE_CODES.has(code),
      );
    }
  });
});
