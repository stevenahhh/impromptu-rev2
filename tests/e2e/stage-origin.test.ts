import { describe, expect, test } from "bun:test";

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

function startMockGateway(): { port: number; close(): Promise<void> } {
  const server = Bun.serve<{ readonly kind: "gateway" }, Record<never, never>>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, localServer) {
      const url = new URL(request.url);
      if (url.pathname === "/v1/realtime") {
        if (request.headers.get("origin") !== "http://stage-origin.test") {
          return Response.json({ error: "ORIGIN_FORBIDDEN" }, { status: 403 });
        }
        const upgraded = localServer.upgrade(request, {
          data: { kind: "gateway" as const },
        });
        return upgraded ? undefined : Response.json({ error: "upgrade_required" }, { status: 426 });
      }
      return new Response(`sse-from-gateway:${url.pathname}`, { status: 200 });
    },
    websocket: {
      open(socket) {
        socket.send(JSON.stringify({ kind: "HELLO" }));
      },
      message(socket, message) {
        socket.send(
          typeof message === "string" ? `echo:${message}` : `echo-binary:${message.length}`,
        );
      },
    },
  });
  return { port: server.port ?? 0, close: () => server.stop(true) };
}

async function startStageOrigin(gatewayOrigin: string): Promise<{
  port: number;
  exited: Promise<number>;
  stop(): void;
}> {
  const child = Bun.spawn({
    cmd: ["bun", "run", "tests/e2e/stage-origin.ts"],
    env: {
      ...globalThis.process.env,
      PROJECTION_GATEWAY_ORIGIN: gatewayOrigin,
      TOPOLOGY_STAGE_PORT: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const listening = new Promise<number>((resolveListening, rejectListening) => {
    const timeout = setTimeout(
      () => rejectListening(new Error("stage-origin did not listen")),
      10_000,
    );
    void (async () => {
      const readable = (child.stdout as ReadableStream<Uint8Array>).getReader();
      const decode = new TextDecoder();
      for (;;) {
        const { value, done } = await readable.read();
        if (done) break;
        const match = decode.decode(value).match(/stage-origin listening on \S+:(\d+)/);
        if (match?.[1] !== undefined) {
          clearTimeout(timeout);
          resolveListening(Number(match[1]));
          return;
        }
      }
      clearTimeout(timeout);
      rejectListening(new Error("stage-origin exited before listening"));
    })().catch(rejectListening);
  });
  const port = await listening;
  return {
    port,
    exited: child.exited.then((code) => code ?? -1),
    stop() {
      child.kill();
    },
  };
}

describe("stage-origin proxy", () => {
  test("relays websocket upgrades to the gateway origin while preserving http forwarding", async () => {
    const gateway = startMockGateway();
    const stage = await startStageOrigin(`http://127.0.0.1:${gateway.port}`);
    try {
      let socket: WebSocket | null = null;
      try {
        socket = new ClientWebSocket(`ws://127.0.0.1:${stage.port}/v1/realtime`, {
          headers: { origin: "http://stage-origin.test", cookie: "display=abc" },
        });
        const opened = new Promise<void>((resolveOpen, rejectOpen) => {
          const timeout = setTimeout(() => rejectOpen(new Error("ws open timeout")), 5_000);
          socket?.addEventListener("open", () => {
            clearTimeout(timeout);
            resolveOpen();
          });
          socket?.addEventListener("error", () => {
            clearTimeout(timeout);
            rejectOpen(new Error("ws error before open"));
          });
        });
        await opened;

        const received: string[] = [];
        const probeEchoed = new Promise<string>((resolveMessage, rejectMessage) => {
          const timeout = setTimeout(() => rejectMessage(new Error("no frames received")), 5_000);
          socket?.addEventListener("message", (event) => {
            received.push(String(event.data));
            if (event.data === "echo:probe-frame") {
              clearTimeout(timeout);
              resolveMessage(String(event.data));
            }
          });
        });

        socket.send("probe-frame");

        const echo = await probeEchoed;
        expect(echo).toBe("echo:probe-frame");
        expect(received.some((frame) => frame.includes("HELLO"))).toBe(true);

        const forwarded = await fetch(`http://127.0.0.1:${stage.port}/v1/events`, {
          headers: { cookie: "display=abc" },
        });
        expect(forwarded.status).toBe(200);
        expect(await forwarded.text()).toBe("sse-from-gateway:/v1/events");
      } finally {
        socket?.close();
      }
    } finally {
      stage.stop();
      await gateway.close();
    }
  });
});
