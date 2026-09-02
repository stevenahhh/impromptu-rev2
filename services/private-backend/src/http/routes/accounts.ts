import { AUDIO_CAPTURE_COOKIE_NAME } from "../../audio-ingest.ts";
import type { PrivateBackendConfig } from "../../config.ts";
import { PreparedEvidenceStateConflictError } from "../../prepared-evidence-store-postgres.ts";
import { clientIpKey, hashRateLimitKey } from "../../rate-limit.ts";
import { accountCredentials, requestBody } from "../request-bodies.ts";
import { json, rateLimited } from "../responses.ts";
import type { AuthedRouteContext } from "../route-context.ts";
import {
  accountCookieAttributes,
  accountCookieName,
  captureCookieAttributes,
  csrfToken,
} from "../session-cookies.ts";
import type { PrivateBackendHttpDependencies } from "../types.ts";

/** Pre-authentication account routes. Returns null when no route matched. */
export async function accountEntryRoutes(
  request: Request,
  url: URL,
  origin: Headers,
  config: PrivateBackendConfig,
  dependencies: PrivateBackendHttpDependencies,
): Promise<Response | null> {
  if (request.method === "POST" && url.pathname === "/v1/accounts") {
    if (dependencies.accountRegistrar === undefined) {
      return json({ error: "account_registration_unavailable" }, 501, origin);
    }
    const credentials = accountCredentials(await requestBody(request));
    if (credentials === null) return json({ error: "invalid_request" }, 400, origin);
    const registration = await dependencies.accountRegistrar.register(
      credentials,
      dependencies.now(),
    );
    if (registration.outcome === "APPLIED") {
      return json({ account: { accountId: registration.value.accountId } }, 201, origin);
    }
    return json(
      { error: registration.reason },
      registration.reason === "USERNAME_TAKEN" ? 409 : 400,
      origin,
    );
  }

  if (request.method === "POST" && url.pathname === "/v1/account-sessions") {
    const credentials = accountCredentials(await requestBody(request));
    if (credentials === null) return json({ error: "invalid_request" }, 400, origin);
    if (dependencies.loginRateLimiters !== undefined) {
      const accountDecision = dependencies.loginRateLimiters.account.consume(
        hashRateLimitKey(`account:${credentials.username.trim().toLowerCase()}`),
      );
      if (accountDecision.outcome === "REJECTED") {
        return rateLimited("ACCOUNT_RATE_LIMITED", accountDecision.retryAfterMs, origin);
      }
      const ipDecision = dependencies.loginRateLimiters.ip.consume(clientIpKey(request));
      if (ipDecision.outcome === "REJECTED") {
        return rateLimited("IP_RATE_LIMITED", ipDecision.retryAfterMs, origin);
      }
    }
    const identity = await dependencies.identityVerifier.verifyCredentials(
      credentials.username,
      credentials.password,
    );
    if (identity === null) return json({ error: "authentication_failed" }, 401, origin);
    const session = await dependencies.coordinator.createAccountSession(
      identity,
      dependencies.now(),
    );
    const sessionCsrfToken = csrfToken(dependencies.internalAuthToken, session.accountSessionId);
    try {
      await dependencies.persist?.();
    } catch (error) {
      // Concurrent sign-ins can legitimately lose the state compare-and-swap. Surface that
      // as a deliberate, retryable 503 instead of an unhandled internal error; the client
      // retry re-reads the freshly committed snapshot and succeeds.
      if (error instanceof PreparedEvidenceStateConflictError) {
        return json({ error: "state_write_conflict" }, 503, origin);
      }
      throw error;
    }
    const cookieName = accountCookieName(config.allowedOrigin);
    const cookieAttributes = accountCookieAttributes(config.allowedOrigin);
    origin.append(
      "set-cookie",
      `${cookieName}=${session.accountSessionId}; ${cookieAttributes}; Max-Age=${Math.max(0, Math.floor((session.expiresAtMs - dependencies.now()) / 1_000))}`,
    );
    return json(
      {
        account: { accountId: session.accountId, actorId: session.actorId },
        expiresAtMs: session.expiresAtMs,
        csrfToken: sessionCsrfToken,
      },
      201,
      origin,
    );
  }

  return null;
}

/** Authenticated logout. Returns null when no route matched. */
export async function accountSessionDeleteRoute(ctx: AuthedRouteContext): Promise<Response | null> {
  const { request, url, origin, config, dependencies, accountSessionId, actorId } = ctx;
  if (!(request.method === "DELETE" && url.pathname === "/v1/account-session")) return null;
  dependencies.audio?.accountLoggedOut(accountSessionId, actorId, dependencies.now());
  const result = await dependencies.coordinator.revokeAccountSession(
    accountSessionId,
    dependencies.now(),
  );
  if (result.outcome === "APPLIED") await dependencies.persist?.();
  const cookieName = accountCookieName(config.allowedOrigin);
  const cookieAttributes = accountCookieAttributes(config.allowedOrigin);
  origin.append("set-cookie", `${cookieName}=; ${cookieAttributes}; Max-Age=0`);
  origin.append(
    "set-cookie",
    `${AUDIO_CAPTURE_COOKIE_NAME}=; ${captureCookieAttributes()}; Max-Age=0`,
  );
  return json(
    result.outcome === "APPLIED" ? { status: "revoked" } : { error: result.reason },
    result.outcome === "APPLIED" ? 200 : 401,
    origin,
  );
}
