import type { MetricsRegistry } from "../observability.ts";
import type { PreparedEvidenceCoordinator } from "../prepared-evidence.ts";

export async function controllerEventStream(
  coordinator: PreparedEvidenceCoordinator,
  accountSessionId: string,
  presentationSessionId: string,
  nowMs: number,
  headers: Headers,
  metrics?: MetricsRegistry,
): Promise<Response> {
  let cancelled = false;
  let measured = false;
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const finish = () => {
    if (measured) metrics?.addRealtimeConnections(-1);
    measured = false;
  };
  const connected = await coordinator.connectPlaybackController(
    accountSessionId,
    presentationSessionId,
    nowMs,
    (reason) => {
      finish();
      if (!cancelled && streamController !== null) {
        streamController.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ kind: "CLOSE", payload: { reason } })}\n\n`,
          ),
        );
        streamController.close();
      }
    },
  );
  if (connected.outcome === "APPLIED") {
    measured = true;
    metrics?.addRealtimeConnections(1);
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      if (connected.outcome === "REJECTED") {
        controller.error(new Error(connected.reason));
        return;
      }
      controller.enqueue(new TextEncoder().encode(": ready\n\n"));
    },
    cancel() {
      cancelled = true;
      if (connected.outcome === "APPLIED") connected.value.close();
      finish();
    },
  });
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(body, { status: connected.outcome === "REJECTED" ? 409 : 200, headers });
}
