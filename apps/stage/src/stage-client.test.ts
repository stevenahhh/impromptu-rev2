import { afterEach, describe, expect, mock, test } from "bun:test";
import { createStageSessionClient, type EventSourceFactory } from "./stage-client";

class FakeEventSource extends EventTarget {
  closed = false;

  close() {
    this.closed = true;
  }
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Stage network client", () => {
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
            displayBindingEpoch: "dbe_1",
            acceptedControlRevision: "cr_1",
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
      displayBindingEpoch: "dbe_1",
      acceptedControlRevision: "cr_1",
      occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
      blackout: false,
    });
    expect(requests).toEqual(["https://projection.example.test/v1/stage-applied"]);
    source.dispatchEvent(new Event("error"));
    expect(source.closed).toBe(false);
    source.dispatchEvent(new Event("open"));
    expect(channelEvents).toEqual(["close:NETWORK_ERROR", "open"]);
    subscription.close();
    expect(source.closed).toBe(true);
  });
});
