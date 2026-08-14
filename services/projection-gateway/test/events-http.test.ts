import { describe, expect, test } from "bun:test";
import { parseProjectionGatewayConfig } from "../src/config.ts";
import { createProjectionGatewayHandler } from "../src/http.ts";
import { PreparedEvidenceProjectionGateway } from "../src/prepared-evidence.ts";

const origin = "https://stage.example.test";
const deck = {
  deckVersion: "deck_alpha",
  manifestHash: "a".repeat(64),
  title: "Prepared deck",
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
};

async function nextServerEvent(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = 2_000) {
  const timeout = AbortSignal.timeout(timeoutMs);
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

function boundGateway() {
  const gateway = new PreparedEvidenceProjectionGateway();
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
  return { gateway, session: bound.session };
}

describe("Stage network event and receipt channel", () => {
  test("subscribes before playback and records the exact applied receipt", async () => {
    const { gateway, session } = boundGateway();
    const receipts: unknown[] = [];
    const handler = createProjectionGatewayHandler(
      parseProjectionGatewayConfig({ STAGE_ORIGIN: origin }),
      {
        gateway,
        internalAuthToken: "internal-test-token-alpha",
        now: () => 1_002,
        stageReceiptWriter: {
          async recordApplied(input) {
            receipts.push(input);
            return { status: "STAGE_APPLIED", commandId: input.commandId };
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
    expect(stream.status).toBe(200);
    const reader = stream.body?.getReader();
    if (reader === undefined) throw new Error("SSE response has no body");

    expect(
      gateway.projectPlayback("ps_alpha", {
        commandId: "cmd_alpha",
        displayBindingEpoch: "dbe_1",
        acceptedControlRevision: "cr_1",
        occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
        blackout: false,
      }),
    ).toBe(true);
    const event = await nextServerEvent(reader);
    expect(event).toEqual({
      kind: "PLAYBACK",
      payload: {
        commandId: "cmd_alpha",
        displayBindingEpoch: "dbe_1",
        acceptedControlRevision: "cr_1",
        occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
        blackout: false,
      },
    });
    const receipt = await handler(
      new Request("https://projection.example.test/v1/stage-applied", {
        method: "POST",
        headers: {
          cookie,
          origin,
          referer: `${origin}/display/display_alpha`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ commandId: "cmd_alpha", displayBindingEpoch: "dbe_1" }),
      }),
    );
    expect(receipt.status).toBe(200);
    expect(receipts).toEqual([
      {
        audienceDisplaySessionId: session.audienceDisplaySessionId,
        commandId: "cmd_alpha",
        displayBindingEpoch: "dbe_1",
      },
    ]);
    await reader.cancel();
  });

  test("delivers card tombstones and closes the old channel on binding takeover", async () => {
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
    const stream = await handler(
      new Request("https://projection.example.test/v1/events", {
        headers: { cookie: `__Host-display=${session.audienceDisplaySessionId}`, origin },
      }),
    );
    const reader = stream.body?.getReader();
    if (reader === undefined) throw new Error("SSE response has no body");
    gateway.projectCard("ps_alpha", {
      projectionId: "projection_alpha",
      status: "RETRACTED",
      publicCardRevision: "pcr_1",
      occurredAtMs: 1_003,
    });
    expect(await nextServerEvent(reader)).toEqual({
      kind: "CARD",
      payload: {
        projectionId: "projection_alpha",
        status: "RETRACTED",
        publicCardRevision: "pcr_1",
        occurredAtMs: 1_003,
      },
    });

    const join = gateway.createDisplayJoin(
      {
        displayId: "display_beta",
        deckVersion: deck.deckVersion,
        displayFingerprint: "fingerprint-stage-beta",
      },
      1_004,
    );
    gateway.bindDisplay(
      {
        displayJoinId: join.displayJoinId,
        presentationSessionId: "ps_alpha",
        presentationSessionEpoch: "pse_1",
        expectedDisplayBindingEpoch: "dbe_1",
        expectedDeckVersion: deck.deckVersion,
        approvedDisplayId: join.displayId,
        approvedDisplayFingerprint: join.displayFingerprint,
        deck,
      },
      1_005,
    );
    expect(await nextServerEvent(reader)).toEqual({
      kind: "CLOSE",
      payload: { reason: "REBOUND" },
    });
  });
});
