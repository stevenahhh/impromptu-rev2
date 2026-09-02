import { isRecord, requestBody } from "../request-bodies.ts";
import { json, text } from "../responses.ts";
import type { PrivateBackendHttpDependencies } from "../types.ts";

/**
 * Routes served before the mutation-origin gate and session authentication: public health
 * probes and bearer-authenticated internal endpoints. Returns null when no route matched.
 */
export async function systemRoutes(
  request: Request,
  url: URL,
  origin: Headers,
  dependencies: PrivateBackendHttpDependencies | undefined,
): Promise<Response | null> {
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ service: "private-backend", status: "ok" }, 200, origin);
  }
  if (dependencies === undefined) {
    return url.pathname === "/readyz"
      ? json({ outcome: "NOT_READY", reason: "DEPENDENCIES_UNAVAILABLE" }, 503, origin)
      : json({ error: "not_found" }, 404, origin);
  }
  if (request.method === "GET" && url.pathname === "/metrics") {
    if (request.headers.get("authorization") !== `Bearer ${dependencies.internalAuthToken}`) {
      return json({ error: "internal_unauthorized" }, 401);
    }
    return text(dependencies.metrics?.render() ?? "", 200);
  }
  if (request.method === "GET" && url.pathname === "/readyz") {
    if (dependencies.readiness === undefined) {
      return json({ outcome: "NOT_READY", reason: "DEPENDENCY_CHECK_UNAVAILABLE" }, 503, origin);
    }
    try {
      const readiness = await dependencies.readiness.check();
      return json(readiness, readiness.outcome === "READY" ? 200 : 503, origin);
    } catch {
      return json({ outcome: "NOT_READY", reason: "DEPENDENCY_CHECK_FAILED" }, 503, origin);
    }
  }

  if (request.method === "POST" && url.pathname === "/internal/stage-applied") {
    if (request.headers.get("authorization") !== `Bearer ${dependencies.internalAuthToken}`) {
      return json({ error: "internal_unauthorized" }, 401);
    }
    const body = await requestBody(request);
    if (!isRecord(body)) return json({ error: "invalid_request" }, 400);
    const result = await dependencies.coordinator.recordStageApplied({
      audienceDisplaySessionId: String(body.audienceDisplaySessionId ?? ""),
      commandId: String(body.commandId ?? ""),
      displayBindingEpoch: String(body.displayBindingEpoch ?? ""),
    });
    if (result.outcome === "APPLIED") await dependencies.persist?.();
    // A refused receipt stalls the public playback revision, so the reason has to be legible
    // from outside: it is returned in the 409 body below, alongside the request log's status.
    return json(
      result.outcome === "APPLIED" ? result.value : { error: result.reason },
      result.outcome === "APPLIED" ? 200 : 409,
    );
  }

  return null;
}
