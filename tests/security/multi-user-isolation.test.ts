import { describe, expect, test } from "bun:test";
import { PublishedDeckArtifactSchema } from "@impromptu/contracts/public";
import { PreparedEvidenceProjectionGateway } from "@impromptu/projection-gateway";
import { createAccountDirectory } from "../../services/private-backend/src/account-directory.ts";
import { parsePrivateBackendConfig } from "../../services/private-backend/src/config.ts";
import { createPrivateBackendHandler } from "../../services/private-backend/src/http.ts";
import { PreparedEvidenceCoordinator } from "../../services/private-backend/src/prepared-evidence.ts";

const consoleOrigin = "https://console.example.test";
const internalToken = "multi-user-internal-token";
const deck = PublishedDeckArtifactSchema.parse({
  deckVersion: "deck_multi_user",
  manifestHash: "c".repeat(64),
  title: "Multi user deck",
  slides: [
    {
      publicSlideKey: "slide_multi_one",
      ordinal: 1,
      accessibilityLabel: "First slide",
      image: {
        url: "https://public.example.test/one.png",
        contentHash: "d".repeat(64),
        width: 1920,
        height: 1080,
      },
    },
    {
      publicSlideKey: "slide_multi_two",
      ordinal: 2,
      accessibilityLabel: "Second slide",
      image: {
        url: "https://public.example.test/two.png",
        contentHash: "e".repeat(64),
        width: 1920,
        height: 1080,
      },
    },
  ],
});

function privateRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`https://private.example.test${path}`, {
    ...init,
    headers: {
      Origin: consoleOrigin,
      Referer: `${consoleOrigin}/`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

interface SignedInUser {
  readonly accountId: string;
  readonly cookie: string;
  readonly csrf: string;
}

async function multiUserFixture() {
  const directory = createAccountDirectory();
  const coordinator = new PreparedEvidenceCoordinator(new PreparedEvidenceProjectionGateway());
  const handler = createPrivateBackendHandler(
    parsePrivateBackendConfig({ CONSOLE_ORIGIN: consoleOrigin }),
    {
      coordinator,
      identityVerifier: directory,
      internalAuthToken: internalToken,
      now: () => 1_000,
    },
  );

  const signIn = async (username: string, password: string): Promise<Response> =>
    handler(
      privateRequest("/v1/account-sessions", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      }),
    );

  const register = async (username: string, password: string): Promise<SignedInUser> => {
    const created = await directory.register({ username, password }, 1_000);
    if (created.outcome !== "APPLIED") throw new Error(`registration failed: ${created.reason}`);
    const response = await signIn(username, password);
    expect(response.status).toBe(201);
    const payload = (await response.json()) as {
      account: { accountId: string };
      csrfToken: string;
    };
    return {
      accountId: payload.account.accountId,
      cookie: response.headers.get("set-cookie")?.split(";", 1)[0] ?? "",
      csrf: payload.csrfToken,
    };
  };

  const createPresentation = async (owner: SignedInUser): Promise<string> => {
    const created = await handler(
      privateRequest("/v1/presentation-sessions", {
        method: "POST",
        headers: { Cookie: owner.cookie, "x-csrf-token": owner.csrf },
        body: JSON.stringify({
          privateDeck: {
            deckId: "private_deck_multi",
            deckVersion: deck.deckVersion,
            manifestHash: deck.manifestHash,
            ownerAccountId: owner.accountId,
            title: "Owner deck",
            aclPolicyVersion: "acl-policy-1",
            privateObjectPrefix: `private-decks/${owner.accountId}/multi`,
            slides: [
              {
                privateSlideId: "private_slide_multi",
                publicSlideKey: "slide_multi_one",
                ordinal: 1,
                speakerNotes: "owner notes",
                extractedText: "owner text",
                sourceAssetIds: ["asset_multi"],
              },
            ],
          },
          publicDeck: deck,
        }),
      }),
    );
    expect(created.status).toBe(201);
    const payload = (await created.json()) as {
      lifecycle: { presentationSessionId: string };
    };
    return payload.lifecycle.presentationSessionId;
  };

  return { directory, handler, register, signIn, createPresentation };
}

describe("Multi-user account isolation", () => {
  test("issues a distinct account to every registered user", async () => {
    const fixture = await multiUserFixture();
    const alice = await fixture.register("alice", "alice-password-1");
    const bob = await fixture.register("bob", "bob-password-1");

    expect(alice.accountId).not.toBe(bob.accountId);
    expect(alice.cookie).not.toBe(bob.cookie);
    expect(alice.csrf).not.toBe(bob.csrf);
  });

  test("separates two users who chose the same password", async () => {
    const fixture = await multiUserFixture();
    const shared = "identical-password-1";
    const first = await fixture.register("carol", shared);
    const second = await fixture.register("dave", shared);

    expect(first.accountId).not.toBe(second.accountId);
  });

  test("rejects a wrong password and an unknown username without creating a session", async () => {
    const fixture = await multiUserFixture();
    await fixture.register("erin", "erin-password-1");

    const wrongPassword = await fixture.signIn("erin", "erin-password-2");
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.headers.get("set-cookie")).toBeNull();

    const unknownUser = await fixture.signIn("nobody", "erin-password-1");
    expect(unknownUser.status).toBe(401);
    expect(unknownUser.headers.get("set-cookie")).toBeNull();
  });

  test("never returns the password or its hash over the wire", async () => {
    const fixture = await multiUserFixture();
    const password = "frank-password-1";
    const created = await fixture.signIn("frank", password);
    expect(created.status).toBe(401);

    await fixture.register("frank", password);
    const authenticated = await fixture.signIn("frank", password);
    const body = await authenticated.text();
    expect(body).not.toContain(password);
    expect(body.toLowerCase()).not.toContain("password");
    expect(body).not.toContain("argon2");
  });

  test("refuses a duplicate username regardless of letter case", async () => {
    const fixture = await multiUserFixture();
    await fixture.register("grace", "grace-password-1");

    const duplicate = await fixture.directory.register(
      { username: "GRACE", password: "grace-password-2" },
      1_000,
    );
    expect(duplicate.outcome).toBe("REJECTED");
  });

  test("denies every cross-account mutation on another user's presentation", async () => {
    const fixture = await multiUserFixture();
    const owner = await fixture.register("owner", "owner-password-1");
    const stranger = await fixture.register("stranger", "stranger-password-1");
    const presentationSessionId = await fixture.createPresentation(owner);

    const strangerPost = (path: string, body: Record<string, unknown>) =>
      fixture.handler(
        privateRequest(path, {
          method: "POST",
          headers: { Cookie: stranger.cookie, "x-csrf-token": stranger.csrf },
          body: JSON.stringify(body),
        }),
      );

    const slideSet = await strangerPost("/v1/playback/slide-set", {
      presentationSessionId,
      commandId: "cmd_stranger",
      publicSlideKey: "slide_multi_two",
      displayBindingEpoch: "dbe_1",
      baseRevision: "cr_0",
    });
    expect(slideSet.status).not.toBe(202);
    expect((await slideSet.json()) as { error: string }).toEqual({ error: "UNAUTHORIZED" });

    const displayBinding = await strangerPost("/v1/display-bindings", {
      presentationSessionId,
      displayJoinId: `join_${"a".repeat(32)}`,
      approvedDisplayId: "display_stranger",
      approvedDisplayFingerprint: "stranger-fingerprint",
      expectedDeckVersion: deck.deckVersion,
      expectedDisplayBindingEpoch: "dbe_0",
    });
    expect(displayBinding.status).not.toBe(201);

    const terminate = await strangerPost("/v1/publications/terminate", {
      presentationSessionId,
      projectionId: "projection_stranger",
      expectedPublicCardRevision: "pcr_1",
      authorityId: "authority_stranger",
      status: "RETRACTED",
    });
    expect(terminate.status).not.toBe(200);

    const read = await fixture.handler(
      privateRequest(
        `/v1/publications/live-candidates?presentationSessionId=${presentationSessionId}`,
        { headers: { Cookie: stranger.cookie } },
      ),
    );
    expect(read.status).toBe(403);
  });

  test("lets the owner keep controlling the presentation the stranger was denied", async () => {
    const fixture = await multiUserFixture();
    const owner = await fixture.register("keeper", "keeper-password-1");
    const stranger = await fixture.register("intruder", "intruder-password-1");
    const presentationSessionId = await fixture.createPresentation(owner);

    const denied = await fixture.handler(
      privateRequest(
        `/v1/publications/live-candidates?presentationSessionId=${presentationSessionId}`,
        { headers: { Cookie: stranger.cookie } },
      ),
    );
    expect(denied.status).toBe(403);

    const allowed = await fixture.handler(
      privateRequest(
        `/v1/publications/live-candidates?presentationSessionId=${presentationSessionId}`,
        { headers: { Cookie: owner.cookie } },
      ),
    );
    expect(allowed.status).toBe(200);
  });
});
