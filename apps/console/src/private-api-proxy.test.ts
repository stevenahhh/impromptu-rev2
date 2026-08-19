import { describe, expect, test } from "bun:test";

import { proxyPrivateApi } from "./private-api-proxy";

describe("Console Next.js private API proxy", () => {
  test("forwards account registration without requiring session or CSRF headers", async () => {
    let observedHeaders = new Headers();
    const request = new Request("http://localhost:4173/v1/accounts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:4173",
        referer: "http://localhost:4173/sign-up",
      },
      body: JSON.stringify({ username: "presenter-new", password: "transient-password" }),
    });

    const response = await proxyPrivateApi(request, ["accounts"], async (target, init) => {
      observedHeaders = new Headers(init?.headers);
      expect(String(target)).toBe("http://127.0.0.1:3001/v1/accounts");
      return new Response(JSON.stringify({ account: { accountId: "account_new" } }), {
        status: 201,
      });
    });

    expect(response.status).toBe(201);
    expect(observedHeaders.get("origin")).toBe("http://localhost:4173");
    expect(observedHeaders.get("referer")).toBe("http://localhost:4173/sign-up");
    expect(observedHeaders.has("cookie")).toBe(false);
    expect(observedHeaders.has("x-csrf-token")).toBe(false);
  });

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
