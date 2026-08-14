import { afterEach, describe, expect, mock, test } from "bun:test";
import { signOfflineCard } from "./offline-signing.test-fixture";
import {
  createStageSessionClient,
  type EventSourceFactory,
  verifyOfflinePackage,
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

describe("Stage network client", () => {
  test("verifies a canonical curated package signed by the pinned key", async () => {
    const signed = await signOfflineCard({
      projectionId: "projection_signed",
      status: "PUBLISHED",
      mode: "CURATED",
      leaseExpiresAtMs: null,
      offlinePackage: {
        offlineDisplayAllowed: true,
        localExpiresAtMs: Date.now() + 60_000,
        signature: "",
        signatureVerified: false,
      },
      claim: "Signed claim",
      supportSummary: "May persist",
      sourceLabel: "Public source",
      publicCardRevision: "pcr_1",
    });
    const verified = await verifyOfflinePackage(signed);
    expect(verified.offlinePackage?.signatureVerified).toBe(true);
  });

  test("fails closed for an unverified curated offline package", async () => {
    const card = await verifyOfflinePackage({
      projectionId: "projection_unsigned",
      status: "PUBLISHED",
      mode: "CURATED",
      leaseExpiresAtMs: null,
      offlinePackage: {
        offlineDisplayAllowed: true,
        localExpiresAtMs: Date.now() + 60_000,
        signature: "not-a-valid-signature",
        signatureVerified: false,
      },
      claim: "Unsigned claim",
      supportSummary: "Must not persist",
      sourceLabel: "Public source",
      publicCardRevision: "pcr_1",
    });
    expect(card.offlinePackage?.signatureVerified).toBe(false);
  });

  test("filters live cards whose session, occurrence, policy, or card version is stale", async () => {
    const binding = {
      presentationSessionEpoch: "pse_1",
      publicSlideOccurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
      publicationPolicyVersion: "publication-policy-1",
      cardVersion: "card-version-1",
    };
    const liveCard = {
      projectionId: "projection_live",
      status: "PUBLISHED",
      mode: "LIVE",
      leaseExpiresAtMs: Date.now() + 2_000,
      publicationPolicyVersion: "publication-policy-1",
      cardVersion: "card-version-1",
      liveBinding: binding,
      claim: "Stale live claim",
      supportSummary: "Must remain hidden",
      sourceLabel: "Public source",
      publicCardRevision: "pcr_1",
    };
    const absoluteState = {
      role: "PUBLIC_STAGE",
      presentationSessionId: "ps_alpha",
      presentationSessionEpoch: "pse_2",
      displayBindingEpoch: "dbe_2",
      publicPlaybackRevision: "pbr_0",
      publicCardRevision: "pcr_4",
      publicationPolicyVersion: "publication-policy-2",
      deck: {
        deckVersion: "deck_alpha",
        manifestHash: "b".repeat(64),
        title: "Deck",
        slides: [
          {
            publicSlideKey: "slide_two",
            ordinal: 1,
            image: {
              url: "https://public.test/two.png",
              contentHash: "c".repeat(64),
              width: 1920,
              height: 1080,
            },
            accessibilityLabel: "Two",
          },
        ],
      },
      occurrence: { publicSlideKey: "slide_two", occurrenceSeq: 2 },
      blackout: false,
      cards: [
        liveCard,
        {
          ...liveCard,
          projectionId: "projection_occurrence",
          liveBinding: { ...binding, presentationSessionEpoch: "pse_2" },
        },
        {
          ...liveCard,
          projectionId: "projection_policy",
          liveBinding: {
            ...binding,
            presentationSessionEpoch: "pse_2",
            publicSlideOccurrence: { publicSlideKey: "slide_two", occurrenceSeq: 2 },
          },
        },
        {
          ...liveCard,
          projectionId: "projection_card_version",
          publicationPolicyVersion: "publication-policy-2",
          cardVersion: "card-version-2",
          liveBinding: {
            ...binding,
            presentationSessionEpoch: "pse_2",
            publicSlideOccurrence: { publicSlideKey: "slide_two", occurrenceSeq: 2 },
            publicationPolicyVersion: "publication-policy-2",
          },
        },
      ],
      tombstones: [],
      tombstoneWatermark: "pcr_0",
      tombstoneRetentionMs: 60_000,
    };
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(absoluteState)),
    );
    const stateHash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ ...absoluteState, stateHash }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect });

    const result = await createStageSessionClient("https://projection.example.test").snapshot();
    expect(result.cards).toEqual([]);
  });

  test("subscribes to exact playback/card events before sending an applied receipt", async () => {
    const source = new FakeEventSource();
    const factory: EventSourceFactory = () => source;
    const requests: string[] = [];
    const fetchMock = mock(async (input: string | URL | Request) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ status: "STAGE_APPLIED" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    globalThis.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect });
    const client = createStageSessionClient("https://projection.example.test", factory);
    const playbackEvents: string[] = [];
    const cardEvents: string[] = [];
    const subscriptionPromise = client.subscribe({
      onPlayback(event) {
        playbackEvents.push(event.commandId);
      },
      onCard(event) {
        cardEvents.push(`${event.publicCardRevision}:${event.status}`);
      },
      onClose() {},
    });
    source.dispatchEvent(new Event("open"));
    const subscription = await subscriptionPromise;
    source.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          kind: "PLAYBACK",
          payload: {
            commandId: "cmd_alpha",
            presentationSessionEpoch: "pse_1",
            displayBindingEpoch: "dbe_1",
            acceptedControlRevision: "cr_1",
            publicPlaybackRevision: "pbr_1",
            occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
            blackout: false,
          },
        }),
      }),
    );
    source.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          kind: "CARD",
          payload: {
            projectionId: "projection_alpha",
            status: "RETRACTED",
            publicCardRevision: "pcr_2",
            occurredAtMs: 2_000,
          },
        }),
      }),
    );
    expect(playbackEvents).toEqual(["cmd_alpha"]);
    expect(cardEvents).toEqual(["pcr_2:RETRACTED"]);
    await client.recordApplied({
      commandId: "cmd_alpha",
      presentationSessionEpoch: "pse_1",
      displayBindingEpoch: "dbe_1",
      acceptedControlRevision: "cr_1",
      publicPlaybackRevision: "pbr_1",
      occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
      blackout: false,
    });
    expect(requests).toEqual(["https://projection.example.test/v1/stage-applied"]);
    subscription.close();
    expect(source.closed).toBe(true);
  });

  test("receives commands and returns typed receipts over the realtime extension", async () => {
    const source = new FakeWebSocket();
    const webSocketFactory: WebSocketFactory = () => source;
    const client = createStageSessionClient(
      "https://projection.example.test",
      () => new FakeEventSource(),
      webSocketFactory,
    );
    const commands: string[] = [];
    const receipts: string[] = [];
    const protocolErrors: string[] = [];
    const subscriptionPromise = client.subscribeRealtime?.({
      onPlayback(event) {
        commands.push(event.commandId);
      },
      onCard() {},
      onReceipt(receipt) {
        receipts.push(receipt.commandId);
      },
      onProtocolError(code) {
        protocolErrors.push(code);
      },
      onClose() {},
    });
    if (subscriptionPromise === undefined) throw new Error("realtime extension missing");
    source.dispatchEvent(new Event("open"));
    const subscription = await subscriptionPromise;
    source.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          kind: "COMMAND",
          payload: {
            commandId: "cmd_realtime",
            presentationSessionEpoch: "pse_1",
            displayBindingEpoch: "dbe_1",
            acceptedControlRevision: "cr_1",
            publicPlaybackRevision: "pbr_1",
            occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 2 },
            blackout: false,
          },
        }),
      }),
    );
    expect(commands).toEqual(["cmd_realtime"]);
    subscription.recordApplied?.({
      commandId: "cmd_realtime",
      presentationSessionEpoch: "pse_1",
      displayBindingEpoch: "dbe_1",
      acceptedControlRevision: "cr_1",
      publicPlaybackRevision: "pbr_1",
      occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 2 },
      blackout: false,
    });
    expect(source.sent).toEqual([
      JSON.stringify({
        kind: "STAGE_APPLIED",
        payload: { commandId: "cmd_realtime", displayBindingEpoch: "dbe_1" },
      }),
    ]);
    source.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          kind: "RECEIPT",
          payload: {
            status: "STAGE_APPLIED",
            commandId: "cmd_realtime",
            presentationSessionEpoch: "pse_1",
            displayBindingEpoch: "dbe_1",
            publicPlaybackRevision: "pbr_1",
            appliedAtMs: 1_003,
          },
        }),
      }),
    );
    expect(receipts).toEqual(["cmd_realtime"]);
    source.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          kind: "ERROR",
          payload: { code: "STALE_DISPLAY_BINDING" },
        }),
      }),
    );
    expect(protocolErrors).toEqual(["STALE_DISPLAY_BINDING"]);
    subscription.close();
  });
});
