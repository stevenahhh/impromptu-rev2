import {
  type PresentationSessionLifecycle,
  type QaCitation,
  type QaDefenseOutcome,
  QaDefenseOutcomeSchema,
  QaDefenseRequestSchema,
} from "@impromptu/contracts/private";
import type { RecommendationOutcome } from "@impromptu/contracts/retrieval";
import type { OperationResult } from "../../prepared-evidence.ts";
import { qaDefenseOutcome } from "../../qa/qa-defense-outcomes.ts";
import type {
  QaCitation as LedgerQaCitation,
  QaDefenseOutcome as LedgerQaDefenseOutcome,
  QaExchangeIngestInput,
  QaExchangeIngestReceipt,
} from "../../qa/qa-exchange-ledger.ts";
import { requestBody } from "../request-bodies.ts";
import { json } from "../responses.ts";
import type { AuthedRouteContext } from "../route-context.ts";

/**
 * Private Q&A-defense routes (S5): opens a post-talk question window for one presentation
 * session and answers an audience question grounded in the presenter's deck and uploaded
 * reference documents.
 *
 * DI shape: registered in handler.ts's authenticated section (cookie + CSRF already enforced
 * upstream) before the coordinator-command fallthrough. The dependency object is an explicit
 * second argument; `undefined` answers a typed 503 exactly like `/v1/recommendations` does
 * when its capability is absent. Auth is enforced by handler.ts upstream (account-session
 * cookie + CSRF); this module never broadens identity inputs.
 */

export interface QaDefenseRouteDependencies {
  /** Delegates to PreparedEvidenceCoordinator.beginQuestions with the composed clock. */
  readonly beginQuestions: (
    accountSessionId: string,
    presentationSessionId: string,
  ) => Promise<OperationResult<PresentationSessionLifecycle>>;
  /**
   * Read-only phase-guard resolution mirroring #authorizedPresentation semantics without
   * mutating: account validity + existence + ownership of the requested session.
   */
  readonly resolveQaSession: (
    accountSessionId: string,
    presentationSessionId: string,
  ) => Promise<
    | Readonly<{
        outcome: "RESOLVED";
        lifecycle: PresentationSessionLifecycle;
        manifestHash: string;
      }>
    | Readonly<{ outcome: "NOT_FOUND" }>
    | Readonly<{ outcome: "UNAUTHORIZED" }>
  >;
  /**
   * Optional at the composition boundary: a backend configured without recommendations
   * answers POST /v1/qa-defense with a typed 503 instead of attempting a run.
   */
  readonly recommend?: (accountSessionId: string, input: unknown) => Promise<RecommendationOutcome>;
  /**
   * Optional like `recommend`: the product promise is that every rendered answer is
   * recorded, so without the exchange seam the question is refused up front instead of
   * answered unrecorded. When present, a failed ingest MUST become a typed refusal below:
   * the route answers 200 ONLY over a durably recorded exchange.
   */
  readonly ingestExchange?: (input: QaExchangeIngestInput) => Promise<QaExchangeIngestReceipt>;
  readonly now: () => number;
  readonly persist?: () => Promise<void>;
}

/**
 * PHASE GUARD RULE — opening Q&A REQUIRES status "ENDED" (the post-talk rule).
 *
 * Product requirement: "모두 발표가 끝난 뒤에 질의응답 세션으로 가도록 버튼을 만들어서 유도" — the
 * presenter ends the talk, lands on the report page, and the Q&A button leads into the
 * session from there. beginQuestions therefore authorizes an ENDED presentation (owner-
 * checked) and rejects a still-ACTIVE one with PRESENTATION_NOT_ENDED — its own reason,
 * never overloaded onto PRESENTATION_ENDED ("too late") nor silently succeeding.
 */
function openRejection(reason: string, origin: Headers): Response {
  if (reason === "PRESENTATION_NOT_FOUND")
    return json({ error: "presentation_not_found" }, 404, origin);
  if (reason === "UNAUTHORIZED") return json({ error: "unauthorized" }, 403, origin);
  // "The talk has not ended yet": opening Q&A while the presentation is still ACTIVE.
  // Distinct code so the Console can tell "end the talk first" apart from "too late"
  // and from qa_not_open.
  if (reason === "PRESENTATION_NOT_ENDED")
    return json({ error: "presentation_not_ended" }, 409, origin);
  // Defensive legacy surface: an older coordinator build could still reject with this.
  if (reason === "PRESENTATION_ENDED") return json({ error: "presentation_ended" }, 409, origin);
  // Account-session reasons are unreachable post-auth but must stay typed, never a 500.
  return json({ error: "account_session_invalid" }, 401, origin);
}

/** Exactly the four fields the Console's qaLifecycle parser reads; nothing else is emitted. */
function lifecycleView(lifecycle: PresentationSessionLifecycle): Record<string, unknown> {
  return {
    presentationSessionId: lifecycle.presentationSessionId,
    presentationSessionEpoch: lifecycle.presentationSessionEpoch,
    deckVersion: lifecycle.deckVersion,
    status: lifecycle.status,
  };
}

// ---------------------------------------------------------------------------
// WIRE -> PERSISTED SEAM. The ledger lane deliberately persists a NARROWER shape than
// the wire contract (no evidenceId/title/quote: it is a durable summary, not the
// receipt; answerText/abstainReason instead of answer/reason). These named mappers are
// the single translation point; both directions are pinned by qa-http.test.ts so a
// future field rename fails a test instead of silently persisting undefined.
// ---------------------------------------------------------------------------

