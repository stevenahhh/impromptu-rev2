import { describe, expect, test } from "bun:test";
import { PublishedDeckArtifactSchema } from "@impromptu/contracts/public";
import { parseProjectionGatewayConfig } from "../src/config.ts";
import { createProjectionGatewayHandler } from "../src/http.ts";
import {
  createProjectionGatewayStore,
  PreparedEvidenceProjectionGateway,
  restoreDisplayInvitationState,
  restoreProjectionGatewayStore,
  snapshotDisplayInvitationState,
  snapshotProjectionGatewayStore,
} from "../src/prepared-evidence.ts";

const stageOrigin = "https://stage.example.test";
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
const internalHeaders = {
  authorization: "Bearer internal-test-token-alpha",
  "content-type": "application/json",
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

function internalRequest(path: string, init: RequestInit = {}) {
  return new Request(`https://projection.example.test${path}`, {
    ...init,
    headers: { ...internalHeaders, ...init.headers },
  });
}

function handlerFor(
  gateway: PreparedEvidenceProjectionGateway,
  now: () => number,
  hooks: {
    persisted?: unknown[];
    persistedInvitations?: unknown[];
    store?: ReturnType<typeof createProjectionGatewayStore>;
  } = {},
) {
  return createProjectionGatewayHandler(
    parseProjectionGatewayConfig({ STAGE_ORIGIN: stageOrigin }),
    {
      gateway,
      internalAuthToken: "internal-test-token-alpha",
      now,
      async persist() {
        if (hooks.store !== undefined) {
          hooks.persisted?.push(snapshotProjectionGatewayStore(hooks.store));
        }
      },
      async persistInvitations() {
        if (hooks.store !== undefined) {
          hooks.persistedInvitations?.push(snapshotDisplayInvitationState(hooks.store));
        }
      },
      stageReceiptWriter: {
        async recordApplied() {
          return null;
        },
      },
    },
  );
}

function issueRequest(nowMs = 1_000, presentationSessionId = "ps_alpha") {
  return internalRequest("/internal/display-invitations", {
    method: "POST",
    body: JSON.stringify({
      presentationSessionId,
      deckVersion: deck.deckVersion,
      nowMs,
    }),
  });
}

async function issue(
  handler: ReturnType<typeof handlerFor>,
  nowMs = 1_000,
  presentationSessionId = "ps_alpha",
) {
  const response = await handler(issueRequest(nowMs, presentationSessionId));
  expect(response.status).toBe(201);
  const body = (await response.json()) as { token: string; invitationId: string };
  return body;
}

function joinRequest(token: string | undefined, overrides: Record<string, unknown> = {}) {
  return stageRequest("/v1/display-joins", {
    method: "POST",
    body: JSON.stringify({
      displayId: "display_alpha",
      deckVersion: deck.deckVersion,
      displayFingerprint: "fingerprint-stage-alpha",
      ...(token === undefined ? {} : { invitationToken: token }),
      ...overrides,
    }),
  });
}

describe("display invitation issuance (internal)", () => {
  test("mints a >=128-bit token, stores only its digest, and expires inside 90 seconds", async () => {
    const store = createProjectionGatewayStore();
    const gateway = new PreparedEvidenceProjectionGateway(store);
    const invitations: unknown[] = [];
    const handler = handlerFor(gateway, () => 1_000, {
      persistedInvitations: invitations,
      store,
    });

    const response = await handler(issueRequest());
    expect(response.status).toBe(201);
    const issued = (await response.json()) as Record<string, unknown>;
    expect(issued.invitationId).toMatch(/^dinvite_[0-9a-f]{32}$/);
    expect(issued.token).toMatch(/^dinv_[0-9a-f]{64}$/);
    expect(issued.deckVersion).toBe(deck.deckVersion);
    expect(issued.expiresAtMs).toBe(1_000 + 90_000);
    expect(invitations).toHaveLength(1);

    const stored = store.invitations.get(String(issued.invitationId));
    if (stored === undefined) throw new Error("invitation was not persisted in the store");
    expect(stored.tokenDigest).toMatch(/^[0-9a-f]{64}$/);
    const expectedDigest = new Bun.CryptoHasher("sha256")
      .update(String(issued.token))
      .digest("hex");
    expect(stored.tokenDigest).toBe(expectedDigest);
    expect(JSON.stringify(stored)).not.toContain(String(issued.token));
    expect(stored.join).toBeNull();
    expect(stored.consumedAtMs).toBeNull();
  });

  test("refuses issuance without the service bearer and rejects oversized TTLs", async () => {
    const gateway = new PreparedEvidenceProjectionGateway();
    const handler = handlerFor(gateway, () => 1_000);
    const anonymous = await handler(
      new Request("https://projection.example.test/internal/display-invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          presentationSessionId: "ps_alpha",
          deckVersion: deck.deckVersion,
          nowMs: 1_000,
        }),
      }),
    );
    expect(anonymous.status).toBe(401);
    expect(
      () => new PreparedEvidenceProjectionGateway(undefined, { invitationTtlMs: 90_001 }),
    ).toThrow();
  });
});

