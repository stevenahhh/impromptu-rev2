import { describe, expect, test } from "bun:test";
import { proxyDeckAsset } from "./deck-asset-proxy";

describe("Console same-origin deck asset proxy", () => {
  test("fetches only a normalized public asset path without forwarding browser authority", async () => {
    let observedInit: RequestInit | undefined;
    const request = new Request(
      "http://localhost:4173/v1/deck-assets/manifest/slides/slide-1.svg",
      {
        headers: {
          cookie: "__Host-account=private-session",
          origin: "http://localhost:4173",
          "x-csrf-token": "private-csrf",
        },
      },
    );

    const response = await proxyDeckAsset(
      request,
      ["manifest", "slides", "slide-1.svg"],
      async (target, init) => {
        expect(String(target)).toBe(
          "http://127.0.0.1:3002/v1/deck-assets/manifest/slides/slide-1.svg",
        );
        observedInit = init;
        return new Response("<svg/>", {
          headers: {
            "content-type": "image/svg+xml",
            "set-cookie": "public=unexpected",
          },
        });
      },
    );

    expect(response.status).toBe(200);
    expect(new Headers(observedInit?.headers).has("cookie")).toBe(false);
    expect(new Headers(observedInit?.headers).has("origin")).toBe(false);
    expect(new Headers(observedInit?.headers).has("x-csrf-token")).toBe(false);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.has("set-cookie")).toBe(false);
  });

  test("rejects traversal-shaped and mutating requests before upstream fetch", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return new Response();
    };
    const traversal = await proxyDeckAsset(
      new Request("http://localhost/v1/deck-assets/x/%2e%2e/secret"),
      ["x", "..", "secret"],
      fetcher,
    );
    const mutation = await proxyDeckAsset(
      new Request("http://localhost/v1/deck-assets/x/slides/a.svg", { method: "POST" }),
      ["x", "slides", "a.svg"],
      fetcher,
    );

    expect(traversal.status).toBe(404);
    expect(mutation.status).toBe(405);
    expect(calls).toBe(0);
  });
});
