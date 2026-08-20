import { describe, expect, test } from "bun:test";

import { stagePublicApiOrigin, stageWebSocketOrigin } from "./vite-runtime-config";

describe("Stage public API build configuration", () => {
  test("uses the local gateway only outside production", () => {
    expect(stagePublicApiOrigin({})).toBe("http://127.0.0.1:3002");
  });

  test("requires an explicit HTTPS origin for production builds", () => {
    expect(() => stagePublicApiOrigin({}, true)).toThrow(
      "STAGE_PUBLIC_API_ORIGIN is required for a production build",
    );
    expect(() =>
      stagePublicApiOrigin({ STAGE_PUBLIC_API_ORIGIN: "http://gateway.example.test" }, true),
    ).toThrow("STAGE_PUBLIC_API_ORIGIN must use https for a production build");
    expect(
      stagePublicApiOrigin({ STAGE_PUBLIC_API_ORIGIN: "https://gateway.example.test" }, true),
    ).toBe("https://gateway.example.test");
    expect(stagePublicApiOrigin({ STAGE_PUBLIC_API_ORIGIN: "http://127.0.0.1:3002" }, true)).toBe(
      "http://127.0.0.1:3002",
    );
  });

  test("rejects non-origin URLs and derives the realtime origin", () => {
    expect(() =>
      stagePublicApiOrigin({ STAGE_PUBLIC_API_ORIGIN: "https://gateway.example.test/v1" }),
    ).toThrow("STAGE_PUBLIC_API_ORIGIN must be an absolute HTTP(S) origin");
    expect(stageWebSocketOrigin("https://gateway.example.test")).toBe("wss://gateway.example.test");
  });
});
