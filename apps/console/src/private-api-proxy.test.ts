import { describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";

import { proxyPrivateApi } from "./private-api-proxy";

describe("Console Next.js private API proxy", () => {
  test("delivers an early upstream rejection of a large upload body verbatim", async () => {
    // private-backend refuses oversized deck uploads from the content-length header alone,
    // answering 413 before the request body has been drained and tearing the stream down.
    // Whatever the transport does with the abandoned body, the presenter must receive the
    // backend's typed rejection instead of a gateway error.
    const server: Server = createServer((request, response) => {
      response.writeHead(413, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "deck_upload_rejected", code: "input_too_large" }));
      response.on("finish", () => request.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no ephemeral port");
    const previousOrigin = process.env.CONSOLE_PRIVATE_API_ORIGIN;
    process.env.CONSOLE_PRIVATE_API_ORIGIN = `http://127.0.0.1:${address.port}`;

    try {
      let chunksSent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          chunksSent += 1;
          if (chunksSent > 500) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(64 * 1024));
        },
      });
      const requestInit: RequestInit & { duplex: "half" } = {
        method: "POST",
        headers: {
          "content-type": "multipart/form-data; boundary=proxy-test",
          "content-length": String(200 * 1024 * 1024),
          cookie: "account=session",
          "x-csrf-token": "csrf",
          origin: "http://localhost:4173",
          referer: "http://localhost:4173/",
        },
        body,
        duplex: "half",
      };
      const request = new Request("http://localhost:4173/v1/deck-uploads", requestInit);

      const response = await proxyPrivateApi(request, ["deck-uploads"]);

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        error: "deck_upload_rejected",
        code: "input_too_large",
      });
    } finally {
      if (previousOrigin === undefined) delete process.env.CONSOLE_PRIVATE_API_ORIGIN;
      else process.env.CONSOLE_PRIVATE_API_ORIGIN = previousOrigin;
      server.close();
    }
  }, 20_000);

  test("forwards account registration without requiring session or CSRF headers", async () => {
    // The default dev target is asserted here, so the ambient compose origin must not leak in.
    const previousOrigin = process.env.CONSOLE_PRIVATE_API_ORIGIN;
    process.env.CONSOLE_PRIVATE_API_ORIGIN = "http://127.0.0.1:3001";
    try {
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
    } finally {
      if (previousOrigin === undefined) delete process.env.CONSOLE_PRIVATE_API_ORIGIN;
      else process.env.CONSOLE_PRIVATE_API_ORIGIN = previousOrigin;
    }
  });

  test("preserves mutation origin, referer, cookie, and CSRF headers", async () => {
    const previousOrigin = process.env.CONSOLE_PRIVATE_API_ORIGIN;
    process.env.CONSOLE_PRIVATE_API_ORIGIN = "http://127.0.0.1:3001";
    try {
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
    } finally {
      if (previousOrigin === undefined) delete process.env.CONSOLE_PRIVATE_API_ORIGIN;
      else process.env.CONSOLE_PRIVATE_API_ORIGIN = previousOrigin;
    }
  });
});
