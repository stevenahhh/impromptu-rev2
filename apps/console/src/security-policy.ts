export const STRICT_TRANSPORT_SECURITY = "max-age=63072000; includeSubDomains; preload";
export const REFERRER_POLICY = "strict-origin-when-cross-origin";
export const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=()",
  "camera=()",
  "display-capture=()",
  "encrypted-media=()",
  "fullscreen=(self)",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=(self)",
  "payment=()",
  "picture-in-picture=()",
  "publickey-credentials-get=()",
  "usb=()",
].join(", ");

/**
 * Folded away at build time rather than chosen at runtime. The repository's browser-boundary
 * verifier reads the built middleware bundle and fails if an inline style allowance appears in it
 * at all — a guarantee worth keeping, because it holds even if a caller passes the wrong flag.
 * `process.env.NODE_ENV` is statically replaced in a production build, so this branch and the
 * literal itself are eliminated from the shipped bundle.
 */
const DEVELOPMENT_INLINE_STYLE_ALLOWANCE =
  process.env.NODE_ENV === "production" ? "" : "'unsafe-inline'";

export function consoleContentSecurityPolicy(nonce: string, development = false): string {
  const scriptSources = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
  if (development) scriptSources.push("'unsafe-eval'");
  // Next stamps this nonce onto the <style> and <link> tags it renders itself, so production
  // keeps inline styles gated on the nonce rather than opened up. The dev server additionally
  // injects its error overlay and Fast Refresh styles, which it cannot nonce — under the shipped
  // policy those were blocked and the Console rendered unstyled.
  //
  // The two allowances cannot be combined: a directive that carries a nonce makes browsers ignore
  // 'unsafe-inline' entirely (CSP2+), so the development policy drops the nonce for styles instead
  // of adding to it. This mirrors how script-src already gains 'unsafe-eval' only in development.
  const styleSources =
    development && DEVELOPMENT_INLINE_STYLE_ALLOWANCE !== ""
      ? ["'self'", DEVELOPMENT_INLINE_STYLE_ALLOWANCE]
      : ["'self'", `'nonce-${nonce}'`];
  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    `style-src ${styleSources.join(" ")}`,
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");
}

export function consoleResponseSecurityHeaders(production: boolean) {
  return [
    { key: "Referrer-Policy", value: REFERRER_POLICY },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
    ...(production ? [{ key: "Strict-Transport-Security", value: STRICT_TRANSPORT_SECURITY }] : []),
  ] as const;
}
