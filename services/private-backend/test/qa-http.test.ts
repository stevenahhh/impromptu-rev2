import { describe, expect, test } from "bun:test";
import type { ActorId } from "@impromptu/contracts/control";
import {
  type AccountId,
  type PresentationSessionLifecycle,
  PresentationSessionLifecycleSchema,
} from "@impromptu/contracts/private";
import { DeckVersionIdSchema } from "@impromptu/contracts/public";
import type {
  RecommendationOutcome,
  RetrievalFailureCode,
  RetrievedEvidence,
} from "@impromptu/contracts/retrieval";
import { createQaDefense } from "../src/bootstrap/qa-defense.ts";
import { type PrivateBackendConfig, parsePrivateBackendConfig } from "../src/config.ts";
import type { AuthedRouteContext } from "../src/http/route-context.ts";
import type { QaDefenseRouteDependencies } from "../src/http/routes/qa-defense.ts";
import {
  qaDefenseRoutes,
  toLedgerQaCitation,
  toLedgerQaDefense,
} from "../src/http/routes/qa-defense.ts";
import { accountCookieName, csrfToken } from "../src/http/session-cookies.ts";
import { createPrivateBackendHandler } from "../src/http.ts";
import {
  createPreparedEvidenceStore,
  PreparedEvidenceCoordinator,
} from "../src/prepared-evidence.ts";
import type {
  QaExchangeIngestInput,
  QaExchangeIngestReceipt,
} from "../src/qa/qa-exchange-ledger.ts";
import {
  parseQaCitation,
  parseQaDefensePayload,
  QaExchangeLedger,
} from "../src/qa/qa-exchange-ledger.ts";
import { SessionReportFinalizer } from "../src/report/session-report-finalizer.ts";
import { MemorySessionReportRepository } from "./support/memory-session-report-repository.ts";

/**
 * Direct invocation of the exported route function with injected fakes: the route is not yet
 * registered in handler.ts, so tests construct the exact call surface the follow-up
 * registration will use and assert HTTP semantics at that boundary.
 */

const config: PrivateBackendConfig = parsePrivateBackendConfig({
  CONSOLE_ORIGIN: "https://console.example.test",
});
const accountId = "account_owner1";
const manifestHash = "b".repeat(64);
const presentationSessionId = "ps_qadefense000001";
const foreignPresentationId = "ps_foreignses00001";
const unknownPresentationId = "ps_missingid000001";
const openedAtMs = 8_000;
const completedAt = 1_800_000_000_000;

function lifecycle(options?: {
  qaStartedAtMs?: number | null;
  status?: "ACTIVE" | "ENDED";
}): PresentationSessionLifecycle {
  return PresentationSessionLifecycleSchema.parse({
    presentationSessionId,
    presentationSessionEpoch: "pse_1",
    ownerAccountId: accountId,
    deckVersion: DeckVersionIdSchema.parse("deck_2026launch"),
    status: options?.status ?? "ACTIVE",
    createdAtMs: 1_000,
    endedAtMs: options?.status === "ENDED" ? 7_500 : null,
    qaStartedAtMs:
      options?.qaStartedAtMs === undefined
        ? options?.status === "ENDED"
          ? openedAtMs
          : null
        : options.qaStartedAtMs,
  });
}

function deckSlide(evidenceId: string): RetrievedEvidence {
  const content = `Revenue was 42 million USD on ${evidenceId}.`;
  return {
    evidenceId,
    sourceId: "source-1",
    sourceRevision: "rev-1",
    sourceHash: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
    deckVersion: DeckVersionIdSchema.parse("deck_2026launch"),
    manifestHash,
    title: "Slide 3",
    content,
    quote: content,
    anchor: "slide=3&chunk=1",
    canonicalUrl: null,
    sourceDate: null,
    rights: "APPROVED",
    containsPii: false,
    authorizationVersion: "auth-9",
  };
}

function recommend(): RecommendationOutcome {
  return {
    outcome: "RECOMMEND",
    recommendation: {
      // Facts must be HONEST: "42" is stated by the claim AND contained in the fixture
      // evidence's content, so this is a genuine grounded answer under the Q&A-layer policy
      // that downgrades fact-free recommendations to an abstention.
      claim: "Revenue was 42 million USD in 2025.",
      evidenceIds: ["ev-1"],
      facts: { numbers: ["42"], units: [], dates: [], entities: [] },
    },
    evidence: [deckSlide("ev-1")],
    completedAtMs: completedAt,
    latencyMs: 950,
  };
}

function abstain(reason: RetrievalFailureCode): RecommendationOutcome {
  return { outcome: "ABSTAIN", reason, completedAtMs: completedAt + 1, latencyMs: 4_400 };
}

interface Harness {
  readonly dependencies: QaDefenseRouteDependencies;
  readonly ingested: QaExchangeIngestInput[];
  beginQuestionsCalls: string[];
}

