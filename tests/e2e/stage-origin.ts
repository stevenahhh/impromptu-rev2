import { resolve } from "node:path";

const configuredGatewayOrigin = process.env.PROJECTION_GATEWAY_ORIGIN;
if (configuredGatewayOrigin === undefined) throw new Error("PROJECTION_GATEWAY_ORIGIN is required");
let gatewayOrigin: string = configuredGatewayOrigin;
const distributionRoot = resolve("apps/stage/dist");
const contentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

// Ambient @types/node typings omit Bun's documented client WebSocket options
// (https://bun.com/docs/api/websocket#headers); narrow the constructor here.
type BunClientWebSocketOptions = {
  protocols?: string | string[];
  headers?: Record<string, string>;
};
const ClientWebSocket = globalThis.WebSocket as new (
  url: string | URL,
  options?: BunClientWebSocketOptions,
) => WebSocket;

const forwardedHeaders = ["authorization", "cookie", "origin", "user-agent", "x-forwarded-for"];

function toUpstreamWebSocketUrl(origin: string, pathname: string, search: string): string {
  const target = new URL(`${origin}${pathname}${search}`);
  if (target.protocol === "https:") target.protocol = "wss:";
  else target.protocol = "ws:";
  return target.href;
}

type RealtimeProxySocketData = {
  upstream: WebSocket;
  upstreamReady: Promise<void>;
  downstreamBuffer: (string | Uint8Array)[];
  client: { send(data: string | Uint8Array): void } | null;
};

const server = Bun.serve<RealtimeProxySocketData, Record<never, never>>({
  hostname: "127.0.0.1",
  port: Number(process.env.TOPOLOGY_STAGE_PORT ?? "44274"),
  async fetch(request, localServer) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/__test/gateway") {
      const body: unknown = await request.json();
      if (
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body) ||
        typeof (body as Record<string, unknown>).origin !== "string"
      ) {
        return Response.json({ error: "invalid_origin" }, { status: 400 });
      }
      gatewayOrigin = (body as { origin: string }).origin;
      return Response.json({ status: "updated" });
    }
    const upgradeHeader = request.headers.get("upgrade");
    if (
      url.pathname.startsWith("/v1/") &&
      upgradeHeader?.toLowerCase() === "websocket" &&
      request.headers.get("connection")?.toLowerCase().includes("upgrade")
    ) {
      const protocols: string[] = (request.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((protocol) => protocol.trim())
        .filter((protocol) => protocol.length > 0);
      const headers: Record<string, string> = {};
      for (const name of forwardedHeaders) {
        const value = request.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      const upstream = new ClientWebSocket(
        toUpstreamWebSocketUrl(gatewayOrigin, url.pathname, url.search),
        protocols.length > 0 ? { protocols, headers } : { headers },
      );
      let signalUpstreamSettled!: () => void;
      const upstreamReady = new Promise<void>((resolveReady) => {
        signalUpstreamSettled = resolveReady;
      });
      upstream.addEventListener("open", signalUpstreamSettled, { once: true });
      upstream.addEventListener("error", signalUpstreamSettled, { once: true });
      upstream.addEventListener("close", signalUpstreamSettled, { once: true });
      const data: RealtimeProxySocketData = {
        upstream,
        upstreamReady,
        downstreamBuffer: [],
        client: null,
      };
      upstream.addEventListener("open", () => {
        for (const pending of data.downstreamBuffer) data.client?.send(pending);
        data.downstreamBuffer = [];
      });
      upstream.addEventListener("message", (event) => {
        const payload =
          typeof event.data === "string"
            ? event.data
            : event.data instanceof ArrayBuffer
              ? new Uint8Array(event.data)
              : new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
        if (data.client === null) data.downstreamBuffer.push(payload);
        else data.client.send(payload);
      });
      const upgraded = localServer.upgrade(request, { data });
      if (upgraded) console.log(`stage-origin relayed websocket upgrade ${url.pathname}`);
      else upstream.close();
      return upgraded
        ? undefined
        : Response.json({ error: "upstream_upgrade_failed" }, { status: 502 });
    }
    if (url.pathname.startsWith("/v1/")) {
      return fetch(`${gatewayOrigin}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: "manual",
      });
    }
    const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const candidate = Bun.file(resolve(distributionRoot, `.${requestedPath}`));
    const file = (await candidate.exists())
      ? candidate
      : Bun.file(resolve(distributionRoot, "index.html"));
    const extension = file.name?.match(/\.[^.]+$/)?.[0] ?? ".html";
    return new Response(file, {
      headers: {
        "content-type": contentTypes[extension] ?? "application/octet-stream",
        "content-security-policy":
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      },
    });
  },
  websocket: {
    async open(localSocket) {
      await localSocket.data.upstreamReady;
      if (localSocket.data.upstream.readyState !== WebSocket.OPEN) {
        localSocket.close(1014, "UPSTREAM_UNAVAILABLE");
        return;
      }
      localSocket.data.client = localSocket;
      for (const pending of localSocket.data.downstreamBuffer) localSocket.send(pending);
      localSocket.data.downstreamBuffer = [];
    },
    async message(localSocket, message) {
      await localSocket.data.upstreamReady;
      if (localSocket.data.upstream.readyState !== WebSocket.OPEN) return;
      localSocket.data.upstream.send(message);
    },
    close(localSocket) {
      localSocket.data.client = null;
      if (
        localSocket.data.upstream.readyState === WebSocket.OPEN ||
        localSocket.data.upstream.readyState === WebSocket.CONNECTING
      ) {
        localSocket.data.upstream.close();
      }
    },
  },
});

console.log(`stage-origin listening on ${server.url}`);
