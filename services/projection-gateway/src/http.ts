import type { ExactOrigin, ProjectionGatewayConfig } from "./config.ts";
import type { PreparedEvidenceProjectionGateway } from "./prepared-evidence.ts";

export type ProjectionGatewayHandler = (request: Request) => Response | Promise<Response>;

export interface ProjectionGatewayHttpDependencies {
  readonly gateway: PreparedEvidenceProjectionGateway;
  readonly now: () => number;
}

function json(body: unknown, status: number, headers?: Headers): Response {
  const responseHeaders = headers ?? new Headers();
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("content-type", "application/json; charset=utf-8");

  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

function browserOriginHeaders(request: Request, allowedOrigin: ExactOrigin): Headers | Response {
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin === null) {
    return new Headers();
  }

  if (requestOrigin !== allowedOrigin) {
    return json({ error: "origin_forbidden" }, 403);
  }

  const headers = new Headers();
  headers.set("access-control-allow-origin", allowedOrigin);
  headers.set("access-control-allow-credentials", "true");
  headers.set("vary", "Origin");
  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requestBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

function displayCookie(request: Request): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === "__Host-display") return value.join("=") || null;
  }
  return null;
}

function validMutationOrigin(request: Request, origin: ExactOrigin): boolean {
  const referer = request.headers.get("referer");
  if (request.headers.get("origin") !== origin || referer === null) return false;
  try {
    return new URL(referer).origin === origin;
  } catch {
    return false;
  }
}

export function createProjectionGatewayHandler(
  config: ProjectionGatewayConfig,
  dependencies?: ProjectionGatewayHttpDependencies,
): ProjectionGatewayHandler {
  return async (request) => {
    const origin = browserOriginHeaders(request, config.allowedOrigin);
    if (origin instanceof Response) return origin;

    const url = new URL(request.url);
    if (request.method !== "GET") {
      return json({ error: "dispatcher_required" }, 403, origin);
    }
    if (url.pathname === "/health") {
      return json({ service: "projection-gateway", status: "ok" }, 200, origin);
    }
    if (dependencies === undefined) return json({ error: "not_found" }, 404, origin);
    if (request.method !== "GET" && !validMutationOrigin(request, config.allowedOrigin)) {
      return json({ error: "mutation_origin_forbidden" }, 403, origin);
    }

    if (request.method === "POST" && url.pathname === "/v1/display-joins") {
      const body = await requestBody(request);
      if (
        body === null ||
        typeof body.displayId !== "string" ||
        typeof body.deckVersion !== "string" ||
        typeof body.displayFingerprint !== "string"
      ) {
        return json({ error: "invalid_request" }, 400, origin);
      }
      return json(
        dependencies.gateway.createDisplayJoin(
          {
            displayId: body.displayId,
            deckVersion: body.deckVersion,
            displayFingerprint: body.displayFingerprint,
          },
          dependencies.now(),
        ),
        201,
        origin,
      );
    }
    if (request.method === "POST" && url.pathname === "/v1/display-session") {
      const body = await requestBody(request);
      if (
        body === null ||
        typeof body.displayJoinId !== "string" ||
        typeof body.displayId !== "string" ||
        typeof body.displayFingerprint !== "string"
      ) {
        return json({ error: "invalid_request" }, 400, origin);
      }
      const session = dependencies.gateway.claimDisplaySession(
        {
          displayJoinId: body.displayJoinId,
          displayId: body.displayId,
          displayFingerprint: body.displayFingerprint,
        },
        dependencies.now(),
      );
      if (session === null) return json({ error: "display_not_approved" }, 409, origin);
      origin.append(
        "set-cookie",
        `__Host-display=${session.audienceDisplaySessionId}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((session.expiresAtMs - dependencies.now()) / 1_000))}`,
      );
      return json(session, 201, origin);
    }
    if (request.method === "GET" && url.pathname === "/v1/snapshot") {
      const audienceDisplaySessionId = displayCookie(request);
      if (audienceDisplaySessionId === null) {
        return json({ error: "display_session_required" }, 401, origin);
      }
      const snapshot = dependencies.gateway.snapshot(audienceDisplaySessionId, dependencies.now());
      return snapshot === null
        ? json({ error: "display_session_expired" }, 401, origin)
        : json(snapshot, 200, origin);
    }

    return json({ error: "not_found" }, 404, origin);
  };
}
