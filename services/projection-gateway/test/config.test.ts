import { describe, expect, test } from "bun:test";
import { parseProjectionGatewayConfig } from "../src/config.ts";

describe("projection gateway config", () => {
  test("parses a complete deployment environment", () => {
    const config = parseProjectionGatewayConfig({
      PROJECTION_GATEWAY_HOST: "127.0.0.1",
      PROJECTION_GATEWAY_PORT: "4102",
      STAGE_ORIGIN: "https://stage.example.test",
    });

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(4102);
    expect(String(config.allowedOrigin)).toBe("https://stage.example.test");
  });

  test("rejects a URL that is not exactly an origin", () => {
    expect(() =>
      parseProjectionGatewayConfig({
        STAGE_ORIGIN: "https://stage.example.test/path",
      }),
    ).toThrow("STAGE_ORIGIN must be an exact origin");
  });

  test("requires a Stage origin", () => {
    expect(() => parseProjectionGatewayConfig({})).toThrow("STAGE_ORIGIN is required");
  });

  test("accepts canonical decimal port boundaries", () => {
    for (const [value, expected] of [
      ["1", 1],
      ["4102", 4102],
      ["65535", 65_535],
    ] as const) {
      const config = parseProjectionGatewayConfig({
        PROJECTION_GATEWAY_PORT: value,
        STAGE_ORIGIN: "https://stage.example.test",
      });

      expect(config.port).toBe(expected);
    }
  });

  test("rejects out-of-range and non-canonical decimal ports", () => {
    for (const value of [
      "0",
      "65536",
      "+4102",
      "04102",
      "4.102e3",
      "0x1006",
      "4102.0",
      " 4102",
      "4102 ",
      "4102\n",
    ]) {
      expect(() =>
        parseProjectionGatewayConfig({
          PROJECTION_GATEWAY_PORT: value,
          STAGE_ORIGIN: "https://stage.example.test",
        }),
      ).toThrow("PROJECTION_GATEWAY_PORT must be an integer between 1 and 65535");
    }
  });

  test("rejects whitespace-bearing hosts and origins", () => {
    for (const host of [" ", "\t", "127.0.0.1 ", "127. 0.0.1"]) {
      expect(() =>
        parseProjectionGatewayConfig({
          PROJECTION_GATEWAY_HOST: host,
          STAGE_ORIGIN: "https://stage.example.test",
        }),
      ).toThrow("PROJECTION_GATEWAY_HOST must not contain whitespace");
    }

    for (const origin of [
      " https://stage.example.test",
      "https://stage.example.test ",
      "https://stage.example.test\n",
    ]) {
      expect(() => parseProjectionGatewayConfig({ STAGE_ORIGIN: origin })).toThrow(
        "STAGE_ORIGIN must be an exact origin",
      );
    }
  });
});
