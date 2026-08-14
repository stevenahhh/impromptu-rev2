import { describe, expect, test } from "bun:test";
import { parseProjectionGatewayConfig } from "../src/config.ts";
import { createProjectionGatewayHandler } from "../src/http.ts";

const handler = createProjectionGatewayHandler(
  parseProjectionGatewayConfig({
    PROJECTION_GATEWAY_HOST: "127.0.0.1",
    PROJECTION_GATEWAY_PORT: "4102",
    STAGE_ORIGIN: "https://stage.example.test",
  }),
);

describe("projection gateway HTTP boundary", () => {
  test("serves only public service identity from health", async () => {
    const response = await handler(new Request("http://service.test/health"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ service: "projection-gateway", status: "ok" });
  });

  test("allows the exact Stage Origin", async () => {
    const response = await handler(
      new Request("http://service.test/health", {
        headers: { Origin: "https://stage.example.test" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://stage.example.test");
    expect(response.headers.get("vary")).toBe("Origin");
  });

  test("rejects sibling, prefix, and null Origins", async () => {
    for (const origin of [
      "https://stage.example.test.attacker.invalid",
      "https://attacker.invalid/https://stage.example.test",
      "null",
    ]) {
      const response = await handler(
        new Request("http://service.test/health", { headers: { Origin: origin } }),
      );

      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  test("does not expose an accidental catch-all route", async () => {
    const response = await handler(new Request("http://service.test/v1/private"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});
