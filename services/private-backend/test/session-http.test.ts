import { describe, expect, test } from "bun:test";
import { PublishedDeckArtifactSchema } from "@impromptu/contracts/public";
import { PreparedEvidenceProjectionGateway } from "@impromptu/projection-gateway";
import { parsePrivateBackendConfig } from "../src/config.ts";
import { createPrivateBackendHandler } from "../src/http.ts";
import { PreparedEvidenceCoordinator } from "../src/prepared-evidence.ts";

const origin = "https://console.example.test";
const config = parsePrivateBackendConfig({ CONSOLE_ORIGIN: origin });

function request(path: string, init: RequestInit = {}) {
  return new Request(`https://private.example.test${path}`, {
    ...init,
    headers: {
      Origin: origin,
      Referer: `${origin}/sign-in`,
      ...init.headers,
    },
  });
}

describe("account session HTTP boundary", () => {
  test("exchanges a one-time code server-side into an HttpOnly host cookie", async () => {
    let receivedCode: string | null = null;
    const handler = createPrivateBackendHandler(config, {
      coordinator: new PreparedEvidenceCoordinator(new PreparedEvidenceProjectionGateway()),
      identityVerifier: {
        async exchangeAuthorizationCode(code) {
          receivedCode = code;
          return { accountId: "account_alpha", actorId: "actor_alpha" };
        },
      },
      internalAuthToken: "internal-test-token-alpha",
      now: () => 1_000,
    });
    const response = await handler(
      request("/v1/account-sessions", {
        method: "POST",
        body: JSON.stringify({ authorizationCode: "one-time-code" }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(String(receivedCode)).toBe("one-time-code");
    expect(response.headers.get("set-cookie")).toContain("__Host-account=account_session_");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly; Secure; SameSite=Strict");
    expect(JSON.stringify(payload)).not.toContain("one-time-code");
    expect(payload.csrfToken).toMatch(/^[0-9a-f]{48}$/);
  });

  test("requires exact navigation origin and synchronizer CSRF for mutations", async () => {
    const handler = createPrivateBackendHandler(config, {
      coordinator: new PreparedEvidenceCoordinator(new PreparedEvidenceProjectionGateway()),
      identityVerifier: {
        async exchangeAuthorizationCode() {
          return { accountId: "account_alpha", actorId: "actor_alpha" };
        },
      },
      internalAuthToken: "internal-test-token-alpha",
      now: () => 1_000,
    });
    const missingReferer = await handler(
      new Request("https://private.example.test/v1/account-sessions", {
        method: "POST",
        headers: { Origin: origin },
        body: JSON.stringify({ authorizationCode: "code" }),
      }),
    );
    expect(missingReferer.status).toBe(403);

    const signedIn = await handler(
      request("/v1/account-sessions", {
        method: "POST",
        body: JSON.stringify({ authorizationCode: "code" }),
      }),
    );
    const cookie = signedIn.headers.get("set-cookie")?.split(";", 1)[0];
    const withoutCsrf = await handler(
      request("/v1/account-session", {
        method: "DELETE",
        headers: { Cookie: cookie ?? "" },
      }),
    );
    expect(withoutCsrf.status).toBe(403);
  });

  test("accepts a renderer manifest and returns its slides as a public deck", async () => {
    const handler = createPrivateBackendHandler(config, {
      coordinator: new PreparedEvidenceCoordinator(new PreparedEvidenceProjectionGateway()),
      identityVerifier: {
        async exchangeAuthorizationCode() {
          return { accountId: "account_render", actorId: "actor_render" };
        },
      },
      internalAuthToken: "internal-test-token-render",
      now: () => 1_000,
    });
    const signedIn = await handler(
      request("/v1/account-sessions", {
        method: "POST",
        body: JSON.stringify({ authorizationCode: "render-code" }),
      }),
    );
    const cookie = signedIn.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const session = await signedIn.json();

    const response = await handler(
      request("/v1/deck-artifacts", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "X-CSRF-Token": String(session.csrfToken),
        },
        body: JSON.stringify({
          title: "Rendered deck",
          publicBaseUrl: "https://public.example.test/rendered/deck",
          renderManifest: {
            deck_id: `deck_${"a".repeat(64)}`,
            animation_eligible: true,
            ineligible_reason: null,
            slides: [
              {
                slide_key: `slide_${"b".repeat(64)}`,
                source_index: 1,
                relative_path: "slides/slide-1.svg",
                content_sha256: "c".repeat(64),
                width_points: 960,
                height_points: 540,
              },
            ],
          },
        }),
      }),
    );
    const payload = await response.json();
    const deck = PublishedDeckArtifactSchema.parse(payload.publicDeck);

    expect(response.status).toBe(201);
    expect(deck.slides).toHaveLength(1);
    expect(deck.slides[0]?.image.url).toBe(
      "https://public.example.test/rendered/deck/slides/slide-1.svg",
    );
  });
});
