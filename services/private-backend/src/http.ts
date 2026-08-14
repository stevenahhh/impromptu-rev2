import type { ExactOrigin, PrivateBackendConfig } from "./config.ts";

export type PrivateBackendHandler = (request: Request) => Response;

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

export function createPrivateBackendHandler(config: PrivateBackendConfig): PrivateBackendHandler {
  return (request) => {
    const origin = browserOriginHeaders(request, config.allowedOrigin);
    if (origin instanceof Response) {
      return origin;
    }

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ service: "private-backend", status: "ok" }, 200, origin);
    }

    return json({ error: "not_found" }, 404, origin);
  };
}
