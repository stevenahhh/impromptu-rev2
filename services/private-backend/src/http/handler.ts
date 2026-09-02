import type { PrivateBackendConfig } from "../config.ts";
import { httpOutcome } from "../observability.ts";
import { browserOriginHeaders, mutationAllowed } from "./origin-guard.ts";
import { json, responseOutcome } from "./responses.ts";
import type { AuthedRouteContext } from "./route-context.ts";
import { accountEntryRoutes, accountSessionDeleteRoute } from "./routes/accounts.ts";
import { audioRoutes } from "./routes/audio.ts";
import { coordinatorCommandRoutes } from "./routes/coordinator-commands.ts";
import { deckUploadRoutes } from "./routes/deck-uploads.ts";
import { playbackReadRoutes } from "./routes/playback-read.ts";
import { referenceDocumentRoutes } from "./routes/reference-documents.ts";
import { systemRoutes } from "./routes/system.ts";
import { accountCookie, csrfToken } from "./session-cookies.ts";
import type { PrivateBackendHandler, PrivateBackendHttpDependencies } from "./types.ts";

export function createPrivateBackendHandler(
  config: PrivateBackendConfig,
  dependencies?: PrivateBackendHttpDependencies,
): PrivateBackendHandler {
  const handle = async (request: Request): Promise<Response> => {
    const origin = browserOriginHeaders(request, config.allowedOrigin);
    if (origin instanceof Response) return origin;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: origin });

    const url = new URL(request.url);
    const system = await systemRoutes(request, url, origin, dependencies);
    if (system !== null) return system;
    if (dependencies === undefined) return json({ error: "not_found" }, 404, origin);

    if (request.method !== "GET" && !mutationAllowed(request, config.allowedOrigin)) {
      return json({ error: "mutation_origin_forbidden" }, 403, origin);
    }

    const accountEntry = await accountEntryRoutes(request, url, origin, config, dependencies);
    if (accountEntry !== null) return accountEntry;

    // Session authentication boundary: cookie identifies the account session, CSRF proves the
    // caller holds the session token for every non-GET mutation.
    const accountSessionId = accountCookie(request, config.allowedOrigin);
    if (accountSessionId === null) return json({ error: "account_session_required" }, 401, origin);
    const account = await dependencies.coordinator.readAccountSession(
      accountSessionId,
      dependencies.now(),
    );
    if (account.outcome === "REJECTED") {
      return json({ error: account.reason }, 401, origin);
    }
    if (request.method !== "GET") {
      const expectedCsrf = csrfToken(dependencies.internalAuthToken, accountSessionId);
      if (request.headers.get("x-csrf-token") !== expectedCsrf) {
        return json({ error: "csrf_rejected" }, 403, origin);
      }
    }

    const reportResponse = await dependencies.sessionReportRead?.(
      request,
      account.value.accountId,
    );
    if (reportResponse !== undefined && reportResponse !== null) return reportResponse;

    const ctx: AuthedRouteContext = {
      request,
      url,
      origin,
      config,
      dependencies,
      accountSessionId,
      accountId: account.value.accountId,
      actorId: account.value.actorId,
      sessionExpiresAtMs: account.value.expiresAtMs,
    };

    const audio = await audioRoutes(ctx);
    if (audio !== null) return audio;

    const playbackRead = await playbackReadRoutes(ctx);
    if (playbackRead !== null) return playbackRead;

    const logout = await accountSessionDeleteRoute(ctx);
    if (logout !== null) return logout;

    const deckUpload = await deckUploadRoutes(ctx);
    if (deckUpload !== null) return deckUpload;

    const referenceDocuments = await referenceDocumentRoutes(ctx);
    if (referenceDocuments !== null) return referenceDocuments;

    return coordinatorCommandRoutes(ctx);
  };

  return async (request) => {
    const startedAtMs = dependencies?.now() ?? Date.now();
    const path = new URL(request.url).pathname;
    const suppliedRequestId = request.headers.get("x-request-id");
    const requestId =
      suppliedRequestId !== null && /^[A-Za-z0-9._:-]{1,128}$/.test(suppliedRequestId)
        ? suppliedRequestId
        : crypto.randomUUID();
    let response: Response;
    try {
      response = await handle(request);
    } catch (error) {
      dependencies?.logger?.error({
        requestId,
        path,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      response = json({ error: "internal_error" }, 500);
    }
    response.headers.set("x-request-id", requestId);
    const durationMs = Math.max(0, (dependencies?.now() ?? Date.now()) - startedAtMs);
    const outcome = responseOutcome(response, httpOutcome(response.status));
    dependencies?.metrics?.observeHttp(request.method, path, response.status, durationMs, outcome);
    dependencies?.logger?.request({
      requestId,
      method: request.method,
      path,
      status: response.status,
      durationMs,
      outcome,
    });
    return response;
  };
}
