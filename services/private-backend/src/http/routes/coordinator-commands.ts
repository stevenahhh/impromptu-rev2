import { createPreparedDeckArtifacts } from "../../prepared-deck-upload.ts";
import { renderedDeckArtifacts } from "../../rendered-deck-artifacts.ts";
import { isRecord, requestBody } from "../request-bodies.ts";
import { json, observeResponseOutcome } from "../responses.ts";
import type { AuthedRouteContext } from "../route-context.ts";

/**
 * Terminal body-parsed command routes. In the original dispatch these run after every other
 * route group has declined, so this module owns both the request-body parse (an unparseable
 * body is invalid_request even when no route matches) and the final 404.
 */
export async function coordinatorCommandRoutes(ctx: AuthedRouteContext): Promise<Response> {
  const { request, url, origin, dependencies, accountSessionId } = ctx;
  const body = await requestBody(request);
  if (!isRecord(body)) return json({ error: "invalid_request" }, 400, origin);
  if (request.method === "POST" && url.pathname === "/v1/recommendations") {
    if (dependencies.recommendations === undefined) {
      return json({ error: "recommendations_unavailable" }, 503, origin);
    }
    const recommendation = await dependencies.recommendations.recommend(accountSessionId, body);
    const outcome =
      recommendation.outcome === "ABSTAIN"
        ? `${recommendation.outcome}:${recommendation.reason}`
        : recommendation.outcome;
    return observeResponseOutcome(json(recommendation, 200, origin), outcome);
  }
  if (request.method === "POST" && url.pathname === "/v1/candidates/live") {
    const result = await dependencies.coordinator.addLiveCandidate(
      accountSessionId,
      body,
      dependencies.now(),
    );
    if (result.outcome === "APPLIED") await dependencies.persist?.();
    return json(
      result.outcome === "APPLIED" ? result.value : { error: result.reason },
      result.outcome === "APPLIED" ? 201 : 409,
      origin,
    );
  }
  if (request.method === "POST" && url.pathname === "/v1/deck-artifacts") {
    if (typeof body.title !== "string") {
      return json({ error: "invalid_request" }, 400, origin);
    }
    try {
      if (body.renderManifest !== undefined || body.publicBaseUrl !== undefined) {
        return json(
          renderedDeckArtifacts(ctx.accountId, {
            title: body.title,
            manifest: body.renderManifest,
            publicBaseUrl: body.publicBaseUrl,
          }),
          201,
          origin,
        );
      }
      if (typeof body.content !== "string") {
        return json({ error: "invalid_request" }, 400, origin);
      }
      return json(
        createPreparedDeckArtifacts(ctx.accountId, {
          title: body.title,
          content: body.content,
        }),
        201,
        origin,
      );
    } catch {
      return json({ error: "invalid_deck_upload" }, 400, origin);
    }
  }
  if (request.method === "POST" && url.pathname === "/v1/presentation-sessions") {
    const result = await dependencies.coordinator.createPresentation(
      accountSessionId,
      { privateDeck: body.privateDeck, publicDeck: body.publicDeck },
      dependencies.now(),
    );
    if (result.outcome === "APPLIED") await dependencies.persist?.();
    return json(
      result.outcome === "APPLIED" ? result.value : { error: result.reason },
      result.outcome === "APPLIED" ? 201 : 409,
      origin,
    );
  }
  if (request.method === "POST" && url.pathname === "/v1/display-bindings") {
    const result = await dependencies.coordinator.approveDisplay(
      accountSessionId,
      body,
      dependencies.now(),
    );
    if (result.outcome === "APPLIED") await dependencies.persist?.();
    return json(
      result.outcome === "APPLIED" ? result.value : { error: result.reason },
      result.outcome === "APPLIED" ? 201 : 409,
      origin,
    );
  }
  if (request.method === "POST" && url.pathname === "/v1/playback/lease-takeover") {
    const result = await dependencies.coordinator.takeoverPlaybackLease(
      accountSessionId,
      body,
      dependencies.now(),
    );
    if (result.outcome === "APPLIED") await dependencies.persist?.();
    return json(
      result.outcome === "APPLIED" ? result.value : { error: result.reason },
      result.outcome === "APPLIED" ? 200 : 409,
      origin,
    );
  }
  if (request.method === "POST" && url.pathname === "/v1/playback/slide-set") {
    const result = await dependencies.coordinator.setSlide(
      accountSessionId,
      {
        presentationSessionId: String(body.presentationSessionId ?? ""),
        commandId: String(body.commandId ?? ""),
        publicSlideKey: String(body.publicSlideKey ?? ""),
        displayBindingEpoch: String(body.displayBindingEpoch ?? ""),
        baseRevision: String(body.baseRevision ?? ""),
      },
      dependencies.now(),
    );
    if (result.outcome === "APPLIED") await dependencies.persist?.();
    return json(
      result.outcome === "APPLIED" ? result.value : { error: result.reason },
      result.outcome === "APPLIED" ? 202 : 409,
      origin,
    );
  }
  if (request.method === "POST" && url.pathname === "/v1/candidates/curated") {
    const result = await dependencies.coordinator.addCuratedCandidate(
      accountSessionId,
      body,
      dependencies.now(),
    );
    if (result.outcome === "APPLIED") await dependencies.persist?.();
    return json(
      result.outcome === "APPLIED" ? result.value : { error: result.reason },
      result.outcome === "APPLIED" ? 201 : 409,
      origin,
    );
  }
  if (request.method === "POST" && url.pathname === "/v1/publications/teammates") {
    const result = await dependencies.coordinator.approvePublicationTeammate(
      accountSessionId,
      String(body.presentationSessionId ?? ""),
      String(body.actorId ?? ""),
      dependencies.now(),
    );
    if (result.outcome === "APPLIED") await dependencies.persist?.();
    return json(
      result.outcome === "APPLIED" ? { status: "approved" } : { error: result.reason },
      result.outcome === "APPLIED" ? 200 : 403,
      origin,
    );
  }

  return json({ error: "not_found" }, 404, origin);
}
