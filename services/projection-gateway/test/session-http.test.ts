import { describe, expect, test } from "bun:test";
import { parseProjectionGatewayConfig } from "../src/config.ts";
import { createProjectionGatewayHandler } from "../src/http.ts";
import { PreparedEvidenceProjectionGateway } from "../src/prepared-evidence.ts";

const stageOrigin = "https://stage.example.test";
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

function stageRequest(path: string, init: RequestInit = {}) {
  return new Request(`https://projection.example.test${path}`, {
    ...init,
    headers: {
      Origin: stageOrigin,
      Referer: `${stageOrigin}/`,
      ...init.headers,
    },
  });
}

describe("Stage display session HTTP boundary", () => {
  test("issues a locator, then sets only a public display cookie after approval", async () => {
    const gateway = new PreparedEvidenceProjectionGateway();
    const handler = createProjectionGatewayHandler(
      parseProjectionGatewayConfig({ STAGE_ORIGIN: stageOrigin }),
      { gateway, now: () => 1_000 },
    );
    const joinResponse = await handler(
      stageRequest("/v1/display-joins", {
        method: "POST",
        body: JSON.stringify({
          displayId: "display_alpha",
          deckVersion: deck.deckVersion,
          displayFingerprint: "fingerprint-stage-alpha",
        }),
      }),
    );
    const join = await joinResponse.json();
    expect(joinResponse.status).toBe(201);
    expect(join.displayJoinId).toMatch(/^join_[0-9a-f]{32}$/);

    const beforeApproval = await handler(
      stageRequest("/v1/display-session", {
        method: "POST",
        body: JSON.stringify(join),
      }),
    );
    expect(beforeApproval.status).toBe(409);
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
      1_000,
    );
    expect(bound.outcome).toBe("BOUND");
    const claimed = await handler(
      stageRequest("/v1/display-session", {
        method: "POST",
        body: JSON.stringify(join),
      }),
    );
    expect(claimed.status).toBe(201);
    expect(claimed.headers.get("set-cookie")).toContain("__Host-display=audience_");
    expect(claimed.headers.get("set-cookie")).not.toContain("account");
    const replay = await handler(
      stageRequest("/v1/display-session", {
        method: "POST",
        body: JSON.stringify(join),
      }),
    );
    expect(replay.status).toBe(409);
  });
});
