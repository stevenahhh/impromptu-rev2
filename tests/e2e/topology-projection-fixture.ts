const host = "127.0.0.1";
const port = 44402;
const publicSlides = ["slide_public_1", "slide_public_2", "slide_public_3"];
let joinSequence = 0;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

const server = Bun.serve<Record<never, never>, Record<never, never>>({
  hostname: host,
  port,
  async fetch(request, bunServer) {
    const url = new URL(request.url);
    if (url.pathname === "/v1/realtime") {
      return bunServer.upgrade(request)
        ? undefined
        : new Response(JSON.stringify({ error: "upgrade_required" }), { status: 426 });
    }
    if (request.method === "POST" && url.pathname === "/v1/account-sessions") {
      return json(
        {
          account: { accountId: "account_co_resident", actorId: "actor_co_resident" },
          expiresAtMs: Date.now() + 60_000,
          csrfToken: "csrf-co-resident",
        },
        201,
      );
    }
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
      const absoluteState = {
        role: "PUBLIC_STAGE",
        presentationSessionId: "presentation_topology",
        presentationSessionEpoch: "pse_1",
        displayBindingEpoch: "dbe_1",
        deckVersion: "deck_topology",
        manifestHash: "manifest_topology",
        publicPlaybackRevision: "pbr_0",
        publicCardRevision: "pcr_0",
        tombstoneWatermark: "pcr_0",
        tombstoneRetentionMs: 60_000,
        occurrence: { publicSlideKey: publicSlides[0], occurrenceSeq: 1 },
        blackout: false,
        deck: {
          deckVersion: "deck_topology",
          manifestHash: "manifest_topology",
          slides: publicSlides.map((publicSlideKey, index) => ({
            publicSlideKey,
            ordinal: index + 1,
            accessibilityLabel: `Public slide ${index + 1}`,
            image: {
              url: `/assets/slide-${index + 1}.svg`,
              contentHash: `slide-hash-${index + 1}`,
            },
          })),
        },
        cards: [],
      };
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(absoluteState)),
      );
      const stateHash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      return json({ ...absoluteState, stateHash });
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
  websocket: {
    open() {},
    message() {},
    close() {},
  },
});

console.log(`topology-projection-fixture listening on ${server.url}`);
