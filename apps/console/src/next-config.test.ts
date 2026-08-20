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
});