describe("display invitation exchange (public)", () => {
  test("exchanges a live token for exactly one pending join locator", async () => {
    const gateway = new PreparedEvidenceProjectionGateway();
    const handler = handlerFor(gateway, () => 1_000);
    const issued = await issue(handler);

    const joined = await handler(joinRequest(issued.token));
    expect(joined.status).toBe(201);
    const join = (await joined.json()) as Record<string, unknown>;
    expect(join.displayJoinId).toMatch(/^join_[0-9a-f]{32}$/);
    expect(join.displayId).toBe("display_alpha");
    // The exchange is non-authorizing: no display cookie and no binding material.
    expect(joined.headers.get("set-cookie")).toBeNull();
    expect(join.audienceDisplaySessionId).toBeUndefined();

    const replayed = await handler(joinRequest(issued.token));
    expect(replayed.status).toBe(409);
    expect(await replayed.json()).toEqual({
      outcome: "REJECTED",
      reason: "INVITATION_CONSUMED",
    });
  });

  test("rejects unknown, expired, wrong-deck, and malformed tokens with typed outcomes", async () => {
    const clock = { now: 1_000 };
    const gateway = new PreparedEvidenceProjectionGateway();
    const handler = handlerFor(gateway, () => clock.now);
    const issued = await issue(handler, 1_000);

    const malformed = await handler(joinRequest("not-a-token"));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid_request" });

    const unknown = await handler(joinRequest(`dinv_${"f".repeat(64)}`));
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      outcome: "REJECTED",
      reason: "INVITATION_UNKNOWN",
    });

    const wrongDeck = await handler(joinRequest(issued.token, { deckVersion: "deck_other" }));
    expect(wrongDeck.status).toBe(409);
    expect(await wrongDeck.json()).toEqual({
      outcome: "REJECTED",
      reason: "INVITATION_DECK_MISMATCH",
    });
    // The rejected exchange left the invitation unspent.
    clock.now = 90_999;
    const joined = await handler(joinRequest(issued.token));
    expect(joined.status).toBe(201);

    const second = await issue(handler, 1_000);
    clock.now = 91_000;
    const expired = await handler(joinRequest(second.token));
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({
      outcome: "REJECTED",
      reason: "INVITATION_EXPIRED",
    });
  });

  test("keeps the opener-style join without an invitation working", async () => {
    const gateway = new PreparedEvidenceProjectionGateway();
    const handler = handlerFor(gateway, () => 1_000);
    const response = await handler(joinRequest(undefined));
    expect(response.status).toBe(201);
  });

  test("a post-restart replay of a consumed invitation is still rejected", async () => {
    const store = createProjectionGatewayStore();
    const clock = { now: 1_000 };
    const gateway = new PreparedEvidenceProjectionGateway(store);
    const handler = handlerFor(gateway, () => clock.now);
    const issued = await issue(handler);
    const joined = await handler(joinRequest(issued.token));
    expect(joined.status).toBe(201);

    const persisted = snapshotDisplayInvitationState(store);
    const restartedStore = createProjectionGatewayStore();
    expect(restoreDisplayInvitationState(restartedStore, persisted)).toEqual({
      outcome: "RESTORED",
    });
    const restartedGateway = new PreparedEvidenceProjectionGateway(restartedStore);
    const restartedHandler = handlerFor(restartedGateway, () => clock.now);

    const replay = await restartedHandler(joinRequest(issued.token));
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({
      outcome: "REJECTED",
      reason: "INVITATION_CONSUMED",
    });
  });

  test("an unspent invitation survives a restart inside its TTL", async () => {
    const store = createProjectionGatewayStore();
    const clock = { now: 1_000 };
    const gateway = new PreparedEvidenceProjectionGateway(store);
    const handler = handlerFor(gateway, () => clock.now);
    const issued = await issue(handler);

    const persisted = snapshotDisplayInvitationState(store);
    const restartedStore = createProjectionGatewayStore();
    expect(restoreDisplayInvitationState(restartedStore, persisted).outcome).toBe("RESTORED");
    const restartedGateway = new PreparedEvidenceProjectionGateway(restartedStore);
    const restartedHandler = handlerFor(restartedGateway, () => clock.now);

    clock.now = 89_000;
    const joined = await restartedHandler(joinRequest(issued.token));
    expect(joined.status).toBe(201);
    const other = await issue(restartedHandler, 1_000, "ps_beta");
    clock.now = 91_001;
    const expired = await restartedHandler(joinRequest(other.token));
    expect(expired.status).toBe(410);
  });
});

