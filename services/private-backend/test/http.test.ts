import { describe, expect, test } from "bun:test";
import { parsePrivateBackendConfig } from "../src/config.ts";
import { createPrivateBackendHandler } from "../src/http.ts";
import {
  createPreparedEvidenceStore,
  PreparedEvidenceCoordinator,
  snapshotPreparedEvidenceStore,
} from "../src/prepared-evidence.ts";

const handler = createPrivateBackendHandler(
  parsePrivateBackendConfig({
    PRIVATE_BACKEND_HOST: "127.0.0.1",
    PRIVATE_BACKEND_PORT: "4101",
    CONSOLE_ORIGIN: "https://console.example.test",
  }),
);

describe("private backend HTTP boundary", () => {
  test("serves a minimal health response without requiring a browser origin", async () => {
    const response = await handler(new Request("http://service.test/health"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ service: "private-backend", status: "ok" });
  });

  test("allows only the configured exact browser Origin", async () => {
    const allowed = await handler(
      new Request("http://service.test/health", {
        headers: { Origin: "https://console.example.test" },
      }),
    );
    const lookalike = await handler(
      new Request("http://service.test/health", {
        headers: { Origin: "https://console.example.test.attacker.invalid" },
      }),
    );

    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://console.example.test");
    expect(allowed.headers.get("vary")).toBe("Origin");
    expect(lookalike.status).toBe(403);
    expect(lookalike.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("returns 410 for every authenticated Stage card transition", async () => {
    const store = createPreparedEvidenceStore();
    const coordinator = new PreparedEvidenceCoordinator(
      {
        bindDisplay: () => ({ outcome: "REJECTED", reason: "unused" }),
        projectPlayback: () => false,
        recordPlaybackApplied: () => false,
        issueDisplayInvitation: () => ({ outcome: "REJECTED", reason: "unused" }),
        readDisplayInvitation: () => ({ outcome: "REJECTED", reason: "unused" }),
      },
      store,
    );
    let persistCalls = 0;
    const authenticatedHandler = createPrivateBackendHandler(
      parsePrivateBackendConfig({ CONSOLE_ORIGIN: "https://console.example.test" }),
      {
        coordinator,
        identityVerifier: {
          async verifyCredentials() {
            return { accountId: "account_http", actorId: "actor_http" };
          },
        },
        internalAuthToken: "private-http-test-token",
        now: () => 1_000,
        persist: async () => {
          persistCalls += 1;
        },
      },
    );
    const browserHeaders = {
      Origin: "https://console.example.test",
      Referer: "https://console.example.test/",
      "content-type": "application/json",
    };
    const login = await authenticatedHandler(
      new Request("http://service.test/v1/account-sessions", {
        method: "POST",
        headers: browserHeaders,
        body: JSON.stringify({ username: "presenter", password: "password" }),
      }),
    );
    const loginBody = (await login.json()) as { csrfToken: string };
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    if (cookie === undefined) throw new Error("login fixture did not set an account cookie");
    const before = JSON.stringify(snapshotPreparedEvidenceStore(store));
    const persistedAfterLogin = persistCalls;

    for (const [path, sourceKind] of [
      ["/v1/publications/approve", "CURATED_PREAPPROVED"],
      ["/v1/publications/approve", "LIVE_VERIFIED"],
      ["/v1/publications/approve", "FORGED_SOURCE_KIND"],
      ["/v1/publications/terminate", "FORGED_SOURCE_KIND"],
    ] as const) {
      const response = await authenticatedHandler(
        new Request(`http://service.test${path}`, {
          method: "POST",
          headers: {
            ...browserHeaders,
            Cookie: cookie,
            "x-csrf-token": loginBody.csrfToken,
          },
          body: JSON.stringify({ sourceKind }),
        }),
      );
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({ error: "stage_cards_disabled" });
    }
    expect(JSON.stringify(snapshotPreparedEvidenceStore(store))).toBe(before);
    expect(persistCalls).toBe(persistedAfterLogin);
  });

  test("returns a closed not-found response", async () => {
    const response = await handler(new Request("http://service.test/private-data"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});
