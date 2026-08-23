import { describe, expect, test } from "bun:test";

import {
  stageGatewayProxyTarget,
  stagePublicApiOrigin,
  stageWebSocketOrigin,
} from "./vite-runtime-config";

describe("Stage public API build configuration", () => {
  test("addresses the page's own origin by default, in development and production alike", () => {
    // The audience session cookie is SameSite=Strict, so a cross-site Stage never keeps it.
    // Same-origin is therefore the default rather than an opt-in.
    expect(stagePublicApiOrigin({})).toBe("");
    expect(stagePublicApiOrigin({}, true)).toBe("");
    expect(stagePublicApiOrigin({ STAGE_PUBLIC_API_ORIGIN: "" }, true)).toBe("");
    expect(stagePublicApiOrigin({ STAGE_PUBLIC_API_ORIGIN: "   " }, true)).toBe("");
  });

  test("still validates an explicit override", () => {
    expect(() =>
      stagePublicApiOrigin({ STAGE_PUBLIC_API_ORIGIN: "http://gateway.example.test" }, true),
    ).toThrow("STAGE_PUBLIC_API_ORIGIN must use https for a production build");
    expect(
      stagePublicApiOrigin({ STAGE_PUBLIC_API_ORIGIN: "https://gateway.example.test" }, true),
    ).toBe("https://gateway.example.test");
    expect(stagePublicApiOrigin({ STAGE_PUBLIC_API_ORIGIN: "http://127.0.0.1:3002" }, true)).toBe(
      "http://127.0.0.1:3002",
    );
    expect(() =>
      stagePublicApiOrigin({ STAGE_PUBLIC_API_ORIGIN: "https://gateway.example.test/v1" }),
    ).toThrow("STAGE_PUBLIC_API_ORIGIN must be an absolute HTTP(S) origin");
  });

  test("keeps the server-side proxy hop separate from the browser-visible origin", () => {
    expect(stageGatewayProxyTarget({})).toBe("http://127.0.0.1:3002");
    expect(
      stageGatewayProxyTarget({ PROJECTION_GATEWAY_ORIGIN: "http://gateway.internal:3002" }),
    ).toBe("http://gateway.internal:3002");
    // The browser keeps addressing its own origin even though the gateway listens elsewhere.
    expect(
      stagePublicApiOrigin({ PROJECTION_GATEWAY_ORIGIN: "http://gateway.internal:3002" }),
    ).toBe("");
  });

  test("derives the realtime origin, and defers to CSP 'self' when same-origin", () => {
    expect(stageWebSocketOrigin("https://gateway.example.test")).toBe("wss://gateway.example.test");
    expect(stageWebSocketOrigin("")).toBe("");
  });
});
