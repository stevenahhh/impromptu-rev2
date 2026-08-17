import { afterAll, describe, expect, test } from "bun:test";
import { createServer as reserveTcpPort } from "node:net";
import { resolve } from "node:path";

import {
  createServer as createViteDevServer,
  loadConfigFromFile,
  type PreviewServer,
  preview,
  type ViteDevServer,
} from "vite";

import { consolePrivateApiOrigin } from "../vite.config";

const appRoot = resolve(import.meta.dir, "..");
const configPath = resolve(appRoot, "vite.config.ts");
const DEFAULT_PRIVATE_API_ORIGIN = "http://127.0.0.1:3001";

interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly host: string | null;
  readonly origin: string | null;
  readonly referer: string | null;
  readonly cookie: string | null;
  readonly csrf: string | null;
  readonly body: string;
}

async function availablePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const probe = reserveTcpPort();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address === null || typeof address === "string") {
          reject(new Error("port probe did not yield a TCP port"));
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

async function captureStub() {
  let captured: CapturedRequest | null = null;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      captured = {
        method: request.method,
        path: url.pathname,
        host: request.headers.get("host"),
        origin: request.headers.get("origin"),
        referer: request.headers.get("referer"),
        cookie: request.headers.get("cookie"),
        csrf: request.headers.get("x-csrf-token"),
        body: await request.text(),
      };
      return Response.json({ proxied: true });
    },
  });
  return {
    server,
    origin: `http://127.0.0.1:${server.port}`,
    readCaptured: () => captured,
  };
}

function sameOriginApiBody(headers: HeadersInit, origin: string): RequestInit {
  return {
    method: "POST",
    headers: {
      origin,
      referer: `${origin}/`,
      cookie: "__Host-account=smoke-account",
      "x-csrf-token": "smoke-csrf",
      ...headers,
    },
    body: JSON.stringify({ filename: "deck.pptx", byteLength: 12 }),
  };
}

async function assertProxiedSameOrigin(
  stub: Awaited<ReturnType<typeof captureStub>>,
  origin: string,
): Promise<void> {
  const response = await fetch(
    `${origin}/v1/deck-uploads`,
    sameOriginApiBody({ "content-type": "application/json" }, origin),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ proxied: true });

  const captured = stub.readCaptured();
  if (captured === null) throw new Error("stub backend received no proxied request");
  expect(captured).toMatchObject({
    method: "POST",
    path: "/v1/deck-uploads",
    origin,
    referer: `${origin}/`,
    cookie: "__Host-account=smoke-account",
    csrf: "smoke-csrf",
    body: JSON.stringify({ filename: "deck.pptx", byteLength: 12 }),
  });
  // Host is forwarded untouched so the backend sees the browser's same-origin
  // authority, never the private backend's own host.
  expect(captured.host).toBe(new URL(origin).host);
  expect(captured.host).not.toBe(new URL(stub.origin).host);
}

describe("console /v1 proxy configuration", () => {
  test("defaults CONSOLE_PRIVATE_API_ORIGIN to the local private backend", () => {
    expect(consolePrivateApiOrigin({})).toBe(DEFAULT_PRIVATE_API_ORIGIN);
    expect(consolePrivateApiOrigin({ CONSOLE_PRIVATE_API_ORIGIN: "" })).toBe(
      DEFAULT_PRIVATE_API_ORIGIN,
    );
    expect(consolePrivateApiOrigin({ CONSOLE_PRIVATE_API_ORIGIN: "http://127.0.0.1:45999" })).toBe(
      "http://127.0.0.1:45999",
    );
  });

  test("maps /v1 to CONSOLE_PRIVATE_API_ORIGIN in dev and preview with Host untouched", async () => {
    const backendOrigin = "http://127.0.0.1:45999";
    process.env.CONSOLE_PRIVATE_API_ORIGIN = backendOrigin;
    try {
      const loaded = await loadConfigFromFile(
        { command: "serve", mode: "development" },
        configPath,
        appRoot,
        "silent",
      );
      expect(loaded).not.toBeNull();
      const config = loaded?.config ?? {};
      const proxyTables = [config.server?.proxy, config.preview?.proxy];
      for (const proxyTable of proxyTables) {
        const route = proxyTable?.["/v1"];
        expect(typeof route).toBe("object");
        expect(route).toEqual({ target: backendOrigin, changeOrigin: false });
      }
    } finally {
      delete process.env.CONSOLE_PRIVATE_API_ORIGIN;
    }
  });

  test("dev server forwards same-origin /v1/deck-uploads with Origin/Host preserved", async () => {
    const stub = await captureStub();
    process.env.CONSOLE_PRIVATE_API_ORIGIN = stub.origin;
    let dev: ViteDevServer | undefined;
    try {
      const loaded = await loadConfigFromFile(
        { command: "serve", mode: "development" },
        configPath,
        appRoot,
        "silent",
      );
      const devPort = await availablePort();
      dev = await createViteDevServer({
        ...(loaded?.config ?? {}),
        configFile: false,
        root: appRoot,
        logLevel: "silent",
        optimizeDeps: { noDiscovery: true },
        server: {
          ...(loaded?.config.server ?? {}),
          host: "127.0.0.1",
          port: devPort,
          strictPort: true,
        },
      });
      await dev.listen();
      const localUrl = dev.resolvedUrls?.local?.[0];
      if (localUrl === undefined) throw new Error("dev server did not publish a local URL");
      await assertProxiedSameOrigin(stub, localUrl.replace(/\/$/, ""));
    } finally {
      if (dev !== undefined) await dev.close();
      stub.server.stop(true);
      delete process.env.CONSOLE_PRIVATE_API_ORIGIN;
    }
  });

  test("preview server forwards same-origin /v1/deck-uploads with Origin/Host preserved", async () => {
    const stub = await captureStub();
    process.env.CONSOLE_PRIVATE_API_ORIGIN = stub.origin;
    let previewServer: PreviewServer | undefined;
    try {
      const loaded = await loadConfigFromFile(
        { command: "build", mode: "production" },
        configPath,
        appRoot,
        "silent",
      );
      previewServer = await preview({
        ...(loaded?.config ?? {}),
        configFile: false,
        root: appRoot,
        logLevel: "silent",
        preview: {
          ...(loaded?.config.preview ?? {}),
          host: "127.0.0.1",
          port: 0,
        },
      });
      const localUrl = previewServer.resolvedUrls?.local?.[0];
      if (localUrl === undefined) throw new Error("preview server did not publish a local URL");
      await assertProxiedSameOrigin(stub, localUrl.replace(/\/$/, ""));
    } finally {
      if (previewServer !== undefined) {
        await new Promise<void>((done) => previewServer?.httpServer.close(() => done()));
      }
      stub.server.stop(true);
      delete process.env.CONSOLE_PRIVATE_API_ORIGIN;
    }
  });
});

afterAll(() => {
  delete process.env.CONSOLE_PRIVATE_API_ORIGIN;
});
