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

describe("Stage network client", () => {
  test("subscribes to exact playback/card events before sending an applied receipt", async () => {
    const source = new FakeEventSource();
    const recoveredSource = new FakeEventSource();
    const sources = [source, recoveredSource];
    const factory: EventSourceFactory = () => {
      const next = sources.shift();
      if (next === undefined) throw new Error("unexpected EventSource creation");
      return next;
    };
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
    const channelEvents: string[] = [];
    const subscriptionPromise = client.subscribe({
      onPlayback(event) {
        playbackEvents.push(event.commandId);
      },
      onCard(event) {
        cardEvents.push(`${event.publicCardRevision}:${event.status}`);
      },
      onClose(reason) {
        channelEvents.push(`close:${reason}`);
      },
      onOpen() {
        channelEvents.push("open");
      },
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
    source.dispatchEvent(new Event("error"));
    expect(source.closed).toBe(true);
    recoveredSource.dispatchEvent(new Event("open"));
    expect(channelEvents).toEqual(["close:NETWORK_ERROR", "open"]);
    subscription.close();
    expect(recoveredSource.closed).toBe(true);
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
