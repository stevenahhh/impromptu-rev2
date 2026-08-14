import { expect, test } from "bun:test";
import { createConsoleSessionClient } from "./session-client";

test("Console recommendation client calls the authenticated private HTTP route", async () => {
  const originalFetch = globalThis.fetch;
  const received: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    received.push({ url: String(input), init: init ?? {} });
    return new Response(
      JSON.stringify({
        outcome: "ABSTAIN",
        reason: "INSUFFICIENT_EVIDENCE",
        completedAtMs: 100,
        latencyMs: 20,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const result = await createConsoleSessionClient("https://private.example.test").recommend(
      "csrf-token",
      {
        query: "revenue",
        deckVersion: "deck_v1",
        manifestHash: "a".repeat(64),
        maxResults: 3,
      },
    );
    expect(result).toMatchObject({ outcome: "ABSTAIN", reason: "INSUFFICIENT_EVIDENCE" });
    const call = received[0];
    if (call === undefined) throw new Error("recommendation request was not sent");
    expect(call.url).toBe("https://private.example.test/v1/recommendations");
    expect(call.init).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", "x-csrf-token": "csrf-token" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
