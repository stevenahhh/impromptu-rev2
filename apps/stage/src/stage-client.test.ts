import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  createStageSessionClient,
  type EventSourceFactory,
  type WebSocketFactory,
} from "./stage-client";

class FakeEventSource extends EventTarget {
  closed = false;
  close() {
    this.closed = true;
  }
}

class FakeWebSocket extends EventTarget {
  closed = false;
  readyState = 1;
  readonly sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function absoluteState(cards: unknown[] = []) {
  return {
    role: "PUBLIC_STAGE",
    presentationSessionId: "ps_alpha",
    presentationSessionEpoch: "pse_1",
    displayBindingEpoch: "dbe_1",
    publicPlaybackRevision: "pbr_0",
    publicCardRevision: "pcr_0",
    publicationPolicyVersion: null,
    deck: {
      deckVersion: "deck_alpha",
      manifestHash: "b".repeat(64),
      title: "Deck",
      slides: [
        {
          publicSlideKey: "slide_one",
          ordinal: 1,
          image: {
            url: "https://public.test/one.png",
            contentHash: "c".repeat(64),
            width: 1920,
            height: 1080,
          },
          accessibilityLabel: "One",
        },
      ],
    },
    occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
    blackout: false,
    cards,
    tombstones: [],
    tombstoneWatermark: "pcr_0",
    tombstoneRetentionMs: 60_000,
  };
}

async function hashed(value: ReturnType<typeof absoluteState>) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  const stateHash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return { ...value, stateHash };
}

const injectedCard = {
  projectionId: "projection_curated",
  status: "PUBLISHED",
  mode: "CURATED",
  claim: "CARD SENTINEL",
  supportSummary: "SUPPORT SENTINEL",
  sourceLabel: "SOURCE SENTINEL",
  publishedAtMs: 1_000,
  expiresAtMs: null,
  publicCardRevision: "pcr_1",
  deckVersion: "deck_alpha",
  manifestHash: "b".repeat(64),
  occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
};

const playback = {
  commandId: "cmd_alpha",
  presentationSessionEpoch: "pse_1",
  displayBindingEpoch: "dbe_1",
  acceptedControlRevision: "cr_1",
  publicPlaybackRevision: "pbr_1",
  occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 2 },
  blackout: false,
};

describe("Stage slide-only network client", () => {
  test("accepts only snapshots whose card and tombstone arrays are empty", async () => {
    const valid = await hashed(absoluteState());
    const fetchMock = mock(
      async () =>
        new Response(JSON.stringify(valid), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect });
    const snapshot = await createStageSessionClient("https://projection.example.test").snapshot();
    expect(snapshot).not.toHaveProperty("cards");
    expect(snapshot.publicPlaybackRevision).toBe("pbr_0");

    const malicious = await hashed(absoluteState([injectedCard]));
    const maliciousFetch = mock(
      async () =>
        new Response(JSON.stringify(malicious), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = Object.assign(maliciousFetch, { preconnect: originalFetch.preconnect });
    await expect(
      createStageSessionClient("https://projection.example.test").snapshot(),
    ).rejects.toThrow("Public snapshot is unavailable.");
  });

  test("drops CARD envelopes injected into SSE while preserving playback", async () => {
    const source = new FakeEventSource();
    const factory: EventSourceFactory = () => source;
    const commands: string[] = [];
    const client = createStageSessionClient("https://projection.example.test", factory);
    const subscriptionPromise = client.subscribe({
      onPlayback(event) {
        commands.push(event.commandId);
      },
      onClose() {},
    });
    source.dispatchEvent(new Event("open"));
    const subscription = await subscriptionPromise;
    source.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ kind: "CARD", payload: injectedCard }),
      }),
    );
    source.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ kind: "PLAYBACK", payload: playback }),
      }),
    );
    expect(commands).toEqual(["cmd_alpha"]);
    subscription.close();
  });

  test("drops CARD envelopes injected into WebSocket while preserving commands and receipts", async () => {
    const source = new FakeWebSocket();
    const webSocketFactory: WebSocketFactory = () => source;
    const commands: string[] = [];
    const client = createStageSessionClient(
      "https://projection.example.test",
      () => new FakeEventSource(),
      webSocketFactory,
    );
    const subscriptionPromise = client.subscribeRealtime?.({
      onPlayback(event) {
        commands.push(event.commandId);
      },
      onClose() {},
    });
    if (subscriptionPromise === undefined) throw new Error("realtime extension missing");
    source.dispatchEvent(new Event("open"));
    const subscription = await subscriptionPromise;
    source.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ kind: "CARD", payload: injectedCard }),
      }),
    );
    source.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ kind: "COMMAND", payload: playback }),
      }),
    );
    expect(commands).toEqual(["cmd_alpha"]);
    subscription.recordApplied?.(playback);
    expect(source.sent).toEqual([
      JSON.stringify({
        kind: "STAGE_APPLIED",
        payload: { commandId: "cmd_alpha", displayBindingEpoch: "dbe_1" },
      }),
    ]);
    subscription.close();
  });
});
