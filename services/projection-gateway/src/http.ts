import type { ExactOrigin, ProjectionGatewayConfig } from "./config.ts";

export type ProjectionGatewayHandler = (request: Request) => Response;

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
  headers.set("vary", "Origin");
  return headers;
}

export function createProjectionGatewayHandler(
  config: ProjectionGatewayConfig,
): ProjectionGatewayHandler {
  return (request) => {
    const origin = browserOriginHeaders(request, config.allowedOrigin);
    if (origin instanceof Response) {
      return origin;
    }

    const url = new URL(request.url);
    if (request.method !== "GET") {
      return json({ error: "dispatcher_required" }, 403, origin);
    }
    if (url.pathname === "/health") {
      return json({ service: "projection-gateway", status: "ok" }, 200, origin);
    }

    return json({ error: "not_found" }, 404, origin);
  };
}
