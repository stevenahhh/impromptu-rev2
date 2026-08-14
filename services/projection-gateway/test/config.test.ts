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

  test("requires a Stage origin and a valid port", () => {
    expect(() => parseProjectionGatewayConfig({})).toThrow("STAGE_ORIGIN is required");
    expect(() =>
      parseProjectionGatewayConfig({
        PROJECTION_GATEWAY_PORT: "65536",
        STAGE_ORIGIN: "https://stage.example.test",
      }),
    ).toThrow("PROJECTION_GATEWAY_PORT must be an integer between 1 and 65535");
  });
});
