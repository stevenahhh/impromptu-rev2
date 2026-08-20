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

export function consoleContentSecurityPolicy(nonce: string, development = false): string {
  const scriptSources = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
  if (development) scriptSources.push("'unsafe-eval'");
  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self'",
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
