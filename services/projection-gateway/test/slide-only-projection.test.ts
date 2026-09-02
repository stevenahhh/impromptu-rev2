import { describe, expect, test } from "bun:test";
import { PublishedDeckArtifactSchema } from "@impromptu/contracts/public";
import { type ExactOrigin, parseProjectionGatewayConfig } from "../src/config.ts";
import { createProjectionGatewayHandler } from "../src/http.ts";
import {
  createProjectionGatewayStore,
  PreparedEvidenceProjectionGateway,
  restoreProjectionGatewayStore,
  snapshotProjectionGatewayStore,
} from "../src/prepared-evidence.ts";
import { createProjectionRealtimeProtocol } from "../src/realtime.ts";

const origin = "https://stage.example.test" as ExactOrigin;
const deck = PublishedDeckArtifactSchema.parse({
  deckVersion: "deck_alpha",
  manifestHash: "a".repeat(64),
  title: "Slide-only deck",
  slides: [
    {
      publicSlideKey: "slide_one",
      ordinal: 1,
      image: {
        url: "https://public.example.test/one.png",
        contentHash: "b".repeat(64),
        width: 1920,
        height: 1080,
      },
      accessibilityLabel: "Slide one",
    },
  ],
});

function boundGateway() {
  const store = createProjectionGatewayStore();
  const gateway = new PreparedEvidenceProjectionGateway(store);
  const join = gateway.createDisplayJoin(
    {
      displayId: "display_alpha",
      deckVersion: deck.deckVersion,
      displayFingerprint: "fingerprint-stage-alpha",
    },
    1_000,
  );
  const bound = gateway.bindDisplay(
    {
      displayJoinId: join.displayJoinId,
      presentationSessionId: "ps_alpha",
      presentationSessionEpoch: "pse_1",
      expectedDisplayBindingEpoch: "dbe_0",
      expectedDeckVersion: deck.deckVersion,
      approvedDisplayId: join.displayId,
      approvedDisplayFingerprint: join.displayFingerprint,
      deck,
    },
    1_001,
  );
  if (bound.outcome !== "BOUND") throw new Error("fixture binding failed");
  return { gateway, session: bound.session, store };
}

async function nextServerEvent(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const timeout = AbortSignal.timeout(2_000);
  while (true) {
    const next = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timeout.addEventListener("abort", () => reject(new Error("SSE event timeout")), {
          once: true,
        });
      }),
    ]);
    if (next.done) throw new Error("SSE stream closed before event");
    const line = new TextDecoder().decode(next.value).trim();
    if (line.startsWith(":")) continue;
    if (!line.startsWith("data: ")) throw new Error(`invalid SSE frame: ${line}`);
    return JSON.parse(line.slice(6));
  }
}

const curatedCard = {
  projectionId: "projection_curated",
  status: "PUBLISHED",
  mode: "CURATED",
  claim: "Audience must never receive this claim",
  supportSummary: "Private presenter evidence",
  sourceLabel: "Private source",
  publishedAtMs: 1_002,
  expiresAtMs: null,
  publicCardRevision: "pcr_1",
  deckVersion: "deck_alpha",
  manifestHash: "a".repeat(64),
  occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
} as const;

const liveCard = {
  ...curatedCard,
  projectionId: "projection_live",
  mode: "LIVE",
  leaseExpiresAtMs: 3_002,
  expiresAtMs: 3_002,
  publicationPolicyVersion: "publication-policy-1",
  cardVersion: "card-version-1",
  liveBinding: {
    presentationSessionEpoch: "pse_1",
    displayBindingEpoch: "dbe_1",
    publicSlideOccurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
    publicationPolicyVersion: "publication-policy-1",
    cardVersion: "card-version-1",
  },
} as const;

describe("slide-only public projection", () => {
  test("discards legacy cards and tombstones while restoring snapshots", () => {
    const { session, store } = boundGateway();
    // The serializer output is cloned to model a malicious legacy database row.
    const persisted = snapshotProjectionGatewayStore(store);
    const input = structuredClone(persisted) as {
      projections: Array<{
        publicCardRevision: string;
        cards: unknown[];
        tombstones: unknown[];
        liveDisplayBindingEpochs: unknown[];
      }>;
    };
    const projection = input.projections[0];
    if (projection === undefined) throw new Error("projection fixture missing");
    projection.publicCardRevision = "pcr_2";
    projection.cards = [curatedCard];
    projection.tombstones = [
      {
        projectionId: "projection_old",
        status: "RETRACTED",
        publicCardRevision: "pcr_2",
        occurredAtMs: 1_003,
      },
    ];
    projection.liveDisplayBindingEpochs = [];

    const restored = restoreProjectionGatewayStore(input);
    expect(restored.outcome).toBe("RESTORED");
    if (restored.outcome !== "RESTORED") throw new Error("legacy snapshot was rejected");
    const restarted = new PreparedEvidenceProjectionGateway(restored.store);
    expect(restarted.snapshot(session.audienceDisplaySessionId, 1_004)).toMatchObject({
      publicCardRevision: "pcr_0",
      cards: [],
      tombstones: [],
    });
  });

  test("returns 410 for card ingress and queues no card on SSE or WebSocket", async () => {
    const { gateway, session } = boundGateway();
    const handler = createProjectionGatewayHandler(
      parseProjectionGatewayConfig({ STAGE_ORIGIN: origin }),
      {
        gateway,
        internalAuthToken: "internal-test-token-alpha",
        now: () => 1_002,
        stageReceiptWriter: {
          async recordApplied() {
            return null;
          },
        },
      },
    );
    const cookie = `__Host-display=${session.audienceDisplaySessionId}`;
    const stream = await handler(
      new Request("https://projection.example.test/v1/events", {
        headers: { cookie, origin },
      }),
    );
    const reader = stream.body?.getReader();
    if (reader === undefined) throw new Error("SSE response has no body");

    const sent: unknown[] = [];
    const protocol = createProjectionRealtimeProtocol({
      gateway,
      allowedOrigin: origin,
      now: () => 1_002,
      async recordApplied() {
        return null;
      },
    });
    const connection = protocol.connect(session.audienceDisplaySessionId, (message) =>
      sent.push(message),
    );
    if (connection === null) throw new Error("WebSocket fixture failed to connect");

    for (const event of [curatedCard, liveCard]) {
      const response = await handler(
        new Request("https://projection.example.test/internal/cards", {
          method: "POST",
          headers: {
            authorization: "Bearer internal-test-token-alpha",
            "content-type": "application/json",
          },
          body: JSON.stringify({ presentationSessionId: "ps_alpha", event }),
        }),
      );
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({ error: "stage_cards_disabled" });
    }

    expect(
      gateway.projectPlayback("ps_alpha", {
        commandId: "cmd_after_injection",
        displayBindingEpoch: "dbe_1",
        acceptedControlRevision: "cr_1",
        occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 2 },
        blackout: false,
      }),
    ).toBe(true);
    expect(await nextServerEvent(reader)).toMatchObject({
      kind: "PLAYBACK",
      payload: { commandId: "cmd_after_injection" },
    });
    expect(sent).toEqual([
      expect.objectContaining({
        kind: "COMMAND",
        payload: expect.objectContaining({ commandId: "cmd_after_injection" }),
      }),
    ]);
    expect(gateway.snapshot(session.audienceDisplaySessionId, 1_003)?.cards).toEqual([]);

    await reader.cancel();
    connection.close();
  });
});
