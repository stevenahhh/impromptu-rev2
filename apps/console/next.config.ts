import type { NextConfig } from "next";

const production = process.env.NODE_ENV === "production";
const privateApiOrigin = process.env.CONSOLE_PRIVATE_API_ORIGIN?.trim();
if (production && (privateApiOrigin === undefined || privateApiOrigin.length === 0)) {
  throw new Error("CONSOLE_PRIVATE_API_ORIGIN is required when NODE_ENV=production");
}
if (privateApiOrigin !== undefined && privateApiOrigin.length > 0) {
  const parsed = new URL(privateApiOrigin);
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.origin !== privateApiOrigin ||
    (production && parsed.protocol !== "https:" && !loopback)
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

const config: NextConfig = {
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
