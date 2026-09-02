import { AUDIO_CAPTURE_COOKIE_NAME } from "../audio-ingest.ts";
import type { ExactOrigin } from "../config.ts";

export function accountCookieName(allowedOrigin: ExactOrigin): "__Host-account" | "account" {
  return new URL(allowedOrigin).protocol === "https:" ? "__Host-account" : "account";
}

export function accountCookieAttributes(allowedOrigin: ExactOrigin): string {
  const secure = new URL(allowedOrigin).protocol === "https:" ? "; Secure" : "";
  return `Path=/; HttpOnly${secure}; SameSite=Strict`;
}

function namedCookie(request: Request, expectedName: string): string | null {
  const cookie = request.headers.get("cookie");
  if (cookie === null) return null;
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === expectedName) return value.join("=") || null;
  }
  return null;
}

export function accountCookie(request: Request, allowedOrigin: ExactOrigin): string | null {
  return namedCookie(request, accountCookieName(allowedOrigin));
}

export function captureCookie(request: Request): string | null {
  return namedCookie(request, AUDIO_CAPTURE_COOKIE_NAME);
}

export function captureCookieAttributes(): string {
  return "Path=/; HttpOnly; Secure; SameSite=Strict";
}

export function csrfToken(internalAuthToken: string, accountSessionId: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(`account-csrf:${internalAuthToken}:${accountSessionId}`)
    .digest("hex")
    .slice(0, 48);
}
