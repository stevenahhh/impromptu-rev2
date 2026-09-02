import { describe, expect, test } from "bun:test";
import { PublishedDeckArtifactSchema } from "@impromptu/contracts/public";
import type { ExactOrigin } from "../src/config.ts";
import { PreparedEvidenceProjectionGateway } from "../src/prepared-evidence.ts";
import {
  createProjectionRealtimeProtocol,
  type ProjectionRealtimeConnection,
} from "../src/realtime.ts";

function signal<Value>(label: string) {
  let resolve: ((value: Value) => void) | null = null;
  const promise = new Promise<Value>((promiseResolve, reject) => {
    resolve = promiseResolve;
    AbortSignal.timeout(2_000).addEventListener(
      "abort",
      () => reject(new Error(`${label} timeout`)),
      { once: true },
    );
  });
  return {
    promise,
    resolve(value: Value) {
      if (resolve === null) throw new Error(`${label} resolved twice`);
      const current = resolve;
      resolve = null;
      current(value);
    },
  };
}

describe("projection WSS runtime surface", () => {
  test("upgrades the authenticated Stage and exchanges command and receipt frames", async () => {
    const gateway = new PreparedEvidenceProjectionGateway();
    const deck = PublishedDeckArtifactSchema.parse({
      deckVersion: "deck_wss",
      manifestHash: "a".repeat(64),
      title: "WSS",
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
    });
    const join = gateway.createDisplayJoin(
      {
        displayId: "display_wss",
        displayFingerprint: "fingerprint-stage-wss",
        deckVersion: deck.deckVersion,
      },
      1_000,
    );
    const bound = gateway.bindDisplay(
      {
        displayJoinId: join.displayJoinId,
        presentationSessionId: "ps_wss",
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
    const protocol = createProjectionRealtimeProtocol({
      gateway,
      allowedOrigin: "https://stage.example.test" as ExactOrigin,
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
    type SocketData = {
      audienceDisplaySessionId: string;
      connection: ProjectionRealtimeConnection | null;
    };
    const server = Bun.serve<SocketData, Record<never, never>>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, runtime) {
        const authentication = protocol.authenticate(request);
        if (authentication.outcome === "REJECTED") return new Response(null, { status: 403 });
        return runtime.upgrade(request, {
          data: {
            audienceDisplaySessionId: authentication.audienceDisplaySessionId,
            connection: null,
          },
        })
          ? undefined
          : new Response(null, { status: 426 });
      },
      websocket: {
        open(socket) {
          socket.data.connection = protocol.connect(
            socket.data.audienceDisplaySessionId,
            (message) => socket.send(JSON.stringify(message)),
          );
        },
        async message(socket, message) {
          await socket.data.connection?.receive(message);
        },
        close(socket) {
          socket.data.connection?.close();
        },
      },
    });
    try {
      const opened = signal<void>("open");
      const command = signal<Record<string, unknown>>("command");
      const receipt = signal<Record<string, unknown>>("receipt");
      const RuntimeWebSocket = WebSocket as unknown as new (
        url: string,
        options: { headers: Record<string, string> },
      ) => WebSocket;
      const socket = new RuntimeWebSocket(server.url.href, {
        headers: {
          Origin: "https://stage.example.test",
          Cookie: `__Host-display=${bound.session.audienceDisplaySessionId}`,
        },
      });
      socket.addEventListener("open", () => opened.resolve());
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (message.kind === "COMMAND") command.resolve(message);
        if (message.kind === "RECEIPT") receipt.resolve(message);
      });
      await opened.promise;
      expect(
        gateway.projectPlayback("ps_wss", {
          commandId: "cmd_wss",
          displayBindingEpoch: "dbe_1",
          acceptedControlRevision: "cr_1",
          occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 2 },
          blackout: false,
        }),
      ).toBe(true);
      const delivered = await command.promise;
      socket.send(
        JSON.stringify({
          kind: "STAGE_APPLIED",
          payload: { commandId: "cmd_wss", displayBindingEpoch: "dbe_1" },
        }),
      );
      const acknowledged = await receipt.promise;
      expect(delivered.kind).toBe("COMMAND");
      expect(acknowledged.kind).toBe("RECEIPT");
      socket.close();
    } finally {
      server.stop(true);
    }
  });
});
