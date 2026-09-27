import type {
  AcceptedTeamQuestionGrant,
  IssueTeamQuestionGrantResponse,
  TeamQuestionGrantList,
  TeamQuestionGrantView,
  TeamQuestionInboxView,
  TeamQuestionReceipt,
} from "@impromptu/contracts/private";
import { requestBody } from "../request-bodies.ts";
import { json } from "../responses.ts";
import type { AuthedRouteContext } from "../route-context.ts";

/**
 * Question-only teammate grant routes (plan task 8).
 *
 *   POST   /v1/team-question-grants          owner issues a grant targeted at a username
 *   DELETE /v1/team-question-grants/:grantId owner revokes (bumps revocation revision)
 *   GET    /v1/team-question-grants          owner lists a session's grants
 *   POST   /v1/team-question-grants/accept   teammate redeems the one-use invitation
 *   POST   /v1/team-questions               teammate appends bounded question text
 *   GET    /v1/team-questions               owner reads the private inbox
 *
 * Registered inside handler.ts's cookie + CSRF boundary, before the coordinator-command
 * fallthrough: exact Origin + Referer on mutations, the account session cookie and the
 * per-session CSRF token are already enforced upstream. This module never broadens
 * identity inputs and returns null when no route matched.
 */

export interface TeamQuestionRouteDependencies {
  readonly issueGrant: (
    accountSessionId: string,
    body: unknown,
  ) => Promise<
    | Readonly<{ outcome: "APPLIED"; value: IssueTeamQuestionGrantResponse }>
    | Readonly<{ outcome: "REJECTED"; reason: string }>
  >;
  readonly revokeGrant: (
    accountSessionId: string,
    grantId: string,
  ) => Promise<
    | Readonly<{ outcome: "APPLIED"; value: TeamQuestionGrantView }>
    | Readonly<{ outcome: "REJECTED"; reason: string }>
  >;
  readonly acceptGrant: (
    accountSessionId: string,
    body: unknown,
  ) => Promise<
    | Readonly<{ outcome: "APPLIED"; value: AcceptedTeamQuestionGrant }>
    | Readonly<{ outcome: "REJECTED"; reason: string }>
  >;
  readonly submitQuestion: (
    accountSessionId: string,
    body: unknown,
  ) => Promise<
    | Readonly<{ outcome: "APPLIED"; value: TeamQuestionReceipt }>
    | Readonly<{ outcome: "REJECTED"; reason: string }>
  >;
  readonly readInbox: (
    accountSessionId: string,
    presentationSessionId: string,
  ) => Promise<
    | Readonly<{ outcome: "APPLIED"; value: TeamQuestionInboxView }>
    | Readonly<{ outcome: "REJECTED"; reason: string }>
  >;
  readonly listGrants: (
    accountSessionId: string,
    presentationSessionId: string,
  ) => Promise<
    | Readonly<{ outcome: "APPLIED"; value: TeamQuestionGrantList }>
    | Readonly<{ outcome: "REJECTED"; reason: string }>
  >;
}

const GRANT_PATH = /^\/v1\/team-question-grants\/([^/]+)$/;
const ACCEPT_PATH = "/v1/team-question-grants/accept";

