import { describe, expect, test } from "bun:test";

import { proxyPrivateApi } from "./private-api-proxy";

describe("Console Next.js private API proxy", () => {
  test("preserves mutation origin, referer, cookie, and CSRF headers", async () => {
    let observedHeaders = new Headers();
    const request = new Request("http://localhost:4173/v1/deck-uploads?mode=test", {
      method: "POST",
      headers: {
        cookie: "__Host-account=session",
        origin: "http://localhost:4173",
        referer: "http://localhost:4173/",
        "x-csrf-token": "csrf",
      },
      body: "deck",
    });

    const response = await proxyPrivateApi(request, ["deck-uploads"], async (target, init) => {
      observedHeaders = new Headers(init?.headers);
      expect(String(target)).toBe("http://127.0.0.1:3001/v1/deck-uploads?mode=test");
      return new Response("accepted", { status: 201 });
    });

    expect(response.status).toBe(201);
    expect(observedHeaders.get("origin")).toBe("http://localhost:4173");
    expect(observedHeaders.get("referer")).toBe("http://localhost:4173/");
    expect(observedHeaders.get("cookie")).toBe("__Host-account=session");
    expect(observedHeaders.get("x-csrf-token")).toBe("csrf");
  });
});