function harness(
  options: {
    readonly lifecycle?: PresentationSessionLifecycle;
    readonly beginQuestions?: (
      accountSessionId: string,
      presentationSessionId: string,
    ) => Promise<
      | { outcome: "APPLIED"; value: PresentationSessionLifecycle }
      | { outcome: "REJECTED"; reason: string }
    >;
    readonly recommend?: (
      accountSessionId: string,
      input: unknown,
    ) => Promise<RecommendationOutcome>;
    readonly omitRecommend?: boolean;
    readonly ingestReceipt?: QaExchangeIngestReceipt;
    /** When true the fake resolves every id as owned; overrides per-id routing. */
    readonly resolve?: (
      accountSessionId: string,
      presentationSessionId: string,
    ) => Promise<
      | { outcome: "RESOLVED"; lifecycle: PresentationSessionLifecycle; manifestHash: string }
      | { outcome: "NOT_FOUND" }
      | { outcome: "UNAUTHORIZED" }
    >;
  } = {},
): Harness {
  const sessionLifecycle = options.lifecycle ?? lifecycle();
  let hasOpenQa = sessionLifecycle.qaStartedAtMs !== null;
  const ingested: QaExchangeIngestInput[] = [];
  const beginQuestionsCalls: string[] = [];
  const dependencies: QaDefenseRouteDependencies = {
    // Mirrors PreparedEvidenceCoordinator.beginQuestions: first open stamps now(), repeats are
    // idempotent no-writes returning the original state.
    beginQuestions:
      options.beginQuestions ??
      (async (accountSessionId: string, requestedId: string) => {
        beginQuestionsCalls.push(`${accountSessionId}:${requestedId}`);
        if (!hasOpenQa) hasOpenQa = true;
        return {
          outcome: "APPLIED" as const,
          value: { ...sessionLifecycle, qaStartedAtMs: sessionLifecycle.qaStartedAtMs ?? 9_000 },
        };
      }),
    async resolveQaSession(_accountSessionId, requestedId) {
      return options.resolve === undefined
        ? requestedId === unknownPresentationId
          ? { outcome: "NOT_FOUND" }
          : requestedId === foreignPresentationId
            ? { outcome: "UNAUTHORIZED" }
            : { outcome: "RESOLVED", lifecycle: sessionLifecycle, manifestHash }
        : await options.resolve(_accountSessionId, requestedId);
    },
    ...(options.omitRecommend || options.recommend === undefined
      ? {}
      : { recommend: options.recommend }),
    async ingestExchange(input) {
      ingested.push(input);
      return (
        options.ingestReceipt ?? {
          outcome: "ACCEPTED",
          exchangeId: `qa-${ingested.length}`,
          duplicate: false,
        }
      );
    },
    now: () => 9_000,
  };
  return { dependencies, ingested, beginQuestionsCalls };
}

/** The harness recommends by default; tests needing a question need this non-omitted variant. */
function questionHarness(
  options: Parameters<typeof harness>[0] & {
    readonly recommendResult: (
      accountSessionId: string,
      input: unknown,
    ) => Promise<RecommendationOutcome>;
  },
): Harness {
  const { recommendResult, ...rest } = options;
  return harness({ ...rest, recommend: recommendResult });
}

