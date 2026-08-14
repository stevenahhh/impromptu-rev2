const host = "127.0.0.1";
const port = 44402;
const publicSlides = ["slide_public_1", "slide_public_2", "slide_public_3"];
let joinSequence = 0;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

const server = Bun.serve({
  hostname: host,
  port,
  fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/v1/display-joins") {
      joinSequence += 1;
      return json(
        {
          displayJoinId: `join_${String(joinSequence).padStart(32, "0")}`,
          displayId: `display_${String(joinSequence).padStart(24, "0")}`,
          displayFingerprint: `stage-browser-${joinSequence}`,
          deckVersion: "deck_topology",
          expiresAtMs: Date.now() + 90_000,
        },
        201,
      );
    }
    if (request.method === "POST" && url.pathname === "/v1/display-session") {
      return json({ audienceDisplaySessionId: "display-session-topology" }, 201);
    }
    if (request.method === "GET" && url.pathname === "/v1/snapshot") {
      return json({
        publicCardRevision: "pcr_0",
        tombstoneWatermark: "pcr_0",
        tombstoneRetentionMs: 60_000,
        occurrence: { publicSlideKey: publicSlides[0], occurrenceSeq: 1 },
        deck: { slides: publicSlides.map((publicSlideKey) => ({ publicSlideKey })) },
        cards: [],
      });
    }
    if (request.method === "GET" && url.pathname === "/v1/events") {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(": ready\n\n"));
        },
      });
      return new Response(body, {
        headers: {
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "content-type": "text/event-stream",
        },
      });
    }
    if (request.method === "POST" && url.pathname === "/v1/stage-applied") {
      return json({ status: "STAGE_APPLIED" });
    }
    return json({ error: "not_found" }, 404);
  },
});

console.log(`topology-projection-fixture listening on ${server.url}`);
