const host = "127.0.0.1";
const port = Number(process.env.TOPOLOGY_PROJECTION_PORT ?? "44402");
// The Stage verifies every vector slide's bytes against imageContentHash before mounting and
// reports SLIDE_FAILED instead of READY on mismatch. The old fixture advertised
// /assets/slide-N.svg (answered with index.html) plus a fabricated hash, so every slide failed.
// Serve real SVG bytes on the same-origin /v1/ proxy path with their actual digests.
const topologySlideAssets = await Promise.all(
  ["slide_public_1", "slide_public_2", "slide_public_3"].map(async (publicSlideKey, index) => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
      '<rect width="1280" height="720" fill="#101418"/>' +
      '<text x="64" y="160" font-size="96" fill="#ffffff">Public slide ' +
      String(index + 1) +
      "</text></svg>";
    const bytes = new TextEncoder().encode(svg);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const contentHash = Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    return { publicSlideKey, ordinal: index + 1, bytes, contentHash };
  }),
);
const publicSlides = topologySlideAssets.map((asset) => asset.publicSlideKey);
let joinSequence = 0;
const sockets = new Set<Bun.ServerWebSocket<Record<never, never>>>();

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

const server = Bun.serve<Record<never, never>, Record<never, never>>({
  hostname: host,
  port,
  async fetch(request, bunServer) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/__test/close-channels") {
      for (const socket of sockets) {
        socket.send(JSON.stringify({ kind: "CLOSE", payload: { reason: "SERVER_RESTART" } }));
      }
      return json({ closedChannels: sockets.size });
    }
    if (request.method === "POST" && url.pathname === "/__test/shutdown") {
      queueMicrotask(() => void server.stop(true));
      return json({ status: "stopping" }, 202);
    }
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
        publicationPolicyVersion: null,
        publicCardRevision: "pcr_0",
        tombstoneWatermark: "pcr_0",
        tombstoneRetentionMs: 60_000,
        occurrence: { publicSlideKey: publicSlides[0], occurrenceSeq: 1 },
        blackout: false,
        deck: {
          deckVersion: "deck_topology",
          manifestHash: "manifest_topology",
          slides: topologySlideAssets.map((asset, index) => ({
            publicSlideKey: asset.publicSlideKey,
            ordinal: index + 1,
            accessibilityLabel: `Public slide ${index + 1}`,
            image: {
              url: `/v1/deck-assets/topology/slides/slide-${asset.ordinal}.svg`,
              contentHash: asset.contentHash,
            },
          })),
        },
        // Slide-only projection: the Stage rejects any snapshot that carries card or tombstone
        // state, so this fixture must present both as permanently empty.
        cards: [],
        tombstones: [],
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
    if (request.method === "GET" && url.pathname.startsWith("/v1/deck-assets/")) {
      const ordinal = Number(url.pathname.match(/slide-(\d+)\.svg$/)?.[1] ?? "0");
      const slideAsset = topologySlideAssets.find((asset) => asset.ordinal === ordinal);
      if (slideAsset === undefined) return json({ error: "not_found" }, 404);
      return new Response(slideAsset.bytes, {
        headers: { "content-type": "image/svg+xml", "cache-control": "no-store" },
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
  websocket: {
    open(socket) {
      sockets.add(socket);
    },
    message() {},
    close(socket) {
      sockets.delete(socket);
    },
  },
});

console.log(`topology-projection-fixture listening on ${server.url}`);

// Module marker: the top-level await that builds slide assets requires this file to be a module.
export {};
