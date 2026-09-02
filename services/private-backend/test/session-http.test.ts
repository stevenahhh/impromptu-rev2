import { describe, expect, test } from "bun:test";
import { PublishedDeckArtifactSchema } from "@impromptu/contracts/public";
import { PreparedEvidenceProjectionGateway } from "@impromptu/projection-gateway";
import { parsePrivateBackendConfig } from "../src/config.ts";
import { createPrivateBackendHandler } from "../src/http.ts";
import type { PrivateBackendHandler } from "../src/http/types.ts";
import { PreparedEvidenceCoordinator } from "../src/prepared-evidence.ts";
import { PreparedEvidenceStateConflictError } from "../src/prepared-evidence-store-postgres.ts";

const origin = "https://console.example.test";
const config = parsePrivateBackendConfig({ CONSOLE_ORIGIN: origin });

// Returns null through a call so the assertions below still see `string | null`: a bare `null`
// initializer lets control-flow analysis narrow the variable to `null`, because the assignment
// happens inside a callback TypeScript cannot track, and `expect(x).toBe("...")` then rejects.
function emptyCredential(): string | null {
  return null;
}

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
    let receivedUsername: string | null = emptyCredential();
    let receivedPassword: string | null = emptyCredential();
    const handler = createPrivateBackendHandler(config, {
      coordinator: new PreparedEvidenceCoordinator(new PreparedEvidenceProjectionGateway()),
      identityVerifier: {
        async verifyCredentials(username, password) {
          receivedUsername = username;
          receivedPassword = password;
          if (username !== "alpha@example.test" || password !== "alpha-password") return null;
          return { accountId: "account_alpha", actorId: "actor_alpha" };
        },
      },
      internalAuthToken: "internal-test-token-alpha",
      now: () => 1_000,
    });
    const response = await handler(
      request("/v1/account-sessions", {
        method: "POST",
        body: JSON.stringify({ username: "alpha@example.test", password: "alpha-password" }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(receivedUsername).toBe("alpha@example.test");
    expect(receivedPassword).toBe("alpha-password");
    expect(response.headers.get("set-cookie")).toContain("__Host-account=account_session_");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly; Secure; SameSite=Strict");
    expect(JSON.stringify(payload)).not.toContain("one-time-code");
    expect(payload.csrfToken).toMatch(/^[0-9a-f]{48}$/);
  });

  test("uses an HttpOnly development cookie when the Console runs over HTTP", async () => {
    const developmentOrigin = "http://localhost:4173";
    const handler = createPrivateBackendHandler(
      parsePrivateBackendConfig({ CONSOLE_ORIGIN: developmentOrigin }),
      {
        coordinator: new PreparedEvidenceCoordinator(new PreparedEvidenceProjectionGateway()),
        identityVerifier: {
          async verifyCredentials() {
            return { accountId: "account_local", actorId: "actor_local" };
          },
        },
        internalAuthToken: "internal-test-token-local",
        now: () => 1_000,
      },
    );
    const response = await handler(
      new Request("http://localhost:3001/v1/account-sessions", {
        method: "POST",
        headers: {
          Origin: developmentOrigin,
          Referer: `${developmentOrigin}/sign-in`,
        },
        body: JSON.stringify({ username: "local@example.test", password: "local-password" }),
      }),
    );
    const cookie = response.headers.get("set-cookie");

    expect(response.status).toBe(201);
    expect(cookie).toContain("account=account_session_");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("__Host-account");
    expect(cookie).not.toContain(" Secure");
  });

  test("requires exact navigation origin and synchronizer CSRF for mutations", async () => {
    const handler = createPrivateBackendHandler(config, {
      coordinator: new PreparedEvidenceCoordinator(new PreparedEvidenceProjectionGateway()),
      identityVerifier: {
        async verifyCredentials() {
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
        body: JSON.stringify({ username: "alpha@example.test", password: "alpha-password" }),
      }),
    );
    expect(missingReferer.status).toBe(403);

    const signedIn = await handler(
      request("/v1/account-sessions", {
        method: "POST",
        body: JSON.stringify({ username: "alpha@example.test", password: "alpha-password" }),
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
        async verifyCredentials() {
          return { accountId: "account_render", actorId: "actor_render" };
        },
      },
      internalAuthToken: "internal-test-token-render",
      now: () => 1_000,
    });
    const signedIn = await handler(
      request("/v1/account-sessions", {
        method: "POST",
        body: JSON.stringify({ username: "render@example.test", password: "render-password" }),
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

describe("sign-in under prepared-evidence state conflict", () => {
  // Two devices signing in at the same moment both touch the prepared-evidence snapshot; when
  // the compare-and-swap loses, the loser used to surface as an unhandled 500 on the login
  // path. A conflict must be surfaced deliberately (503, retryable) - never as an internal
  // error - and the other concurrent sign-in must still succeed.
  function conflictingHandler(persist: () => Promise<void>) {
    return createPrivateBackendHandler(config, {
      coordinator: new PreparedEvidenceCoordinator(new PreparedEvidenceProjectionGateway()),
      identityVerifier: {
        async verifyCredentials() {
          return { accountId: "account_alpha", actorId: "actor_alpha" };
        },
      },
      internalAuthToken: "internal-test-token-alpha",
      now: () => 1_000,
      persist,
    });
  }

  test("two concurrent sign-ins survive one losing the state compare-and-swap", async () => {
    let persistCalls = 0;
    const handler = conflictingHandler(async () => {
      persistCalls += 1;
      if (persistCalls === 1) throw new PreparedEvidenceStateConflictError("test conflict");
    });
    const signIn = () =>
      handler(
        request("/v1/account-sessions", {
          method: "POST",
          body: JSON.stringify({ username: "alpha@example.test", password: "alpha-password" }),
        }),
      );
    const [first, second] = await Promise.all([signIn(), signIn()]);
    const statuses = [first.status, second.status].sort((left, right) => left - right);

    expect(persistCalls).toBe(2);
    expect(statuses).toEqual([201, 503]);
    const conflicted = first.status === 503 ? first : second;
    expect(await conflicted.json()).toEqual({ error: "state_write_conflict" });
  });

  test("both concurrent sign-ins surface a deliberate conflict when every write loses", async () => {
    const handler = conflictingHandler(async () => {
      throw new PreparedEvidenceStateConflictError("test conflict");
    });
    const signIn = () =>
      handler(
        request("/v1/account-sessions", {
          method: "POST",
          body: JSON.stringify({ username: "alpha@example.test", password: "alpha-password" }),
        }),
      );
    const responses = await Promise.all([signIn(), signIn()]);

    for (const response of responses) {
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "state_write_conflict" });
    }
  });
});
