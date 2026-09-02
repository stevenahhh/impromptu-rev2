import { controllerEventStream } from "../controller-events.ts";
import { json } from "../responses.ts";
import type { AuthedRouteContext } from "../route-context.ts";
import { csrfToken } from "../session-cookies.ts";

/**
 * Playback/publication read routes plus the retired stage-card gate. Returns null when no
 * route matched.
 */
export async function playbackReadRoutes(ctx: AuthedRouteContext): Promise<Response | null> {
  const { request, url, origin, dependencies, accountSessionId } = ctx;

  if (
    request.method === "POST" &&
    (url.pathname === "/v1/publications/approve" || url.pathname === "/v1/publications/terminate")
  ) {
    return json({ error: "stage_cards_disabled" }, 410, origin);
  }

  if (request.method === "GET" && url.pathname === "/v1/account-session") {
    return json(
      {
        account: { accountId: ctx.accountId, actorId: ctx.actorId },
        expiresAtMs: ctx.sessionExpiresAtMs,
        csrfToken: csrfToken(dependencies.internalAuthToken, accountSessionId),
      },
      200,
      origin,
    );
  }

  if (request.method === "GET" && url.pathname === "/v1/playback/controller-events") {
    const presentationSessionId = url.searchParams.get("presentationSessionId");
    return presentationSessionId === null
      ? json({ error: "presentation_session_required" }, 400, origin)
      : await controllerEventStream(
          dependencies.coordinator,
          accountSessionId,
          presentationSessionId,
          dependencies.now(),
          origin,
          dependencies.metrics,
        );
  }

  if (request.method === "GET" && url.pathname === "/v1/publications/live-candidates") {
    const presentationSessionId = url.searchParams.get("presentationSessionId");
    if (presentationSessionId === null) {
      return json({ error: "presentation_session_required" }, 400, origin);
    }
    const result = await dependencies.coordinator.readLiveCandidateSnapshot(
      accountSessionId,
      presentationSessionId,
      dependencies.now(),
    );
    return json(
      result.outcome === "APPLIED" ? result.value : { error: result.reason },
      result.outcome === "APPLIED" ? 200 : 403,
      origin,
    );
  }

  return null;
}
