import { describe, expect, test } from "bun:test";
import { parsePrivateBackendConfig } from "../src/config.ts";
import { createPrivateBackendHandler } from "../src/http.ts";

const handler = createPrivateBackendHandler(
  parsePrivateBackendConfig({
    PRIVATE_BACKEND_HOST: "127.0.0.1",
    PRIVATE_BACKEND_PORT: "4101",
    CONSOLE_ORIGIN: "https://console.example.test",
  }),
);

describe("private backend HTTP boundary", () => {
  test("serves a minimal health response without requiring a browser origin", async () => {
    const response = await handler(new Request("http://service.test/health"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ service: "private-backend", status: "ok" });
  });

  test("allows only the configured exact browser Origin", async () => {
    const allowed = await handler(
      new Request("http://service.test/health", {
        headers: { Origin: "https://console.example.test" },
      }),
    );
    const lookalike = await handler(
      new Request("http://service.test/health", {
        headers: { Origin: "https://console.example.test.attacker.invalid" },
      }),
    );

    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://console.example.test");
    expect(allowed.headers.get("vary")).toBe("Origin");
    expect(lookalike.status).toBe(403);
    expect(lookalike.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("returns a closed not-found response", async () => {
    const response = await handler(new Request("http://service.test/private-data"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});
