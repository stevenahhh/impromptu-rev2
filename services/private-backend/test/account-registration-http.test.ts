import { describe, expect, test } from "bun:test";
import { PreparedEvidenceProjectionGateway } from "@impromptu/projection-gateway";
import { createAccountDirectory } from "../src/account-directory.ts";
import { parsePrivateBackendConfig } from "../src/config.ts";
import { createPrivateBackendHandler } from "../src/http.ts";
import { PreparedEvidenceCoordinator } from "../src/prepared-evidence.ts";

const consoleOrigin = "https://console.example.test";

function accountRequest(
  path: string,
  body: unknown,
  referer = `${consoleOrigin}/sign-up`,
): Request {
  return new Request(`https://private.example.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: consoleOrigin,
      Referer: referer,
    },
    body: JSON.stringify(body),
  });
}

function fixture() {
  const directory = createAccountDirectory();
  return createPrivateBackendHandler(parsePrivateBackendConfig({ CONSOLE_ORIGIN: consoleOrigin }), {
    coordinator: new PreparedEvidenceCoordinator(new PreparedEvidenceProjectionGateway()),
    identityVerifier: directory,
    accountRegistrar: directory,
    internalAuthToken: "account-registration-test-token",
    now: () => 1_000,
  });
}

describe("account registration HTTP boundary", () => {
  test("registers an account that can then sign in", async () => {
    const handler = fixture();
    const credentials = { username: "new-user", password: "new-user-password" };

    const registered = await handler(accountRequest("/v1/accounts", credentials));
    expect(registered.status).toBe(201);
    expect(await registered.json()).toEqual({
      account: { accountId: expect.stringMatching(/^account_[0-9a-f]{32}$/) },
    });

    const signedIn = await handler(accountRequest("/v1/account-sessions", credentials));
    expect(signedIn.status).toBe(201);
    expect(signedIn.headers.get("set-cookie")).toContain("__Host-account=account_session_");
  });

  test("rejects a duplicate username with conflict", async () => {
    const handler = fixture();
    const credentials = { username: "duplicate", password: "duplicate-password" };

    expect((await handler(accountRequest("/v1/accounts", credentials))).status).toBe(201);
    const duplicate = await handler(
      accountRequest("/v1/accounts", {
        username: "DUPLICATE",
        password: "another-password",
      }),
    );

    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: "USERNAME_TAKEN" });
  });

  test("rejects invalid usernames and short passwords", async () => {
    const handler = fixture();
    const invalidUsername = await handler(
      accountRequest("/v1/accounts", { username: "not valid!", password: "valid-password" }),
    );
    const shortPassword = await handler(
      accountRequest("/v1/accounts", { username: "valid-user", password: "short" }),
    );

    expect(invalidUsername.status).toBe(400);
    expect(await invalidUsername.json()).toEqual({ error: "USERNAME_INVALID" });
    expect(shortPassword.status).toBe(400);
    expect(await shortPassword.json()).toEqual({ error: "PASSWORD_TOO_SHORT" });
  });

  test("never returns plaintext passwords or password hashes", async () => {
    const handler = fixture();
    const password = "private-password-value";
    const registration = await handler(
      accountRequest("/v1/accounts", { username: "secret-user", password }),
    );
    const registrationBody = await registration.text();
    const signIn = await handler(
      accountRequest("/v1/account-sessions", { username: "secret-user", password }),
    );
    const signInBody = await signIn.text();

    for (const body of [registrationBody, signInBody]) {
      expect(body).not.toContain(password);
      expect(body).not.toContain("$argon2id$");
      expect(body.toLowerCase()).not.toContain("password_hash");
    }
  });

  test("rejects cross-origin registration", async () => {
    const response = await fixture()(
      accountRequest(
        "/v1/accounts",
        { username: "cross-origin", password: "cross-origin-password" },
        "https://attacker.example.test/sign-up",
      ),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "mutation_origin_forbidden" });
  });
});
