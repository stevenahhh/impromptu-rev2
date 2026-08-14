import { describe, expect, test } from "bun:test";
import { PreparedEvidenceProjectionGateway } from "../src/prepared-evidence.ts";
import { createProjectionRealtimeProtocol } from "../src/realtime.ts";

function fixture() {
  const gateway = new PreparedEvidenceProjectionGateway();
  const deck = {
    deckVersion: "deck_alpha",
    manifestHash: "a".repeat(64),
    title: "Realtime",
    slides: [
      {
        publicSlideKey: "slide_one",
        ordinal: 1,
        image: {
          url: "https://public.test/one.png",
          contentHash: "b".repeat(64),
          width: 1,
          height: 1,
        },
        accessibilityLabel: "One",
      },
    ],
  };
  const join = gateway.createDisplayJoin(
    {
      displayId: "display_alpha",
      displayFingerprint: "fingerprint-stage-alpha",
      deckVersion: deck.deckVersion,
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
  if (bound.outcome !== "BOUND") throw new Error("binding failed");
  return { gateway, session: bound.session };
}

describe("projection realtime WebSocket protocol", () => {
  test("extends SSE with typed command delivery and typed applied receipts", async () => {
    const { gateway, session } = fixture();
    const sent: unknown[] = [];
    const protocol = createProjectionRealtimeProtocol({
      gateway,
      allowedOrigin: "https://stage.example.test",
      now: () => 1_002,
      async recordApplied(input) {
        return {
          status: "STAGE_APPLIED",
          commandId: input.commandId,
          presentationSessionEpoch: "pse_1",
          displayBindingEpoch: input.displayBindingEpoch,
          publicPlaybackRevision: "pbr_1",
          appliedAtMs: 1_003,
        };
      },
    });
    const request = new Request("https://projection.example.test/v1/realtime", {
      headers: {
        origin: "https://stage.example.test",
        cookie: `__Host-display=${session.audienceDisplaySessionId}`,
      },
    });
    const authenticated = protocol.authenticate(request);
    expect(authenticated).toEqual({
      outcome: "ACCEPTED",
      audienceDisplaySessionId: session.audienceDisplaySessionId,
    });
    if (authenticated.outcome !== "ACCEPTED") throw new Error("authentication failed");
    const connection = protocol.connect(authenticated.audienceDisplaySessionId, (message) =>
      sent.push(message),
    );
    if (connection === null) throw new Error("connection failed");

    expect(
      gateway.projectPlayback("ps_alpha", {
        commandId: "cmd_alpha",
        displayBindingEpoch: "dbe_1",
        acceptedControlRevision: "cr_1",
        occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 2 },
        blackout: false,
      }),
    ).toBe(true);
    expect(sent).toEqual([
      {
        kind: "COMMAND",
        payload: {
          commandId: "cmd_alpha",
          presentationSessionEpoch: "pse_1",
          displayBindingEpoch: "dbe_1",
          acceptedControlRevision: "cr_1",
          publicPlaybackRevision: "pbr_1",
          occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 2 },
          blackout: false,
        },
      },
    ]);

    await connection.receive(
      JSON.stringify({
        kind: "STAGE_APPLIED",
        payload: { commandId: "cmd_alpha", displayBindingEpoch: "dbe_1" },
      }),
    );
    expect(sent[1]).toEqual({
      kind: "RECEIPT",
      payload: {
        status: "STAGE_APPLIED",
        commandId: "cmd_alpha",
        presentationSessionEpoch: "pse_1",
        displayBindingEpoch: "dbe_1",
        publicPlaybackRevision: "pbr_1",
        appliedAtMs: 1_003,
      },
    });
    connection.close();
  });

  test("rejects wrong origins, missing sessions, malformed frames, and stale epochs", async () => {
    const { gateway, session } = fixture();
    let writes = 0;
    const sent: unknown[] = [];
    const protocol = createProjectionRealtimeProtocol({
      gateway,
      allowedOrigin: "https://stage.example.test",
      now: () => 1_002,
      async recordApplied() {
        writes += 1;
        return null;
      },
    });
    expect(
      protocol.authenticate(
        new Request("https://projection.test/v1/realtime", {
          headers: { origin: "https://evil.test" },
        }),
      ),
    ).toEqual({ outcome: "REJECTED", reason: "ORIGIN_FORBIDDEN" });
    const connection = protocol.connect(session.audienceDisplaySessionId, (message) =>
      sent.push(message),
    );
    if (connection === null) throw new Error("connection failed");
    await connection.receive("not-json");
    await connection.receive(
      JSON.stringify({
        kind: "STAGE_APPLIED",
        payload: { commandId: "cmd_alpha", displayBindingEpoch: "dbe_0" },
      }),
    );
    expect(writes).toBe(0);
    expect(sent).toEqual([
      { kind: "ERROR", payload: { code: "INVALID_FRAME" } },
      { kind: "ERROR", payload: { code: "STALE_DISPLAY_BINDING" } },
    ]);
  });
});
