import { describe, expect, test } from "bun:test";
import { parsePrivateBackendConfig } from "../src/config.ts";

describe("private backend config", () => {
  test("parses a complete deployment environment", () => {
    const config = parsePrivateBackendConfig({
      PRIVATE_BACKEND_HOST: "127.0.0.1",
      PRIVATE_BACKEND_PORT: "4101",
      CONSOLE_ORIGIN: "https://console.example.test",
    });

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(4101);
    expect(String(config.allowedOrigin)).toBe("https://console.example.test");
  });

  test("rejects missing or non-canonical origins", () => {
    expect(() => parsePrivateBackendConfig({ PRIVATE_BACKEND_PORT: "4101" })).toThrow(
      "CONSOLE_ORIGIN is required",
    );
    expect(() =>
      parsePrivateBackendConfig({
        PRIVATE_BACKEND_PORT: "4101",
        CONSOLE_ORIGIN: "https://console.example.test/",
      }),
    ).toThrow("CONSOLE_ORIGIN must be an exact origin");
  });

  test("rejects invalid ports", () => {
    expect(() =>
      parsePrivateBackendConfig({
        PRIVATE_BACKEND_PORT: "0",
        CONSOLE_ORIGIN: "https://console.example.test",
      }),
    ).toThrow("PRIVATE_BACKEND_PORT must be an integer between 1 and 65535");
  });
});