describe("display invitation read (internal)", () => {
  test("reports pending and joined views to the service bearer only", async () => {
    const gateway = new PreparedEvidenceProjectionGateway();
    const handler = handlerFor(gateway, () => 1_000);
    const issued = await issue(handler);

    const anonymous = await handler(
      new Request(
        `https://projection.example.test/internal/display-invitations/${issued.invitationId}`,
      ),
    );
    expect(anonymous.status).toBe(401);
    const unknown = await handler(
      internalRequest(`/internal/display-invitations/dinvite_${"0".repeat(32)}`),
    );
    expect(unknown.status).toBe(404);

    const pending = await handler(
      internalRequest(`/internal/display-invitations/${issued.invitationId}`),
    );
    expect(pending.status).toBe(200);
    const pendingView = (await pending.json()) as Record<string, unknown>;
    expect(pendingView.status).toBe("PENDING");
    expect(pendingView.join).toBeNull();
    expect(pendingView.presentationSessionId).toBe("ps_alpha");
    expect(pendingView).not.toHaveProperty("token");
    expect(pendingView).not.toHaveProperty("tokenDigest");

    await handler(joinRequest(issued.token));
    const joined = await handler(
      internalRequest(`/internal/display-invitations/${issued.invitationId}`),
    );
    const joinedView = (await joined.json()) as Record<string, unknown>;
    expect(joinedView.status).toBe("JOINED");
    const join = joinedView.join as Record<string, unknown> | null;
    expect(join?.displayId).toBe("display_alpha");
    expect(join?.displayFingerprint).toBe("fingerprint-stage-alpha");
  });
});

describe("display invitation binding", () => {
  test("an invited join cannot bind a different presentation session", async () => {
    const gateway = new PreparedEvidenceProjectionGateway();
    const issued = gateway.issueDisplayInvitation(
      { presentationSessionId: "ps_alpha", deckVersion: deck.deckVersion },
      1_000,
    );
    if (issued.outcome !== "ISSUED") throw new Error("issuance fixture failed");
    const exchanged = gateway.exchangeDisplayInvitation(
      {
        invitationToken: issued.invitation.token,
        displayId: "display_alpha",
        deckVersion: deck.deckVersion,
        displayFingerprint: "fingerprint-stage-alpha",
      },
      2_000,
    );
    if (exchanged.outcome !== "CREATED") throw new Error("exchange fixture failed");

    const bound = gateway.bindDisplay(
      {
        displayJoinId: exchanged.locator.displayJoinId,
        presentationSessionId: "ps_beta",
        presentationSessionEpoch: "pse_1",
        expectedDisplayBindingEpoch: "dbe_0",
        expectedDeckVersion: deck.deckVersion,
        approvedDisplayId: exchanged.locator.displayId,
        approvedDisplayFingerprint: exchanged.locator.displayFingerprint,
        deck,
      },
      3_000,
    );
    expect(bound).toEqual({ outcome: "REJECTED", reason: "JOIN_SESSION_MISMATCH" });
  });

  test("the durable gateway snapshot keeps its previous closed shape", async () => {
    const store = createProjectionGatewayStore();
    const gateway = new PreparedEvidenceProjectionGateway(store);
    gateway.issueDisplayInvitation(
      { presentationSessionId: "ps_alpha", deckVersion: deck.deckVersion },
      1_000,
    );
    const snapshot = snapshotProjectionGatewayStore(store);
    expect(Object.keys(snapshot as object).sort()).toEqual(["joins", "projections", "stateKind"]);
    expect(restoreProjectionGatewayStore(snapshot).outcome).toBe("RESTORED");
    expect(JSON.stringify(snapshot)).not.toContain("invitation");
  });
});