export function toLedgerQaCitation(citation: QaCitation): LedgerQaCitation {
  switch (citation.kind) {
    case "DECK_SLIDE":
      return { kind: "DECK_SLIDE", slideOrdinal: citation.slideOrdinal };
    case "REFERENCE_DOCUMENT":
      return {
        kind: "REFERENCE_DOCUMENT",
        documentTitle: citation.documentTitle,
        chunkOrdinal: citation.chunkOrdinal,
      };
    case "EXTERNAL_SOURCE":
      return { kind: "EXTERNAL_SOURCE", url: citation.url };
  }
}

export function toLedgerQaDefense(outcome: QaDefenseOutcome): LedgerQaDefenseOutcome {
  if (outcome.outcome === "ABSTAINED") {
    // Wire `reason` -> persisted `abstainReason`; verbatim by contract.
    return {
      outcome: "ABSTAINED",
      abstainReason: outcome.reason,
      retryable: outcome.retryable,
    };
  }
  // Wire `answer` -> persisted `answerText`; citations are narrowed per-citation.
  return {
    outcome: "ANSWERED",
    answerText: outcome.answer,
    citations: outcome.citations.map(toLedgerQaCitation),
  };
}

// EXCHANGE-ID RULE (post-revision): every ask gets a FRESH RANDOM exchange id minted by the
// ledger (see generateQaExchangeId) — a repeated identical question is a GENUINE SECOND ASK
// and is recorded as its own distinct exchange. There is deliberately NO wall-clock bucket:
// the retired 30-second-window heuristic mapped an immediate genuine re-ask onto the first
// ask's id, short-circuiting the durable write while still answering 200 (an audit hole),
// and raised a same-id-different-content store conflict across process boundaries (a 500).
// If client-retry deduplication is ever wanted again it requires an explicit idempotency key
// SUPPLIED BY THE CALLER (QaExchangeIngestInput.exchangeId already accepts one); never a
// clock guess.

const OPEN_QA_PATH = /^\/v1\/presentation-sessions\/([^/]+)\/qa-defense$/;

/** Authenticated Q&A-defense routes. Returns null when no route matched. */
export async function qaDefenseRoutes(
  ctx: AuthedRouteContext,
  qaDefense?: QaDefenseRouteDependencies,
): Promise<Response | null> {
  const { request, url, origin } = ctx;

  if (request.method === "POST" && OPEN_QA_PATH.exec(url.pathname) !== null) {
    const presentationSessionId = OPEN_QA_PATH.exec(url.pathname)?.[1] ?? "";
    if (qaDefense?.beginQuestions === undefined || qaDefense.resolveQaSession === undefined) {
      return json({ error: "qa_defense_unavailable" }, 503, origin);
    }
    const result = await qaDefense.beginQuestions(ctx.accountSessionId, presentationSessionId);
    if (result.outcome === "REJECTED") return openRejection(result.reason, origin);
    await qaDefense.persist?.();
    return json({ lifecycle: lifecycleView(result.value) }, 200, origin);
  }

  if (request.method === "POST" && url.pathname === "/v1/qa-defense") {
    if (
      qaDefense === undefined ||
      qaDefense.recommend === undefined ||
      qaDefense.ingestExchange === undefined
    ) {
      return json({ error: "qa_defense_unavailable" }, 503, origin);
    }
    const parsed = QaDefenseRequestSchema.safeParse(await requestBody(request));
    if (!parsed.success) return json({ error: "invalid_request" }, 400, origin);
    const startedAtMs = qaDefense.now();
    const resolution = await qaDefense.resolveQaSession(
      ctx.accountSessionId,
      parsed.data.presentationSessionId,
    );
    if (resolution.outcome === "NOT_FOUND") {
      return json({ error: "presentation_not_found" }, 404, origin);
    }
    if (resolution.outcome === "UNAUTHORIZED") return json({ error: "unauthorized" }, 403, origin);
    // PHASE GUARD RULE (ask): questions require an OPENED Q&A window (`qaStartedAtMs`), and
    // a window can only have been opened after the talk ENDED. Asking before opening is
    // ALWAYS exactly 409 {"error":"qa_not_open"} regardless of lifecycle status — the
    // Console keys its typed QaDefenseNotOpenError to that body, so status must never mask
    // it with a different error code.
    if (resolution.lifecycle.qaStartedAtMs === null) {
      return json({ error: "qa_not_open" }, 409, origin);
    }
    // Ground across BOTH corpora: deck slides and reference documents share one table and one
    // vector space, so a query WITHOUT slideOrdinal retrieves over everything. Sending
    // slideOrdinal would let the pipeline replace the question with slide text.
    const recommendation = await qaDefense.recommend(ctx.accountSessionId, {
      query: parsed.data.questionText,
      deckVersion: resolution.lifecycle.deckVersion,
      manifestHash: resolution.manifestHash,
    });
    const outcome = qaDefenseOutcome(recommendation);
    // The exchange is committed for BOTH answered and abstained outcomes: what was asked and
    // could not be defended is part of the session's story. The log accepts appends after report
    // finalization (it is its own owner-checked record), so every successful ask ends up
    // recorded.
    // CLOSED LOOP: the answer reaches the presenter ONLY after its audit row is durable. The
    // ledger mints the fresh per-ask exchange id here (no explicit idempotency key), and any
    // store failure becomes the typed 503 refusal below — never an answer without a row,
    // never a bare 500.
    try {
      await qaDefense.ingestExchange({
        tenantId: ctx.accountId,
        presentationSessionId: parsed.data.presentationSessionId,
        ownerSubject: ctx.accountId,
        askedAtMs: startedAtMs,
        question: parsed.data.questionText,
        origin: parsed.data.origin,
        defense: toLedgerQaDefense(outcome),
      });
    } catch {
      return json({ error: "qa_exchange_not_recorded" }, 503, origin);
    }
    await qaDefense.persist?.();
    return json(QaDefenseOutcomeSchema.parse(outcome), 200, origin);
  }

  return null;
}
