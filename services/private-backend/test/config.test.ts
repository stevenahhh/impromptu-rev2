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

  test("accepts canonical decimal port boundaries", () => {
    for (const [value, expected] of [
      ["1", 1],
      ["4101", 4101],
      ["65535", 65_535],
    ] as const) {
      const config = parsePrivateBackendConfig({
        PRIVATE_BACKEND_PORT: value,
        CONSOLE_ORIGIN: "https://console.example.test",
      });

      expect(config.port).toBe(expected);
    }
  });

  test("rejects out-of-range and non-canonical decimal ports", () => {
    for (const value of [
      "0",
      "65536",
      "+4101",
      "04101",
      "4.101e3",
      "0x1005",
      "4101.0",
      " 4101",
      "4101 ",
      "4101\n",
    ]) {
      expect(() =>
        parsePrivateBackendConfig({
          PRIVATE_BACKEND_PORT: value,
          CONSOLE_ORIGIN: "https://console.example.test",
        }),
      ).toThrow("PRIVATE_BACKEND_PORT must be an integer between 1 and 65535");
    }
  });

  test("rejects whitespace-bearing hosts and origins", () => {
    for (const host of [" ", "\t", "127.0.0.1 ", "127. 0.0.1"]) {
      expect(() =>
        parsePrivateBackendConfig({
          PRIVATE_BACKEND_HOST: host,
          CONSOLE_ORIGIN: "https://console.example.test",
        }),
      ).toThrow("PRIVATE_BACKEND_HOST must not contain whitespace");
    }

    for (const origin of [
      " https://console.example.test",
      "https://console.example.test ",
      "https://console.example.test\n",
    ]) {
      expect(() => parsePrivateBackendConfig({ CONSOLE_ORIGIN: origin })).toThrow(
        "CONSOLE_ORIGIN must be an exact origin",
      );
    }
  });
});
