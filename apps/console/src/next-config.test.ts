import { describe, expect, test } from "bun:test";

import { consoleDeckAssetOrigin, consolePrivateApiOrigin } from "./next-runtime-config";

describe("Console Next.js private API boundary", () => {
  test("uses the local private backend only outside production", () => {
    expect(consolePrivateApiOrigin({})).toBe("http://127.0.0.1:3001");
    expect(consolePrivateApiOrigin({ CONSOLE_PRIVATE_API_ORIGIN: " " })).toBe(
      "http://127.0.0.1:3001",
    );
  });

  test("keeps deck assets on a configurable server-to-server origin", () => {
    expect(consoleDeckAssetOrigin({})).toBe("http://127.0.0.1:3002");
    expect(
      consoleDeckAssetOrigin({ CONSOLE_DECK_ASSET_ORIGIN: "http://projection-gateway:3002" }),
    ).toBe("http://projection-gateway:3002");
    expect(() =>
      consoleDeckAssetOrigin({ CONSOLE_DECK_ASSET_ORIGIN: "http://projection-gateway:3002/path" }),
    ).toThrow("CONSOLE_DECK_ASSET_ORIGIN must be an absolute HTTP(S) origin");
  });

  test("requires an explicit HTTPS origin in production", () => {
    expect(() => consolePrivateApiOrigin({ NODE_ENV: "production" })).toThrow(
      "CONSOLE_PRIVATE_API_ORIGIN is required when NODE_ENV=production",
    );
    expect(() =>
      consolePrivateApiOrigin({
        CONSOLE_PRIVATE_API_ORIGIN: "http://private.example.test",
        NODE_ENV: "production",
      }),
    ).toThrow("CONSOLE_PRIVATE_API_ORIGIN must use https in production");
    expect(
      consolePrivateApiOrigin({
        CONSOLE_PRIVATE_API_ORIGIN: "https://private.example.test",
        NODE_ENV: "production",
      }),
    ).toBe("https://private.example.test");
    expect(
      consolePrivateApiOrigin({
        CONSOLE_PRIVATE_API_ORIGIN: "http://127.0.0.1:3001",
        NODE_ENV: "production",
      }),
    ).toBe("http://127.0.0.1:3001");
    // The Compose application network keeps the server-side proxy on the internal service name.
    expect(
      consolePrivateApiOrigin({
        CONSOLE_PRIVATE_API_ORIGIN: "http://private-backend:3001",
        NODE_ENV: "production",
      }),
    ).toBe("http://private-backend:3001");
    expect(() =>
      consolePrivateApiOrigin({
        CONSOLE_PRIVATE_API_ORIGIN: "http://other-service:3001",
        NODE_ENV: "production",
      }),
    ).toThrow("CONSOLE_PRIVATE_API_ORIGIN must use https in production");
  });

  test("rejects URLs that are not exact origins", () => {
    for (const value of [
      "private.example.test",
      "https://private.example.test/path",
      "https://private.example.test/",
    ]) {
      expect(() => consolePrivateApiOrigin({ CONSOLE_PRIVATE_API_ORIGIN: value })).toThrow(
        "CONSOLE_PRIVATE_API_ORIGIN must be an absolute HTTP(S) origin",
      );
    }
  });

  test("audio capture traffic bypasses the serverless proxy through an edge rewrite", async () => {
    // Vercel buffers text/event-stream bodies from a Node route handler until the upstream
    // stream closes (observed 2026-09-28: GET /v1/audio/events delivered READY, heartbeats,
    // and TERMINAL in one burst at close, so the browser never saw READY inside its 10s
    // window and no /v1/audio/frames request ever fired). Vercel edge rewrites stream the
    // upstream body; routing /v1/audio/* through one keeps the __Host-capture cookie
    // same-origin while every non-audio /v1 path still reaches the route handler proxy.
    const previousOrigin = process.env.CONSOLE_PRIVATE_API_ORIGIN;
    process.env.CONSOLE_PRIVATE_API_ORIGIN = "https://private.example.test";
    try {
      const { default: config } = await import("../next.config");
      const declared = await config.rewrites?.();
      const rewrites = Array.isArray(declared) ? declared : (declared?.afterFiles ?? []);
      const audio = rewrites.filter((rewrite) => rewrite.source.startsWith("/v1/audio"));
      expect(audio).toEqual([
        {
          source: "/v1/audio/:path*",
          destination: "https://private.example.test/v1/audio/:path*",
        },
      ]);
      // No broader rewrite may shadow the route handler that serves every other /v1 path.
      expect(
        rewrites.some(
          (rewrite) => !rewrite.source.startsWith("/v1/audio") && rewrite.source.includes("/v1"),
        ),
      ).toBe(false);
    } finally {
      if (previousOrigin === undefined) delete process.env.CONSOLE_PRIVATE_API_ORIGIN;
      else process.env.CONSOLE_PRIVATE_API_ORIGIN = previousOrigin;
    }
  });
});
