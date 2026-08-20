import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { consoleContentSecurityPolicy, consoleResponseSecurityHeaders } from "./security-policy";

export function middleware(request: NextRequest) {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const production = process.env.NODE_ENV === "production";
  const contentSecurityPolicy = consoleContentSecurityPolicy(nonce, !production);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicy);
  requestHeaders.set("x-nonce", nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", contentSecurityPolicy);
  for (const { key, value } of consoleResponseSecurityHeaders(production)) {
    response.headers.set(key, value);
  }
  return response;
}

export const config = {
  matcher: [
    "/((?!v1|_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest|offline.html|sw.js).*)",
  ],
};
