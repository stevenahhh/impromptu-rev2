import type { ExactOrigin } from "../config.ts";
import { json } from "./responses.ts";

export function browserOriginHeaders(
  request: Request,
  allowedOrigin: ExactOrigin,
): Headers | Response {
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
  headers.set("access-control-allow-methods", "GET, POST, DELETE");
  headers.set(
    "access-control-allow-headers",
    "content-type, x-audio-duration-ms, x-audio-sequence, x-csrf-token",
  );
  headers.set("vary", "Origin");
  return headers;
}

export function mutationAllowed(request: Request, allowedOrigin: ExactOrigin): boolean {
  if (request.headers.get("origin") !== allowedOrigin) return false;
  const referer = request.headers.get("referer");
  if (referer === null) return false;
  try {
    return new URL(referer).origin === allowedOrigin;
  } catch {
    return false;
  }
}