function rejection(reason: string, origin: Headers): Response {
  switch (reason) {
    case "INVALID_REQUEST":
      return json({ error: "invalid_request" }, 400, origin);
    case "PRESENTATION_NOT_FOUND":
      return json({ error: "presentation_not_found" }, 404, origin);
    case "UNAUTHORIZED":
      return json({ error: "unauthorized" }, 403, origin);
    case "PRESENTATION_ENDED":
      return json({ error: "presentation_ended" }, 409, origin);
    case "TEAMMATE_UNKNOWN":
      return json({ error: "teammate_not_found" }, 404, origin);
    case "SELF_GRANT":
      return json({ error: "team_grant_self" }, 409, origin);
    case "INVITATION_UNKNOWN":
      return json({ error: "invitation_not_found" }, 404, origin);
    case "GRANT_UNKNOWN":
    case "GRANT_NOT_FOR_CALLER":
      return json({ error: "team_grant_not_found" }, 404, origin);
    case "GRANT_REVOKED":
      return json({ error: "team_grant_revoked" }, 410, origin);
    case "GRANT_EXPIRED":
      return json({ error: "team_grant_expired" }, 410, origin);
    case "GRANT_NOT_ACCEPTED":
      return json({ error: "team_grant_not_accepted" }, 409, origin);
    case "GRANT_ALREADY_ACCEPTED":
      return json({ error: "team_grant_already_accepted" }, 409, origin);
    case "IDEMPOTENCY_CONFLICT":
      return json({ error: "team_question_idempotency_conflict" }, 409, origin);
    default:
      if (reason.startsWith("ACCOUNT_SESSION_")) {
        return json({ error: "account_session_invalid" }, 401, origin);
      }
      return json({ error: reason }, 409, origin);
  }
}

export async function teamQuestionRoutes(
  ctx: AuthedRouteContext,
  teamQuestions?: TeamQuestionRouteDependencies,
): Promise<Response | null> {
  const { request, url, origin, accountSessionId } = ctx;

  if (teamQuestions === undefined) {
    // Answer the typed 503 only when the request actually targets this surface;
    // anything else must keep falling through to later route groups.
    const isTeamRoute =
      url.pathname === "/v1/team-questions" ||
      url.pathname === "/v1/team-question-grants" ||
      url.pathname === ACCEPT_PATH ||
      (request.method === "DELETE" && GRANT_PATH.test(url.pathname));
    return isTeamRoute ? json({ error: "team_questions_unavailable" }, 503, origin) : null;
  }

  // Teammate redemption: the exact literal path is matched before the grant-id pattern so
  // "accept" can never be mistaken for a grant id.
  if (request.method === "POST" && url.pathname === ACCEPT_PATH) {
    const result = await teamQuestions.acceptGrant(accountSessionId, await requestBody(request));
    return result.outcome === "APPLIED"
      ? json(result.value, 200, origin)
      : rejection(result.reason, origin);
  }

  if (request.method === "POST" && url.pathname === "/v1/team-question-grants") {
    const result = await teamQuestions.issueGrant(accountSessionId, await requestBody(request));
    if (result.outcome === "REJECTED") return rejection(result.reason, origin);
    // An idempotent replay carries `duplicate: true` and no invitation token; only a fresh
    // issuance (201) ever reveals the one-use secret.
    const duplicate = "duplicate" in result.value && result.value.duplicate === true;
    return json(result.value, duplicate ? 200 : 201, origin);
  }

  if (request.method === "DELETE") {
    const grantId = GRANT_PATH.exec(url.pathname)?.[1];
    if (grantId !== undefined) {
      const result = await teamQuestions.revokeGrant(accountSessionId, grantId);
      return result.outcome === "APPLIED"
        ? json(result.value, 200, origin)
        : rejection(result.reason, origin);
    }
  }

  if (request.method === "GET" && url.pathname === "/v1/team-question-grants") {
    const result = await teamQuestions.listGrants(
      accountSessionId,
      url.searchParams.get("presentationSessionId") ?? "",
    );
    return result.outcome === "APPLIED"
      ? json(result.value, 200, origin)
      : rejection(result.reason, origin);
  }

  if (request.method === "POST" && url.pathname === "/v1/team-questions") {
    const result = await teamQuestions.submitQuestion(accountSessionId, await requestBody(request));
    return result.outcome === "APPLIED"
      ? json(result.value, 202, origin)
      : rejection(result.reason, origin);
  }

  if (request.method === "GET" && url.pathname === "/v1/team-questions") {
    const result = await teamQuestions.readInbox(
      accountSessionId,
      url.searchParams.get("presentationSessionId") ?? "",
    );
    return result.outcome === "APPLIED"
      ? json(result.value, 200, origin)
      : rejection(result.reason, origin);
  }

  return null;
}
