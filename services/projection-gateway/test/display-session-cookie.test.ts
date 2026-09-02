import { describe, expect, test } from "bun:test";
import { PublishedDeckArtifactSchema } from "@impromptu/contracts/public";
import { type ExactOrigin, parseProjectionGatewayConfig } from "../src/config.ts";
import { createProjectionGatewayHandler, type ProjectionGatewayHandler } from "../src/http.ts";
import {
  PreparedEvidenceProjectionGateway as Gateway,
  type PreparedEvidenceProjectionGateway,
} from "../src/prepared-evidence.ts";
import { createProjectionRealtimeProtocol } from "../src/realtime.ts";

const httpStageOrigin = "http://localhost:4174" as ExactOrigin;
const httpsStageOrigin = "https://stage.example.test" as ExactOrigin;
const nowMs = 1_000;

const deck = PublishedDeckArtifactSchema.parse({
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
});

function stageRequest(origin: string, path: string, init: RequestInit = {}) {
  return new Request(`https://projection.example.test${path}`, {
    ...init,
    headers: {
      Origin: origin,
      Referer: `${origin}/`,
      ...init.headers,
    },
  });
}

async function claimDisplaySession(stageOrigin: ExactOrigin): Promise<{
  handler: ProjectionGatewayHandler;
  gateway: PreparedEvidenceProjectionGateway;
  session: { audienceDisplaySessionId: string; expiresAtMs: number };
  setCookie: string;
}> {
  const gateway = new Gateway();
  const handler = createProjectionGatewayHandler(
    parseProjectionGatewayConfig({ STAGE_ORIGIN: stageOrigin }),
    {
      gateway,
      internalAuthToken: "internal-test-token-alpha",
      now: () => nowMs,
      stageReceiptWriter: {
        async recordApplied() {
          return null;
        },
      },
    },
  );
  const joinResponse = await handler(
    stageRequest(stageOrigin, "/v1/display-joins", {
      method: "POST",
      body: JSON.stringify({
        displayId: "display_alpha",
        deckVersion: deck.deckVersion,
        displayFingerprint: "fingerprint-stage-alpha",
      }),
    }),
  );
  const join = (await joinResponse.json()) as Record<string, string>;
  expect(joinResponse.status).toBe(201);
  const bound = gateway.bindDisplay(
    {
      displayJoinId: join.displayJoinId ?? "",
      presentationSessionId: "ps_alpha",
      presentationSessionEpoch: "pse_1",
      expectedDisplayBindingEpoch: "dbe_0",
      expectedDeckVersion: deck.deckVersion,
      approvedDisplayId: join.displayId ?? "",
      approvedDisplayFingerprint: join.displayFingerprint ?? "",
      deck,
    },
    nowMs,
  );
  if (bound.outcome !== "BOUND") throw new Error("fixture binding failed");
  const claimed = await handler(
    stageRequest(stageOrigin, "/v1/display-session", {
      method: "POST",
      body: JSON.stringify(join),
    }),
  );
  expect(claimed.status).toBe(201);
  const session = (await claimed.json()) as {
    audienceDisplaySessionId: string;
    expiresAtMs: number;
  };
  const setCookie = claimed.headers.get("set-cookie");
  if (setCookie === null) throw new Error("display-session claim issued no cookie");
  return { handler, gateway, session, setCookie };
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
    return JSON.parse(line.slice(6)) as unknown;
  }
}

describe("display session cookie across origins", () => {
  test("issues a plain-HTTP usable cookie whose replay authenticates the event stream", async () => {
    const { handler, gateway, session, setCookie } = await claimDisplaySession(httpStageOrigin);

    // The dev Stage is served over plain HTTP at http://localhost:4174, where a __Host- prefixed
    // Secure cookie is rejected by every browser and never sent back.
    expect(setCookie.startsWith("__Host-")).toBe(false);
    expect(setCookie).not.toContain("Secure");

    // Subscribe before triggering playback, then await one real event on a bounded deadline.
    const events = await handler(
      new Request("https://projection.example.test/v1/events", {
        headers: { cookie: `display=${session.audienceDisplaySessionId}`, origin: httpStageOrigin },
      }),
    );
    expect(events.status).toBe(200);
    const reader = events.body?.getReader();
    if (reader === undefined) throw new Error("SSE response has no body");
    const eventPromise = nextServerEvent(reader);
    expect(
      gateway.projectPlayback("ps_alpha", {
        commandId: "cmd_alpha",
        displayBindingEpoch: "dbe_1",
        acceptedControlRevision: "cr_1",
        occurrence: { publicSlideKey: "slide_one", occurrenceSeq: 1 },
        blackout: false,
      }),
    ).toBe(true);
    expect(await eventPromise).toMatchObject({ kind: "PLAYBACK" });
    await reader.cancel();
  });

  test("keeps the https cookie byte-identical to production and rejects the plain name there", async () => {
    const { handler, session, setCookie } = await claimDisplaySession(httpsStageOrigin);
    const maxAgeSeconds = Math.max(0, Math.floor((session.expiresAtMs - nowMs) / 1_000));
    expect(setCookie).toBe(
      `__Host-display=${session.audienceDisplaySessionId}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`,
    );

    // Only accept what an https origin would have issued; the dev name must not authenticate.
    const rejected = await handler(
      new Request("https://projection.example.test/v1/events", {
        headers: {
          cookie: `display=${session.audienceDisplaySessionId}`,
          origin: httpsStageOrigin,
        },
      }),
    );
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toEqual({ error: "display_session_required" });
  });

  test("realtime handshake accepts exactly the name the current origin would have issued", async () => {
    const httpClaim = await claimDisplaySession(httpStageOrigin);
    const httpProtocol = createProjectionRealtimeProtocol({
      gateway: httpClaim.gateway,
      allowedOrigin: httpStageOrigin,
      now: () => nowMs,
      async recordApplied() {
        return null;
      },
    });
    expect(
      httpProtocol.authenticate(
        new Request("https://projection.example.test/v1/realtime", {
          headers: {
            origin: httpStageOrigin,
            cookie: `display=${httpClaim.session.audienceDisplaySessionId}`,
          },
        }),
      ),
    ).toMatchObject({ outcome: "ACCEPTED" });
    expect(
      httpProtocol.authenticate(
        new Request("https://projection.example.test/v1/realtime", {
          headers: {
            origin: httpStageOrigin,
            cookie: `__Host-display=${httpClaim.session.audienceDisplaySessionId}`,
          },
        }),
      ),
    ).toMatchObject({ outcome: "REJECTED", reason: "DISPLAY_SESSION_REQUIRED" });

    const httpsClaim = await claimDisplaySession(httpsStageOrigin);
    const httpsProtocol = createProjectionRealtimeProtocol({
      gateway: httpsClaim.gateway,
      allowedOrigin: httpsStageOrigin,
      now: () => nowMs,
      async recordApplied() {
        return null;
      },
    });
    expect(
      httpsProtocol.authenticate(
        new Request("https://projection.example.test/v1/realtime", {
          headers: {
            origin: httpsStageOrigin,
            cookie: `__Host-display=${httpsClaim.session.audienceDisplaySessionId}`,
          },
        }),
      ),
    ).toMatchObject({ outcome: "ACCEPTED" });
    expect(
      httpsProtocol.authenticate(
        new Request("https://projection.example.test/v1/realtime", {
          headers: {
            origin: httpsStageOrigin,
            cookie: `display=${httpsClaim.session.audienceDisplaySessionId}`,
          },
        }),
      ),
    ).toMatchObject({ outcome: "REJECTED", reason: "DISPLAY_SESSION_REQUIRED" });
  });
});
