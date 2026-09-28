import type { NextConfig } from "next";

import { consolePrivateApiOrigin } from "./src/next-runtime-config";

const production = process.env.NODE_ENV === "production";
const privateApiOrigin = process.env.CONSOLE_PRIVATE_API_ORIGIN?.trim();
if (production && (privateApiOrigin === undefined || privateApiOrigin.length === 0)) {
  throw new Error("CONSOLE_PRIVATE_API_ORIGIN is required when NODE_ENV=production");
}
if (privateApiOrigin !== undefined && privateApiOrigin.length > 0) {
  const parsed = new URL(privateApiOrigin);
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  // The Compose service-name hop is cleartext inside the application network; browser-visible
  // hops still require HTTPS.
  const composeInternal = parsed.hostname === "private-backend" && parsed.protocol === "http:";
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.origin !== privateApiOrigin ||
    (production && parsed.protocol !== "https:" && !loopback && !composeInternal)
  ) {
    throw new Error("CONSOLE_PRIVATE_API_ORIGIN must be an exact HTTPS origin in production");
  }
}

const permissionsPolicy = [
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

// Audio capture must not traverse the Node route-handler proxy: on Vercel that function path
// buffers text/event-stream responses until the upstream stream closes, so the browser never
// receives READY inside its bounded wait and the capture dies before the first frame. A plain
// rewrite is answered by Vercel's edge proxy, which streams the upstream body. Plain (afterFiles)
// rewrites still win over the dynamic /v1/[...path] route handler, and the same-origin URL keeps
// the __Host-capture cookie and CSP connect-src 'self' intact. The destination is the same
// CONSOLE_PRIVATE_API_ORIGIN the proxy uses, resolved at build/boot time through the shared
// origin validator (which supplies the loopback default outside production).
const audioApiOrigin = consolePrivateApiOrigin();

const config: NextConfig = {
  ...(process.env.IMPROMPTU_NEXT_DIST_DIR ? { distDir: process.env.IMPROMPTU_NEXT_DIST_DIR } : {}),
  ...(process.env.IMPROMPTU_NEXT_TSCONFIG
    ? { typescript: { tsconfigPath: process.env.IMPROMPTU_NEXT_TSCONFIG } }
    : {}),
  async rewrites() {
    return [
      {
        source: "/v1/audio/:path*",
        destination: `${audioApiOrigin}/v1/audio/:path*`,
      },
    ];
  },
  experimental: {
    optimizePackageImports: ["@impromptu/ui"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Permissions-Policy", value: permissionsPolicy },
          ...(production
            ? [
                {
                  key: "Strict-Transport-Security",
                  value: "max-age=63072000; includeSubDomains; preload",
                },
              ]
            : []),
        ],
      },
    ];
  },
};

export default config;
