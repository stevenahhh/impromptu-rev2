import { requestBody } from "../request-bodies.ts";
import { json } from "../responses.ts";
import type { AuthedRouteContext } from "../route-context.ts";

/**
 * Non-authorizing display invitation routes (plan task 7).
 *
 * POST /v1/display-invitations mints a <=90s, one-use invitation for a presentation the
 * authenticated owner controls; the response is the minted DTO only — the token inside it
 * is Stage URL fragment material and never confers display authority by itself.
 * GET /v1/display-invitations/:id/pending answers the owner-facing identity check: the
 * exact display id/fingerprint that asked to join plus the authoritative binding epoch the
 * approval CAS is written against.
 *
 * Auth is enforced by handler.ts upstream (exact Origin + Referer on mutations, account
 * session cookie, CSRF); this module never broadens identity inputs and returns null when
 * no route matched.
 */

const PENDING_PATH = /^\/v1\/display-invitations\/([^/]+)\/pending$/;

function rejection(reason: string, origin: Headers): Response {
  if (reason === "INVALID_DISPLAY_INVITATION") {
    return json({ error: "invalid_request" }, 400, origin);
  }
  if (reason === "PRESENTATION_NOT_FOUND") {
    return json({ error: "presentation_not_found" }, 404, origin);
  }
  if (reason === "UNAUTHORIZED") return json({ error: "unauthorized" }, 403, origin);
  if (reason === "PRESENTATION_ENDED") {
    return json({ error: "presentation_ended" }, 409, origin);
  }
  if (reason.startsWith("ACCOUNT_SESSION_")) {
    return json({ error: "account_session_invalid" }, 401, origin);
  }
  if (reason === "INVITATION_UNKNOWN" || reason === "INVITATION_SESSION_MISMATCH") {
    return json({ error: "invitation_not_found" }, 404, origin);
  }
  if (reason === "INVITATION_EXPIRED" || reason === "INVITATION_CONSUMED") {
    return json({ error: reason }, 410, origin);
  }
  if (reason === "PROJECTION_UNAVAILABLE" || reason === "INVALID_PROJECTION_RESPONSE") {
    return json({ error: "projection_unavailable" }, 503, origin);
  }
  return json({ error: reason }, 409, origin);
}

export async function displayInvitationRoutes(ctx: AuthedRouteContext): Promise<Response | null> {
  const { request, url, origin, dependencies, accountSessionId } = ctx;

  if (request.method === "GET" && PENDING_PATH.test(url.pathname)) {
    const invitationId = PENDING_PATH.exec(url.pathname)?.[1] ?? "";
    const result = await dependencies.coordinator.readDisplayInvitation(
      accountSessionId,
      invitationId,
      dependencies.now(),
    );
    return result.outcome === "APPLIED"
      ? json(result.value, 200, origin)
      : rejection(result.reason, origin);
  }

  if (request.method === "POST" && url.pathname === "/v1/display-invitations") {
    const result = await dependencies.coordinator.issueDisplayInvitation(
      accountSessionId,
      await requestBody(request),
      dependencies.now(),
    );
    return result.outcome === "APPLIED"
      ? json(result.value, 201, origin)
      : rejection(result.reason, origin);
  }

  return null;
}