function context(path: string, body?: unknown): AuthedRouteContext {
  return {
    request: new Request(`https://private.example.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }),
    url: new URL(`https://private.example.test${path}`),
    origin: new Headers({ origin: config.allowedOrigin }),
    config,
    // The route module receives its own dependency object; it never reads handler dependencies.
    dependencies: {} as never,
    accountSessionId: "account_session_test0",
    accountId: accountId as AccountId,
    actorId: "actor-1" as ActorId,
    sessionExpiresAtMs: 99_000,
  };
}

describe("qa defense open route", () => {
  test("returns exactly the four lifecycle fields the Console parser demands", async () => {
    const h = harness();
    const response = await qaDefenseRoutes(
      context(`/v1/presentation-sessions/${presentationSessionId}/qa-defense`, {
        presentationSessionId,
      }),
      h.dependencies,
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as { lifecycle?: Record<string, unknown> };
    expect(body.lifecycle).toEqual({
      presentationSessionId,
      presentationSessionEpoch: "pse_1",
      deckVersion: DeckVersionIdSchema.parse("deck_2026launch"),
      status: "ACTIVE",
    });
  });

  test("re-opening an already-open Q&A returns the original state and writes nothing more", async () => {
    const h = harness({ lifecycle: lifecycle({ qaStartedAtMs: openedAtMs }) });
    const path = `/v1/presentation-sessions/${presentationSessionId}/qa-defense`;
    const request = { presentationSessionId };
    const first = await qaDefenseRoutes(context(path, request), h.dependencies);
    const second = await qaDefenseRoutes(context(path, request), h.dependencies);
    expect(first?.status).toBe(200);
    expect(second?.status).toBe(200);
    expect(await second?.json()).toEqual(await first?.json());
    expect(h.beginQuestionsCalls).toEqual([
      `account_session_test0:${presentationSessionId}`,
      `account_session_test0:${presentationSessionId}`,
    ]);
  });

  test("coordinator rejections map to typed statuses, never a 500", async () => {
    for (const [reason, expectedStatus, expectedError] of [
      ["PRESENTATION_NOT_FOUND", 404, "presentation_not_found"],
      ["UNAUTHORIZED", 403, "unauthorized"],
      // The inverted rule: a talk still in progress is not openable yet — its own reason.
      ["PRESENTATION_NOT_ENDED", 409, "presentation_not_ended"],
      ["PRESENTATION_ENDED", 409, "presentation_ended"],
    ] as const) {
      const h = harness({ beginQuestions: async () => ({ outcome: "REJECTED", reason }) });
      const response = await qaDefenseRoutes(
        context(`/v1/presentation-sessions/${unknownPresentationId}/qa-defense`, {
          presentationSessionId: unknownPresentationId,
        }),
        h.dependencies,
      );
      expect(response?.status).toBe(expectedStatus);
      expect(await response?.json()).toEqual({ error: expectedError });
    }
  });

  test("asks before Q&A was opened answer exactly 409 qa_not_open", async () => {
    const h = questionHarness({ recommendResult: async () => recommend() });
    const response = await qaDefenseRoutes(
      context("/v1/qa-defense", {
        presentationSessionId,
        questionText: "What was revenue?",
        origin: "TYPED",
      }),
      h.dependencies,
    );
    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({ error: "qa_not_open" });
  });

  test("asking on an ENDED talk whose Q&A was never opened stays exactly 409 qa_not_open", async () => {
    // Ending without opening must NOT surface as presentation_ended: the Console keys its
    // typed QaDefenseNotOpenError to the exact qa_not_open body so it can prompt the
    // presenter to open Q&A first.
    const h = questionHarness({
      lifecycle: lifecycle({ status: "ENDED", qaStartedAtMs: null }),
      recommendResult: async () => recommend(),
    });
    const response = await qaDefenseRoutes(
      context("/v1/qa-defense", {
        presentationSessionId,
        questionText: "What was revenue?",
        origin: "TYPED",
      }),
      h.dependencies,
    );
    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({ error: "qa_not_open" });
  });

  test("malformed bodies answer 400, not 500", async () => {
    for (const body of [
      { presentationSessionId, origin: "TYPED" },
      { presentationSessionId, questionText: "   ", origin: "TYPED" },
      { presentationSessionId, questionText: "What?", origin: "WRITTEN" },
      { questionText: "What?", origin: "TYPED" },
    ]) {
      const h = questionHarness({
        lifecycle: lifecycle({ qaStartedAtMs: openedAtMs }),
        recommendResult: async () => recommend(),
      });
      const response = await qaDefenseRoutes(context("/v1/qa-defense", body), h.dependencies);
      expect(response?.status).toBe(400);
      expect(h.ingested).toHaveLength(0);
    }
  });

  test("unknown presentation id and a non-owner each return typed 4xx, not 500", async () => {
    const body = {
      presentationSessionId: unknownPresentationId,
      questionText: "Why?",
      origin: "SPOKEN",
    };
    const missing = questionHarness({
      lifecycle: lifecycle({ qaStartedAtMs: openedAtMs }),
      resolve: async (_accountId, id) =>
        id === unknownPresentationId
          ? { outcome: "NOT_FOUND" }
          : {
              outcome: "RESOLVED",
              lifecycle: lifecycle({ qaStartedAtMs: openedAtMs }),
              manifestHash,
            },
      recommendResult: async () => recommend(),
    });
    const missingResponse = await qaDefenseRoutes(
      context("/v1/qa-defense", body),
      missing.dependencies,
    );
    expect(missingResponse?.status).toBe(404);

    const foreignBody = {
      presentationSessionId: foreignPresentationId,
      questionText: "Why?",
      origin: "TYPED",
    };
    const foreignHarnessInstance = questionHarness({
      lifecycle: lifecycle({ qaStartedAtMs: openedAtMs }),
      resolve: async () => ({ outcome: "UNAUTHORIZED" }),
      recommendResult: async () => recommend(),
    });
    const foreignResponse = await qaDefenseRoutes(
      context("/v1/qa-defense", foreignBody),
      foreignHarnessInstance.dependencies,
    );
    expect(foreignResponse?.status).toBe(403);
  });

  test("a grounded result becomes ANSWERED with citations and lands in the ledger", async () => {
    const h = questionHarness({
      lifecycle: lifecycle({ qaStartedAtMs: openedAtMs }),
      recommendResult: async () => recommend(),
    });
    const response = await qaDefenseRoutes(
      context("/v1/qa-defense", {
        presentationSessionId,
        questionText: "What was revenue?",
        origin: "TYPED",
      }),
      h.dependencies,
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as Record<string, unknown>;
    expect(body.outcome).toBe("ANSWERED");
    expect(body.answer).toBe("Revenue was 42 million USD in 2025.");
    const citations = body.citations as unknown[];
    expect(citations.length).toBeGreaterThanOrEqual(1);
    expect(citations.length).toBeLessThanOrEqual(3);
    expect(citations[0]).toMatchObject({ kind: "DECK_SLIDE", slideOrdinal: 3 });
    expect(h.ingested).toHaveLength(1);
    expect(h.ingested[0]?.question).toBe("What was revenue?");
    expect(h.ingested[0]?.origin).toBe("TYPED");
    expect(h.ingested[0]?.defense.outcome).toBe("ANSWERED");
  });

  test("an abstention keeps reason and retryable verbatim, carries no answer text, and still commits", async () => {
    const h = questionHarness({
      lifecycle: lifecycle({ qaStartedAtMs: openedAtMs }),
      recommendResult: async () => abstain("INSUFFICIENT_EVIDENCE"),
    });
    const response = await qaDefenseRoutes(
      context("/v1/qa-defense", {
        presentationSessionId,
        questionText: "Why is the sky blue?",
        origin: "SPOKEN",
      }),
      h.dependencies,
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as Record<string, unknown>;
    expect(body.outcome).toBe("ABSTAINED");
    expect(body.reason).toBe("INSUFFICIENT_EVIDENCE");
    expect(body.retryable).toBe(false);
    expect(body.answer).toBeUndefined();
    expect(body.citations).toBeUndefined();
    expect(h.ingested).toHaveLength(1);
    expect(h.ingested[0]?.defense.outcome).toBe("ABSTAINED");
  });

  test("a RECOMMEND declaring NO checkable facts surfaces as the abstention, never an answer card", async () => {
    // Q&A-layer policy pinned at the route: a fact-free recommendation (numbers, units, dates
    // and entities all empty) cannot defend anything checkable, so even with a valid citation
    // the browser must see ABSTAINED / INSUFFICIENT_EVIDENCE / non-retryable.
    const h = questionHarness({
      lifecycle: lifecycle({ qaStartedAtMs: openedAtMs }),
      recommendResult: async () => ({
        outcome: "RECOMMEND",
        recommendation: {
          // Genuinely fact-free under extractFacts: no number, unit, date or entity
          // candidate (the previous English fixture yielded entities: ["our"] because a
          // leading capitalised word is an entity candidate).
          claim: "제공된 증거에는 이 시제품의 개발 비용에 대한 정보가 없습니다.",
          evidenceIds: ["ev-1"],
          facts: { numbers: [], units: [], dates: [], entities: [] },
        },
        evidence: [deckSlide("ev-1")],
        completedAtMs: completedAt,
        latencyMs: 950,
      }),
    });
    const response = await qaDefenseRoutes(
      context("/v1/qa-defense", {
        presentationSessionId,
        questionText: "How is the strategy landing?",
        origin: "TYPED",
      }),
      h.dependencies,
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as Record<string, unknown>;
    expect(body.outcome).toBe("ABSTAINED");
    expect(body.reason).toBe("INSUFFICIENT_EVIDENCE");
    expect(body.retryable).toBe(false);
    expect(body.answer).toBeUndefined();
    expect(body.citations).toBeUndefined();
    // Still committed: an honest abstention is part of the session's story too.
    expect(h.ingested).toHaveLength(1);
    expect(h.ingested[0]?.defense.outcome).toBe("ABSTAINED");
  });

  test("a RECOMMEND whose claim TEXT states a checkable fact surfaces as ANSWERED with its citation even when declared facts are empty", async () => {
    // Opposite-direction pin at the route (where the browser actually reads it): empty
    // DECLARED fact sets must not discard an answer whose claim TEXT carries a checkable
    // fact. "64퍼센트" appears verbatim in the cited slide's content, so the union the
    // vacuity policy reads is non-empty and the grounded answer ships with its citation.
    const slideContent = "2월 현장 점검 기록: 저온 저장고의 내부 습도는 64퍼센트로 유지되었습니다.";
    const evidence = {
      ...deckSlide("ev-1"),
      content: slideContent,
      quote: slideContent,
      sourceHash: new Bun.CryptoHasher("sha256").update(slideContent).digest("hex"),
    };
    const h = questionHarness({
      lifecycle: lifecycle({ qaStartedAtMs: openedAtMs }),
      recommendResult: async () => ({
        outcome: "RECOMMEND",
        recommendation: {
          claim: "2월 현장 점검에서 저온 저장고의 내부 습도는 64퍼센트로 유지되었습니다.",
          evidenceIds: ["ev-1"],
          facts: { numbers: [], units: [], dates: [], entities: [] },
        },
        evidence: [evidence],
        completedAtMs: completedAt,
        latencyMs: 950,
      }),
    });
    const response = await qaDefenseRoutes(
      context("/v1/qa-defense", {
        presentationSessionId,
        questionText: "저장고 습도는 어떻게 유지되었나요?",
        origin: "TYPED",
      }),
      h.dependencies,
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as Record<string, unknown>;
    expect(body.outcome).toBe("ANSWERED");
    expect(body.answer).toBe(
      "2월 현장 점검에서 저온 저장고의 내부 습도는 64퍼센트로 유지되었습니다.",
    );
    const citations = body.citations as unknown[];
    expect(citations.length).toBeGreaterThanOrEqual(1);
    expect(citations[0]).toMatchObject({ kind: "DECK_SLIDE", slideOrdinal: 3 });
    expect(h.ingested).toHaveLength(1);
    expect(h.ingested[0]?.defense.outcome).toBe("ANSWERED");
  });

  test("a failed durable write returns a typed failure, never success and never a bare 500", async () => {
    // When the exchange cannot be durably recorded the answer MUST NOT reach the presenter as
    // success: a 200 here would put an unrecorded answer in front of an audience.
    const h = questionHarness({
      lifecycle: lifecycle({ qaStartedAtMs: openedAtMs }),
      recommendResult: async () => recommend(),
    });
    const ingested: QaExchangeIngestInput[] = [];
    const brokenIngest = {
      ...h.dependencies,
      async ingestExchange(input: QaExchangeIngestInput) {
        ingested.push(input);
        throw new Error("exchange store unavailable");
      },
    };
    const response = await qaDefenseRoutes(
      context("/v1/qa-defense", {
        presentationSessionId,
        questionText: "What was revenue?",
        origin: "TYPED",
      }),
      brokenIngest,
    );
    if (response === null) throw new Error("qa-defense route did not match");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "qa_exchange_not_recorded" });
    expect(ingested).toHaveLength(1);
  });

  test("without the exchange seam the question is refused 503, never answered unrecorded", async () => {
    const h = questionHarness({
      lifecycle: lifecycle({ qaStartedAtMs: openedAtMs }),
      recommendResult: async () => recommend(),
    });
    const { ingestExchange: _omit, ...noLedger } = h.dependencies;
    const response = await qaDefenseRoutes(
      context("/v1/qa-defense", {
        presentationSessionId,
        questionText: "What was revenue?",
        origin: "TYPED",
      }),
      noLedger,
    );
    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({ error: "qa_defense_unavailable" });
    expect(h.ingested).toHaveLength(0);
  });

  test("with recommendations absent the question route answers the typed 503", async () => {
    const h = harness({
      lifecycle: lifecycle({ qaStartedAtMs: openedAtMs }),
      omitRecommend: true,
    });
    const response = await qaDefenseRoutes(
      context("/v1/qa-defense", {
        presentationSessionId,
        questionText: "What was revenue?",
        origin: "TYPED",
      }),
      h.dependencies,
    );
    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({ error: "qa_defense_unavailable" });
    expect(h.ingested).toHaveLength(0);
  });
});

describe("wire-to-ledger citation seam", () => {
  const fullWire = {
    kind: "DECK_SLIDE",
    evidenceId: "ev-1",
    slideOrdinal: 3,
    title: "Slide 3",
    quote: "Revenue was 42 million USD.",
  } as const;

  test("DECK_SLIDE maps forward to exactly { kind, slideOrdinal }, dropping receipt-only fields", () => {
    expect(toLedgerQaCitation(fullWire)).toEqual({ kind: "DECK_SLIDE", slideOrdinal: 3 });
  });

  test("every consumed wire field is read: renaming one persists undefined instead of a value", () => {
    for (const consumed of ["kind", "slideOrdinal"] as const) {
      const renamed = { ...fullWire, [consumed]: undefined };
      expect(toLedgerQaCitation(renamed as unknown as typeof fullWire)).not.toEqual({
        kind: "DECK_SLIDE",
        slideOrdinal: 3,
      });
    }
    // Deliberately-dropped fields must stay absent from the persisted summary.
    const mapped = toLedgerQaCitation(fullWire) as Record<string, unknown>;
    expect(Object.keys(mapped).sort()).toEqual(["kind", "slideOrdinal"]);
  });

  test("REFERENCE_DOCUMENT and EXTERNAL_SOURCE map forward with every carried field", () => {
    expect(
      toLedgerQaCitation({
        kind: "REFERENCE_DOCUMENT",
        evidenceId: "ev-9",
        documentTitle: "Industry Report 2026",
        chunkOrdinal: 4,
        quote: "quoted text",
      }),
    ).toEqual({
      kind: "REFERENCE_DOCUMENT",
      documentTitle: "Industry Report 2026",
      chunkOrdinal: 4,
    });
    expect(
      toLedgerQaCitation({
        kind: "EXTERNAL_SOURCE",
        evidenceId: "ev-7",
        title: "News",
        url: "https://example.test/news",
        quote: "quoted text",
      }),
    ).toEqual({ kind: "EXTERNAL_SOURCE", url: "https://example.test/news" });
  });

  test("reverse direction: each mapped citation re-validates through the ledger's own closed parser", () => {
    const mappedDeckSlide = parseQaCitation(toLedgerQaCitation(fullWire));
    expect(mappedDeckSlide).toEqual({ kind: "DECK_SLIDE", slideOrdinal: 3 });
    expect(
      parseQaCitation(
        toLedgerQaCitation({
          kind: "REFERENCE_DOCUMENT",
          evidenceId: "e",
          documentTitle: "Report",
          chunkOrdinal: 1,
          quote: "q",
        }),
      ),
    ).toEqual({ kind: "REFERENCE_DOCUMENT", documentTitle: "Report", chunkOrdinal: 1 });
    expect(
      parseQaCitation(
        toLedgerQaCitation({
          kind: "EXTERNAL_SOURCE",
          evidenceId: "e",
          title: "t",
          url: "https://example.test/x",
          quote: "q",
        }),
      ),
    ).toEqual({ kind: "EXTERNAL_SOURCE", url: "https://example.test/x" });
  });

  test("defense payload maps answer->answerText and reason->abstainReason, both directions pinned", () => {
    const answered = toLedgerQaDefense({
      outcome: "ANSWERED",
      answer: "Because of X.",
      citations: [{ ...fullWire }],
      completedAtMs: completedAt,
      latencyMs: 10,
    });
    expect(answered).toEqual({
      outcome: "ANSWERED",
      answerText: "Because of X.",
      citations: [{ kind: "DECK_SLIDE", slideOrdinal: 3 }],
    });
    expect(parseQaDefensePayload(answered)).toEqual(answered);
    const abstained = toLedgerQaDefense({
      outcome: "ABSTAINED",
      reason: "INSUFFICIENT_EVIDENCE",
      retryable: false,
      completedAtMs: completedAt,
      latencyMs: 10,
    });
    expect(abstained).toEqual({
      outcome: "ABSTAINED",
      abstainReason: "INSUFFICIENT_EVIDENCE",
      retryable: false,
    });
    expect(parseQaDefensePayload(abstained)).toEqual(abstained);
  });
});

// ---------------------------------------------------------------------------
// Registered-handler boundary. These tests construct the REAL createPrivateBackendHandler
// dispatch path a browser takes (origin guard -> session cookie -> CSRF -> qaDefenseRoutes)
// against the real coordinator and the real bootstrap wiring; only the projection gateway
// and the recommendation pipeline are stubbed.
// ---------------------------------------------------------------------------
describe("registered Q&A routes through createPrivateBackendHandler", () => {
  const internalAuthToken = "private-qa-http-test-token";
  const privateQaDeck = {
    deckId: "private_deck_qa",
    deckVersion: "deck_qa_e2e",
    manifestHash,
    title: "QA deck",
    ownerAccountId: accountId,
    aclPolicyVersion: "acl-1",
    privateObjectPrefix: `private-decks/${accountId}/deck-qa`,
    slides: [
      {
        privateSlideId: "private_slide_one",
        publicSlideKey: "slide_one",
        ordinal: 1,
        speakerNotes: "private note",
        extractedText: "Slide one",
        sourceAssetIds: ["asset_one"],
      },
    ],
  } as const;
  const publicQaDeck = {
    deckVersion: "deck_qa_e2e",
    manifestHash,
    title: "QA deck",
    slides: [
      {
        publicSlideKey: "slide_one",
        ordinal: 1,
        image: {
          url: "https://public.example.test/one.png",
          contentHash: "c".repeat(64),
          width: 1920,
          height: 1080,
        },
        accessibilityLabel: "Slide one",
      },
    ],
  } as const;

  interface RegisteredHarness {
    readonly handler: (request: Request) => Response | Promise<Response>;
    readonly coordinator: PreparedEvidenceCoordinator;
    readonly clock: { value: number };
    /** Present when wired with the real report lane (finalizer + durable exchange record). */
    readonly report?: {
      readonly repository: MemorySessionReportRepository;
      readonly finalizer: SessionReportFinalizer;
    };
  }

  function registeredHandler(options?: {
    readonly omitQaDefense?: boolean;
    readonly realReportLane?: boolean;
  }): RegisteredHarness {
    const clock = { value: 1_000 };
    const store = createPreparedEvidenceStore();
    const coordinator = new PreparedEvidenceCoordinator(
      {
        bindDisplay: () => ({ outcome: "REJECTED", reason: "unused" }),
        projectPlayback: () => false,
        recordPlaybackApplied: () => false,
        issueDisplayInvitation: () => ({ outcome: "REJECTED", reason: "unused" }),
        readDisplayInvitation: () => ({ outcome: "REJECTED", reason: "unused" }),
      },
      store,
    );
    let report: RegisteredHarness["report"];
    let qaExchanges: QaExchangeLedger | undefined;
    if (options?.realReportLane === true) {
      const repository = new MemorySessionReportRepository();
      const finalizer = new SessionReportFinalizer(repository);
      report = { repository, finalizer };
      qaExchanges = new QaExchangeLedger(finalizer);
    }
    const dependencies = {
      coordinator,
      identityVerifier: {
        async verifyCredentials(): Promise<{ accountId: string; actorId: string } | null> {
          return null;
        },
      },
      internalAuthToken,
      now: () => clock.value,
      recommendations: { recommend: async () => recommend() },
      ...(options?.omitQaDefense
        ? {}
        : {
            qaDefense: createQaDefense({
              store,
              coordinator,
              recommendations: { recommend: async () => recommend() },
              qaExchanges:
                qaExchanges ??
                new QaExchangeLedger({
                  async recordQaExchange(_principal, exchange) {
                    return { outcome: "APPENDED", exchange };
                  },
                }),
              now: () => clock.value,
            }),
          }),
    };
    return {
      handler: createPrivateBackendHandler(config, dependencies),
      coordinator,
      clock,
      ...(report === undefined ? {} : { report }),
    };
  }

  async function ownedSession(
    harness: RegisteredHarness,
  ): Promise<{ readonly accountSessionId: string; readonly presentationId: string }> {
    const session = await harness.coordinator.createAccountSession(
      { accountId: accountId, actorId: "actor_qa_owner" },
      harness.clock.value,
    );
    const created = await harness.coordinator.createPresentation(
      session.accountSessionId,
      {
        privateDeck: privateQaDeck,
        publicDeck: publicQaDeck,
      },
      harness.clock.value,
    );
    if (created.outcome !== "APPLIED") throw new Error("fixture failed to create presentation");
    return {
      accountSessionId: session.accountSessionId,
      presentationId: created.value.lifecycle.presentationSessionId,
    };
  }

  function authedHeaders(accountSessionId: string): HeadersInit {
    return {
      Origin: config.allowedOrigin,
      Referer: `${config.allowedOrigin}/report`,
      "content-type": "application/json",
      Cookie: `${accountCookieName(config.allowedOrigin)}=${accountSessionId}`,
      "x-csrf-token": csrfToken(internalAuthToken, accountSessionId),
    };
  }

  test("end-to-end reproduction: end the talk, open Q&A, ask — all succeed through the browser path", async () => {
    const h = registeredHandler();
    const { accountSessionId, presentationId } = await ownedSession(h);
    expect(
      await h.coordinator.endPresentation(accountSessionId, presentationId, 2_000),
    ).toMatchObject({ outcome: "APPLIED" });

    const openResponse = await h.handler(
      new Request(`http://service.test/v1/presentation-sessions/${presentationId}/qa-defense`, {
        method: "POST",
        headers: authedHeaders(accountSessionId),
        body: JSON.stringify({ presentationSessionId: presentationId }),
      }),
    );
    expect(openResponse.status).toBe(200);
    const body = (await openResponse.json()) as {
      lifecycle?: Record<string, unknown>;
    };
    // Exactly what the Console's qaLifecycle parser demands, with status now ENDED.
    expect(body.lifecycle).toEqual({
      presentationSessionId: presentationId,
      presentationSessionEpoch: "pse_1",
      deckVersion: DeckVersionIdSchema.parse("deck_qa_e2e"),
      status: "ENDED",
    });

    h.clock.value = 9_000;
    const askResponse = await h.handler(
      new Request("http://service.test/v1/qa-defense", {
        method: "POST",
        headers: authedHeaders(accountSessionId),
        body: JSON.stringify({
          presentationSessionId: presentationId,
          questionText: "What was revenue?",
          origin: "TYPED",
        }),
      }),
    );
    expect(askResponse.status).toBe(200);
    expect((await askResponse.json()) as Record<string, unknown>).toMatchObject({
      outcome: "ANSWERED",
    });
  });

  test("end-to-end reproduction: ending the talk finalizes the report, yet Q&A opens and every ask is answered AND recorded (no 409)", async () => {
    const h = registeredHandler({ realReportLane: true });
    if (h.report === undefined) throw new Error("real report lane missing");
    const { accountSessionId, presentationId } = await ownedSession(h);
    // The presenter ends the talk; the end flow finalizes the session report synchronously.
    await h.coordinator.endPresentation(accountSessionId, presentationId, 2_000);
    const principal = {
      tenantId: accountId,
      presentationSessionId: presentationId,
      ownerSubject: accountId,
    };
    const accepted = await h.report.finalizer.endSession({
      principal,
      endedOffsetMs: 3_000,
      finalizedAtMs: h.clock.value * 2,
      preparedEvidence: { label: "준비된 근거", items: [] },
    });
    expect((await accepted.finalization).outcome).toBe("FINALIZED");

    const openResponse = await h.handler(
      new Request(`http://service.test/v1/presentation-sessions/${presentationId}/qa-defense`, {
        method: "POST",
        headers: authedHeaders(accountSessionId),
        body: JSON.stringify({ presentationSessionId: presentationId }),
      }),
    );
    expect(openResponse.status).toBe(200);
    expect(((await openResponse.json()) as Record<string, unknown>).lifecycle).toMatchObject({
      status: "ENDED",
    });

    h.clock.value = 9_000;
    // This exact request answered 409 {"error":"report_finalized"} three times in the live
    // browser harness while the feature was structurally dead.
    const askResponse = await h.handler(
      new Request("http://service.test/v1/qa-defense", {
        method: "POST",
        headers: authedHeaders(accountSessionId),
        body: JSON.stringify({
          presentationSessionId: presentationId,
          questionText: "What was revenue?",
          origin: "TYPED",
        }),
      }),
    );
    expect(askResponse.status).not.toBe(409);
    expect((await askResponse.json()) as Record<string, unknown>).toMatchObject({
      outcome: "ANSWERED",
    });
    // Recorded, not fabricated: the exchange is durably in the log with its mapped defense.
    expect(h.report.repository.exchanges.map((exchange) => exchange.question)).toEqual([
      "What was revenue?",
    ]);
    expect(h.report.repository.exchanges[0]?.defense.outcome).toBe("ANSWERED");
  });

  test("audit closure through the browser path: N successful asks persist exactly N exchanges", async () => {
    const h = registeredHandler({ realReportLane: true });
    if (h.report === undefined) throw new Error("real report lane missing");
    const { accountSessionId, presentationId } = await ownedSession(h);
    await h.coordinator.endPresentation(accountSessionId, presentationId, 2_000);
    const openResponse = await h.handler(
      new Request(`http://service.test/v1/presentation-sessions/${presentationId}/qa-defense`, {
        method: "POST",
        headers: authedHeaders(accountSessionId),
        body: JSON.stringify({ presentationSessionId: presentationId }),
      }),
    );
    expect(openResponse.status).toBe(200);

    h.clock.value = 9_000;
    const statuses: number[] = [];
    for (let ask = 0; ask < 5; ++ask) {
      const askResponse = await h.handler(
        new Request("http://service.test/v1/qa-defense", {
          method: "POST",
          headers: authedHeaders(accountSessionId),
          // The SAME question every time: an immediate genuine re-ask, exactly what a
          // presenter does when they want to hear the answer again.
          body: JSON.stringify({
            presentationSessionId: presentationId,
            questionText: "What was revenue?",
            origin: "TYPED",
          }),
        }),
      );
      statuses.push(askResponse.status);
    }
    expect(statuses.every((status) => status === 200)).toBe(true);
    // THE AUDIT RULE: every answer returned to the presenter exists durably in the ledger.
    expect(statuses.length).toBe(h.report.repository.exchanges.length);
    expect(new Set(h.report.repository.exchanges.map((e) => e.exchangeId)).size).toBe(
      statuses.length,
    );
  });

  test("asking the SAME question twice lands TWO distinct exchanges in ask order", async () => {
    const h = registeredHandler({ realReportLane: true });
    if (h.report === undefined) throw new Error("real report lane missing");
    const { accountSessionId, presentationId } = await ownedSession(h);
    await h.coordinator.endPresentation(accountSessionId, presentationId, 2_000);
    await h.handler(
      new Request(`http://service.test/v1/presentation-sessions/${presentationId}/qa-defense`, {
        method: "POST",
        headers: authedHeaders(accountSessionId),
        body: JSON.stringify({ presentationSessionId: presentationId }),
      }),
    );

    h.clock.value = 9_000;
    for (const askedAtMs of [9_000, 9_500]) {
      h.clock.value = askedAtMs;
      const askResponse = await h.handler(
        new Request("http://service.test/v1/qa-defense", {
          method: "POST",
          headers: authedHeaders(accountSessionId),
          body: JSON.stringify({
            presentationSessionId: presentationId,
            questionText: "What was revenue?",
            origin: "TYPED",
          }),
        }),
      );
      expect(askResponse.status).toBe(200);
    }
    expect(h.report.repository.exchanges.map((exchange) => exchange.askedAtMs)).toEqual([
      9_000, 9_500,
    ]);
    expect(new Set(h.report.repository.exchanges.map((exchange) => exchange.exchangeId)).size).toBe(
      2,
    );
  });

  test("opening Q&A while the talk is still ACTIVE answers 409 presentation_not_ended, never success or 500", async () => {
    const h = registeredHandler();
    // Deliberately NOT ending the talk first: Q&A must stay closed while it is ACTIVE.
    const { accountSessionId, presentationId } = await ownedSession(h);
    const openResponse = await h.handler(
      new Request(`http://service.test/v1/presentation-sessions/${presentationId}/qa-defense`, {
        method: "POST",
        headers: authedHeaders(accountSessionId),
        body: JSON.stringify({ presentationSessionId }),
      }),
    );
    expect(openResponse.status).toBe(409);
    expect(await openResponse.json()).toEqual({ error: "presentation_not_ended" });
  });

  test("the same handler without qaDefense injected degrades to the typed 503 on both routes", async () => {
    const h = registeredHandler({ omitQaDefense: true });
    const sessionId = (
      await h.coordinator.createAccountSession(
        { accountId: accountId, actorId: "actor_qa_owner" },
        h.clock.value,
      )
    ).accountSessionId;
    const headers = authedHeaders(sessionId);
    const openResponse = await h.handler(
      new Request("http://service.test/v1/presentation-sessions/ps_anyid000001/qa-defense", {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      }),
    );
    expect(openResponse.status).toBe(503);
    expect(await openResponse.json()).toEqual({ error: "qa_defense_unavailable" });
    const askResponse = await h.handler(
      new Request("http://service.test/v1/qa-defense", {
        method: "POST",
        headers,
        body: JSON.stringify({
          presentationSessionId: "ps_anyid000001",
          questionText: "Why?",
          origin: "TYPED",
        }),
      }),
    );
    expect(askResponse.status).toBe(503);
    expect(await askResponse.json()).toEqual({ error: "qa_defense_unavailable" });
  });
});

// -------------------------------------------------------------------------
// GENUINE RE-ASK RULE. A repeated identical question is a genuine second ask: it gets its
// own exchange id and is recorded as a distinct durable exchange. The retired 30-second
// time-bucket heuristic is forbidden; byte-equal retry deduplication may only ever come from
// an explicit caller-supplied idempotency key (none exists yet) — never a wall-clock window.
// -------------------------------------------------------------------------
describe("genuine re-ask rule", () => {
  // Emulates the durable store's idempotency contract exactly: DUPLICATE only when a
  // byte-equal row truly exists; a reused id with different content is a typed conflict.
  function storeSemanticsHarness(): {
    readonly dependencies: QaDefenseRouteDependencies;
    readonly appended: QaExchangeIngestInput[];
  } {
    const appended: QaExchangeIngestInput[] = [];
    const stored = new Map<string, string>();
    let sequence = 0;
    const dependencies: QaDefenseRouteDependencies = {
      beginQuestions: async () => ({ outcome: "APPLIED", value: lifecycle() }),
      resolveQaSession: async () => ({
        outcome: "RESOLVED",
        lifecycle: lifecycle({ qaStartedAtMs: openedAtMs }),
        manifestHash,
      }),
      recommend: async (_accountSessionId, _input) => recommend(),
      async ingestExchange(input) {
        const exchangeId = input.exchangeId ?? `qa-gen-${++sequence}`;
        const content = JSON.stringify([
          input.askedAtMs,
          input.question,
          input.origin,
          input.defense,
        ]);
        const existing = stored.get(exchangeId);
        if (existing !== undefined) {
          if (existing !== content) throw new Error("qa exchange id reused with different content");
          return { outcome: "ACCEPTED", exchangeId, duplicate: true };
        }
        stored.set(exchangeId, content);
        appended.push({ ...input, exchangeId });
        return { outcome: "ACCEPTED", exchangeId, duplicate: false };
      },
      now: () => 9_000,
    };
    return { dependencies, appended };
  }

  function askBody(questionText = "What was revenue?"): Record<string, unknown> {
    return { presentationSessionId, questionText, origin: "TYPED" };
  }

  test("the SAME question asked twice in immediate succession returns 200 both times, NEVER 500", async () => {
    const { dependencies } = storeSemanticsHarness();
    const first = await qaDefenseRoutes(context("/v1/qa-defense", askBody()), dependencies);
    const second = await qaDefenseRoutes(context("/v1/qa-defense", askBody()), dependencies);
    if (first === null || second === null) throw new Error("qa-defense route did not match");
    expect(first.status).toBe(200);
    expect(second.status).not.toBe(500);
    expect(second.status).toBe(200);
  });

  test("repeated identical asks produce distinct exchange ids and two distinct ledger appends", async () => {
    // The model's answer differs per run in reality; the harness varies it so the second ask
    // cannot pass by byte-equality — only a genuinely fresh id can make both land.
    const { dependencies, appended } = storeSemanticsHarness();
    for (const run of [1, 2]) {
      await qaDefenseRoutes(context("/v1/qa-defense", askBody()), dependencies);
      void run;
    }
    expect(appended).toHaveLength(2);
    expect(appended[0]?.exchangeId).not.toBe(appended[1]?.exchangeId);
    expect(new Set(appended.map((exchange) => exchange.exchangeId)).size).toBe(2);
  });
});
