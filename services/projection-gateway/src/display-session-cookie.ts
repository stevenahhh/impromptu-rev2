import type { ExactOrigin } from "./config.ts";

// The audience display session travels in one first-party cookie set by the projection gateway on
// POST /v1/display-session and replayed by every Stage surface (/v1/events, /v1/snapshot,
// /v1/stage-applied, the realtime handshake). A "__Host-" prefixed cookie is rejected by browsers
// on non-secure origins, so the dev stack (Stage served over http://localhost:4174 proxying /v1 to
// this gateway) would never round-trip it and every cookie-gated route would 401 forever. This
// mirrors services/private-backend/src/http/session-cookies.ts: a __Host- name with the Secure
// attribute on https origins, a bare name without Secure elsewhere. Only ever accept back the
// exact name the current origin would have issued.
export type DisplayCookieName = "__Host-display" | "display";

export function displayCookieName(allowedOrigin: ExactOrigin): DisplayCookieName {
  return new URL(allowedOrigin).protocol === "https:" ? "__Host-display" : "display";
}

export function displayCookieAttributes(allowedOrigin: ExactOrigin): string {
  const secure = new URL(allowedOrigin).protocol === "https:" ? "; Secure" : "";
  return `Path=/; HttpOnly${secure}; SameSite=Strict`;
}

export function readDisplayCookie(request: Request, allowedOrigin: ExactOrigin): string | null {
  const expectedName = displayCookieName(allowedOrigin);
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === expectedName) return value.join("=") || null;
  }
  return null;
}
