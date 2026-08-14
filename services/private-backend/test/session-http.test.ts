import { describe, expect, test } from "bun:test";
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
});
