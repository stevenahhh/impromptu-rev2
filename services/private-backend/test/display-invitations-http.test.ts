import { describe, expect, test } from "bun:test";
import {
  createProjectionGatewayStore,
  PreparedEvidenceProjectionGateway,
  type ProjectionGatewayStore,
} from "@impromptu/projection-gateway";
import { parsePrivateBackendConfig } from "../src/config.ts";
import { createPrivateBackendHandler } from "../src/http.ts";
import {
  createPreparedEvidenceStore,
  PreparedEvidenceCoordinator,
} from "../src/prepared-evidence.ts";

const manifestHash = "a".repeat(64);
const imageHash = "c".repeat(64);
const privateDeck = {
  deckId: "private_deck_alpha",
  deckVersion: "deck_alpha",
  manifestHash,
  title: "Prepared deck",
  ownerAccountId: "account_alpha",
  aclPolicyVersion: "acl-1",
  privateObjectPrefix: "private-decks/account-alpha/deck-alpha",
  slides: [
    {
      privateSlideId: "private_slide_one",
      publicSlideKey: "slide_one",
      ordinal: 1,
      speakerNotes: "private note",
      extractedText: "Slide one",
      sourceAssetIds: ["asset_one"],
    },
  ],
};
const publicDeck = {
  deckVersion: "deck_alpha",
  manifestHash,
  title: "Prepared deck",
  slides: [
    {
      publicSlideKey: "slide_one",
      ordinal: 1,
      image: {
        url: "https://public.example.test/one.png",
        contentHash: imageHash,
        width: 1920,
        height: 1080,
      },
      accessibilityLabel: "Slide one",
    },
  ],
};
const browserHeaders = {
  Origin: "https://console.example.test",
  Referer: "https://console.example.test/",
  "content-type": "application/json",
};

interface SignedInSession {
  readonly cookie: string;
  readonly csrfToken: string;
}

type TestHandler = (request: Request) => Response | Promise<Response>;

async function signIn(handler: TestHandler, username: string): Promise<SignedInSession> {
  const login = await handler(
    new Request("http://service.test/v1/account-sessions", {
      method: "POST",
      headers: browserHeaders,
      body: JSON.stringify({ username, password: "password" }),
    }),
  );
  const body = (await login.json()) as { csrfToken?: string };
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined || body.csrfToken === undefined) {
    throw new Error("login fixture did not produce a session");
  }
  return { cookie, csrfToken: body.csrfToken };
}

function authedHeaders(session: SignedInSession): Record<string, string> {
  return {
    ...browserHeaders,
    Cookie: session.cookie,
    "x-csrf-token": session.csrfToken,
  };
}

async function createPresentation(handler: TestHandler, session: SignedInSession) {
  const response = await handler(
    new Request("http://service.test/v1/presentation-sessions", {
      method: "POST",
      headers: authedHeaders(session),
      body: JSON.stringify({ privateDeck, publicDeck }),
    }),
  );
  if (response.status !== 201) throw new Error("presentation fixture failed");
  const body = (await response.json()) as {
    lifecycle: { presentationSessionId: string };
  };
  return body.lifecycle.presentationSessionId;
}

interface Harness {
  readonly handler: TestHandler;
  readonly gateway: PreparedEvidenceProjectionGateway;
  readonly gatewayStore: ProjectionGatewayStore;
  readonly clock: { now: number };
  readonly owner: SignedInSession;
}

async function createHarness(): Promise<Harness> {
  const clock = { now: 1_000 };
  const gatewayStore = createProjectionGatewayStore();
  const gateway = new PreparedEvidenceProjectionGateway(gatewayStore);
  const coordinator = new PreparedEvidenceCoordinator(gateway, createPreparedEvidenceStore(), {
    accountSessionTtlMs: 8 * 60 * 60 * 1_000,
  });
  const handler = createPrivateBackendHandler(
    parsePrivateBackendConfig({ CONSOLE_ORIGIN: "https://console.example.test" }),
    {
      coordinator,
      identityVerifier: {
        async verifyCredentials(username) {
          return username === "presenter"
            ? { accountId: "account_alpha", actorId: "actor_alpha" }
            : username === "other"
              ? { accountId: "account_beta", actorId: "actor_beta" }
              : null;
        },
      },
      internalAuthToken: "private-http-test-token",
      now: () => clock.now,
    },
  );
  const owner = await signIn(handler, "presenter");
  return { handler, gateway, gatewayStore, clock, owner };
}

async function issueInvitation(
  handler: TestHandler,
  session: SignedInSession,
  presentationSessionId: string,
) {
  return handler(
    new Request("http://service.test/v1/display-invitations", {
      method: "POST",
      headers: authedHeaders(session),
      body: JSON.stringify({ presentationSessionId }),
    }),
  );
}

async function pendingInvitation(
  handler: TestHandler,
  session: SignedInSession,
  invitationId: string,
) {
  return handler(
    new Request(`http://service.test/v1/display-invitations/${invitationId}/pending`, {
      headers: authedHeaders(session),
    }),
  );
}

async function approveDisplay(
  handler: TestHandler,
  session: SignedInSession,
  input: Record<string, unknown>,
) {
  return handler(
    new Request("http://service.test/v1/display-bindings", {
      method: "POST",
      headers: authedHeaders(session),
      body: JSON.stringify(input),
    }),
  );
}

describe("display invitation boundary", () => {
  test("issues a one-use invitation, exposes it to the owner, and binds it with CAS", async () => {
    const { handler, gateway, owner } = await createHarness();
    const presentationSessionId = await createPresentation(handler, owner);

    const issued = await issueInvitation(handler, owner, presentationSessionId);
    expect(issued.status).toBe(201);
    const invitation = (await issued.json()) as Record<string, unknown>;
    expect(invitation.invitationId).toMatch(/^dinvite_[0-9a-f]{32}$/);
    expect(invitation.token).toMatch(/^dinv_[0-9a-f]{64}$/);
    expect(invitation.deckVersion).toBe(publicDeck.deckVersion);
    expect(invitation.expiresAtMs).toBe(91_000);
    // The secret travels only in the URL fragment — never a query parameter.
    expect(invitation.stagePath).toBe(
      `/?deck=${publicDeck.deckVersion}#invite=${invitation.token}`,
    );
    expect(String(invitation.stagePath)).not.toMatch(/\?[^#]*dinv_/);
    expect(invitation).not.toHaveProperty("audienceDisplaySessionId");

    const pending = await pendingInvitation(handler, owner, String(invitation.invitationId));
    expect(pending.status).toBe(200);
    const pendingView = (await pending.json()) as Record<string, unknown>;
    expect(pendingView.status).toBe("PENDING");
    expect(pendingView.displayBindingEpoch).toBe("dbe_0");
    expect(pendingView.join).toBeNull();
    expect(pendingView).not.toHaveProperty("token");
    expect(pendingView).not.toHaveProperty("tokenDigest");

    // Stage side: the token exchanges for a pending join locator, no authority attached.
    const exchanged = gateway.exchangeDisplayInvitation(
      {
        invitationToken: String(invitation.token),
        displayId: "display_projector",
        deckVersion: publicDeck.deckVersion,
        displayFingerprint: "fingerprint-visible-projector",
      },
      2_000,
    );
    expect(exchanged.outcome).toBe("CREATED");
    if (exchanged.outcome !== "CREATED") throw new Error("exchange fixture failed");

    const joined = await pendingInvitation(handler, owner, String(invitation.invitationId));
    const joinedView = (await joined.json()) as {
      status: string;
      displayBindingEpoch: string;
      join: { displayId: string; displayFingerprint: string; displayJoinId: string } | null;
    };
    expect(joinedView.status).toBe("JOINED");
    expect(joinedView.displayBindingEpoch).toBe("dbe_0");
    expect(joinedView.join?.displayId).toBe("display_projector");
    expect(joinedView.join?.displayFingerprint).toBe("fingerprint-visible-projector");

    // The presenter gesture approves the exact visible fingerprint at the current CAS.
    const bound = await approveDisplay(handler, owner, {
      presentationSessionId,
      displayJoinId: joinedView.join?.displayJoinId,
      expectedDisplayBindingEpoch: joinedView.displayBindingEpoch,
      expectedDeckVersion: publicDeck.deckVersion,
      approvedDisplayId: "display_projector",
      approvedDisplayFingerprint: "fingerprint-visible-projector",
    });
    expect(bound.status).toBe(201);
    const session = (await bound.json()) as {
      binding: { displayBindingEpoch: string };
    };
    expect(session.binding.displayBindingEpoch).toBe("dbe_1");
  });

  test("rejects wrong-owner issuance and pending reads before any public side effect", async () => {
    const { handler, gatewayStore, owner } = await createHarness();
    const presentationSessionId = await createPresentation(handler, owner);
    const outsider = await signIn(handler, "other");

    const stolenIssue = await issueInvitation(handler, outsider, presentationSessionId);
    expect(stolenIssue.status).toBe(403);
    expect(await stolenIssue.json()).toEqual({ error: "unauthorized" });
    expect(gatewayStore.invitations.size).toBe(0);

    const issued = await issueInvitation(handler, owner, presentationSessionId);
    const invitation = (await issued.json()) as { invitationId: string };
    const outsiderRead = await pendingInvitation(handler, outsider, invitation.invitationId);
    expect(outsiderRead.status).toBe(403);
  });

  test("an expired invitation reports EXPIRED and its exchange is refused", async () => {
    const { handler, gateway, clock, owner } = await createHarness();
    const presentationSessionId = await createPresentation(handler, owner);
    const issued = await issueInvitation(handler, owner, presentationSessionId);
    const invitation = (await issued.json()) as { invitationId: string; token: string };

    clock.now = 91_000;
    const expired = await pendingInvitation(handler, owner, invitation.invitationId);
    expect((await expired.json()).status).toBe("EXPIRED");
    expect(
      gateway.exchangeDisplayInvitation(
        {
          invitationToken: invitation.token,
          displayId: "display_late",
          deckVersion: publicDeck.deckVersion,
          displayFingerprint: "fingerprint-late-display",
        },
        clock.now,
      ),
    ).toEqual({ outcome: "REJECTED", reason: "INVITATION_EXPIRED" });
  });

  test("a stale binding epoch is refused before the projection is touched", async () => {
    const { handler, gateway, owner } = await createHarness();
    const presentationSessionId = await createPresentation(handler, owner);
    const issued = await issueInvitation(handler, owner, presentationSessionId);
    const invitation = (await issued.json()) as { token: string };
    const exchanged = gateway.exchangeDisplayInvitation(
      {
        invitationToken: invitation.token,
        displayId: "display_projector",
        deckVersion: publicDeck.deckVersion,
        displayFingerprint: "fingerprint-visible-projector",
      },
      2_000,
    );
    if (exchanged.outcome !== "CREATED") throw new Error("exchange fixture failed");

    const first = await approveDisplay(handler, owner, {
      presentationSessionId,
      displayJoinId: exchanged.locator.displayJoinId,
      expectedDisplayBindingEpoch: "dbe_0",
      expectedDeckVersion: publicDeck.deckVersion,
      approvedDisplayId: "display_projector",
      approvedDisplayFingerprint: "fingerprint-visible-projector",
    });
    expect(first.status).toBe(201);

    const secondJoin = gateway.exchangeDisplayInvitation(
      {
        invitationToken: String(
          (
            (await (await issueInvitation(handler, owner, presentationSessionId)).json()) as {
              token: string;
            }
          ).token,
        ),
        displayId: "display_spare",
        deckVersion: publicDeck.deckVersion,
        displayFingerprint: "fingerprint-spare-display",
      },
      3_000,
    );
    if (secondJoin.outcome !== "CREATED") throw new Error("second exchange fixture failed");

    // A client replaying the old epoch is refused without touching the public binding.
    const stale = await approveDisplay(handler, owner, {
      presentationSessionId,
      displayJoinId: secondJoin.locator.displayJoinId,
      expectedDisplayBindingEpoch: "dbe_0",
      expectedDeckVersion: publicDeck.deckVersion,
      approvedDisplayId: "display_spare",
      approvedDisplayFingerprint: "fingerprint-spare-display",
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "STALE_DISPLAY_BINDING" });

    const rebound = await approveDisplay(handler, owner, {
      presentationSessionId,
      displayJoinId: secondJoin.locator.displayJoinId,
      expectedDisplayBindingEpoch: "dbe_1",
      expectedDeckVersion: publicDeck.deckVersion,
      approvedDisplayId: "display_spare",
      approvedDisplayFingerprint: "fingerprint-spare-display",
    });
    expect(rebound.status).toBe(201);
    expect(
      ((await rebound.json()) as { binding: { displayBindingEpoch: string } }).binding
        .displayBindingEpoch,
    ).toBe("dbe_2");
  });

  test("the pending read returns the authoritative epoch after a binding rotates", async () => {
    const { handler, gateway, owner } = await createHarness();
    const presentationSessionId = await createPresentation(handler, owner);

    const first = await issueInvitation(handler, owner, presentationSessionId);
    const firstInvitation = (await first.json()) as { token: string };
    const firstJoin = gateway.exchangeDisplayInvitation(
      {
        invitationToken: firstInvitation.token,
        displayId: "display_projector",
        deckVersion: publicDeck.deckVersion,
        displayFingerprint: "fingerprint-visible-projector",
      },
      2_000,
    );
    if (firstJoin.outcome !== "CREATED") throw new Error("first exchange fixture failed");
    const bound = await approveDisplay(handler, owner, {
      presentationSessionId,
      displayJoinId: firstJoin.locator.displayJoinId,
      expectedDisplayBindingEpoch: "dbe_0",
      expectedDeckVersion: publicDeck.deckVersion,
      approvedDisplayId: "display_projector",
      approvedDisplayFingerprint: "fingerprint-visible-projector",
    });
    expect(bound.status).toBe(201);

    // A reopened Stage pairs through a fresh invitation; its pending read must answer the
    // CURRENT epoch (dbe_1), never the constant "dbe_0" the retired client replayed.
    const second = await issueInvitation(handler, owner, presentationSessionId);
    const secondInvitation = (await second.json()) as { invitationId: string; token: string };
    const secondJoin = gateway.exchangeDisplayInvitation(
      {
        invitationToken: secondInvitation.token,
        displayId: "display_spare",
        deckVersion: publicDeck.deckVersion,
        displayFingerprint: "fingerprint-spare-display",
      },
      3_000,
    );
    if (secondJoin.outcome !== "CREATED") throw new Error("second exchange fixture failed");

    const pending = await pendingInvitation(handler, owner, secondInvitation.invitationId);
    expect(pending.status).toBe(200);
    const view = (await pending.json()) as {
      status: string;
      displayBindingEpoch: string;
      join: { displayJoinId: string; displayId: string; displayFingerprint: string } | null;
    };
    expect(view.status).toBe("JOINED");
    expect(view.displayBindingEpoch).toBe("dbe_1");
    // The pending identity is the fresh display that just asked to join, not the bound one.
    expect(view.join?.displayId).toBe("display_spare");
    expect(view.join?.displayFingerprint).toBe("fingerprint-spare-display");

    const rebound = await approveDisplay(handler, owner, {
      presentationSessionId,
      displayJoinId: view.join?.displayJoinId,
      expectedDisplayBindingEpoch: view.displayBindingEpoch,
      expectedDeckVersion: publicDeck.deckVersion,
      approvedDisplayId: "display_spare",
      approvedDisplayFingerprint: "fingerprint-spare-display",
    });
    expect(rebound.status).toBe(201);
    expect(
      ((await rebound.json()) as { binding: { displayBindingEpoch: string } }).binding
        .displayBindingEpoch,
    ).toBe("dbe_2");
  });

  test("a rebound display revokes the previous projection", async () => {
    const { handler, gateway, owner } = await createHarness();
    const presentationSessionId = await createPresentation(handler, owner);

    const issued = await issueInvitation(handler, owner, presentationSessionId);
    const invitation = (await issued.json()) as { token: string };
    const join = gateway.exchangeDisplayInvitation(
      {
        invitationToken: invitation.token,
        displayId: "display_projector",
        deckVersion: publicDeck.deckVersion,
        displayFingerprint: "fingerprint-visible-projector",
      },
      2_000,
    );
    if (join.outcome !== "CREATED") throw new Error("exchange fixture failed");
    const bound = await approveDisplay(handler, owner, {
      presentationSessionId,
      displayJoinId: join.locator.displayJoinId,
      expectedDisplayBindingEpoch: "dbe_0",
      expectedDeckVersion: publicDeck.deckVersion,
      approvedDisplayId: "display_projector",
      approvedDisplayFingerprint: "fingerprint-visible-projector",
    });
    expect(bound.status).toBe(201);
    const session = (await bound.json()) as { audienceDisplaySessionId: string };

    const closeReasons: string[] = [];
    const socket = gateway.connectStage(
      session.audienceDisplaySessionId,
      { onPlayback: () => {}, onClose: (reason) => closeReasons.push(reason) },
      4_000,
    );
    expect(socket?.closed).toBe(false);

    const reissue = await issueInvitation(handler, owner, presentationSessionId);
    const reissued = (await reissue.json()) as { token: string };
    const secondJoin = gateway.exchangeDisplayInvitation(
      {
        invitationToken: reissued.token,
        displayId: "display_spare",
        deckVersion: publicDeck.deckVersion,
        displayFingerprint: "fingerprint-spare-display",
      },
      5_000,
    );
    if (secondJoin.outcome !== "CREATED") throw new Error("rebind exchange fixture failed");
    const rebound = await approveDisplay(handler, owner, {
      presentationSessionId,
      displayJoinId: secondJoin.locator.displayJoinId,
      expectedDisplayBindingEpoch: "dbe_1",
      expectedDeckVersion: publicDeck.deckVersion,
      approvedDisplayId: "display_spare",
      approvedDisplayFingerprint: "fingerprint-spare-display",
    });
    expect(rebound.status).toBe(201);

    // The old Stage loses authority the moment the new binding lands: its realtime socket is
    // closed as REBOUND and the superseded display session can no longer read a snapshot.
    expect(socket?.closed).toBe(true);
    expect(closeReasons).toEqual(["REBOUND"]);
    expect(gateway.snapshot(session.audienceDisplaySessionId, 6_000)).toBeNull();
  });

  test("the approval body never carries invitation token material", async () => {
    const { handler, gateway, gatewayStore, owner } = await createHarness();
    const presentationSessionId = await createPresentation(handler, owner);
    const issued = await issueInvitation(handler, owner, presentationSessionId);
    const invitation = (await issued.json()) as { token: string };
    const join = gateway.exchangeDisplayInvitation(
      {
        invitationToken: invitation.token,
        displayId: "display_projector",
        deckVersion: publicDeck.deckVersion,
        displayFingerprint: "fingerprint-visible-projector",
      },
      2_000,
    );
    if (join.outcome !== "CREATED") throw new Error("exchange fixture failed");

    // A URL secret pasted into the approval body is not display authority: the closed DTO
    // rejects the smuggled field before any projection call, leaving the join untouched.
    const smuggled = await approveDisplay(handler, owner, {
      presentationSessionId,
      displayJoinId: join.locator.displayJoinId,
      expectedDisplayBindingEpoch: "dbe_0",
      expectedDeckVersion: publicDeck.deckVersion,
      approvedDisplayId: "display_projector",
      approvedDisplayFingerprint: "fingerprint-visible-projector",
      invitationToken: invitation.token,
    });
    expect(smuggled.status).toBe(409);
    expect(await smuggled.json()).toEqual({ error: "INVALID_DISPLAY_APPROVAL" });
    expect(gatewayStore.joins.get(join.locator.displayJoinId)?.consumed).toBe(false);

    const clean = await approveDisplay(handler, owner, {
      presentationSessionId,
      displayJoinId: join.locator.displayJoinId,
      expectedDisplayBindingEpoch: "dbe_0",
      expectedDeckVersion: publicDeck.deckVersion,
      approvedDisplayId: "display_projector",
      approvedDisplayFingerprint: "fingerprint-visible-projector",
    });
    expect(clean.status).toBe(201);
  });

  test("a forged display identity never reaches the projection", async () => {
    const { handler, gateway, owner } = await createHarness();
    const presentationSessionId = await createPresentation(handler, owner);
    const issued = await issueInvitation(handler, owner, presentationSessionId);
    const invitation = (await issued.json()) as { token: string };
    const exchanged = gateway.exchangeDisplayInvitation(
      {
        invitationToken: invitation.token,
        displayId: "display_projector",
        deckVersion: publicDeck.deckVersion,
        displayFingerprint: "fingerprint-visible-projector",
      },
      2_000,
    );
    if (exchanged.outcome !== "CREATED") throw new Error("exchange fixture failed");

    const forged = await approveDisplay(handler, owner, {
      presentationSessionId,
      displayJoinId: exchanged.locator.displayJoinId,
      expectedDisplayBindingEpoch: "dbe_0",
      expectedDeckVersion: publicDeck.deckVersion,
      approvedDisplayId: "display_projector",
      approvedDisplayFingerprint: "fingerprint-attacker-claim",
    });
    expect(forged.status).toBe(409);
    expect(await forged.json()).toEqual({ error: "DISPLAY_IDENTITY_MISMATCH" });
  });

  test("issuance demands the console origin, the session cookie, and CSRF", async () => {
    const { handler, owner } = await createHarness();
    const presentationSessionId = await createPresentation(handler, owner);
    const payload = JSON.stringify({ presentationSessionId });

    const wrongOrigin = await handler(
      new Request("http://service.test/v1/display-invitations", {
        method: "POST",
        headers: {
          ...browserHeaders,
          Origin: "https://console.example.test.attacker.invalid",
          Cookie: owner.cookie,
          "x-csrf-token": owner.csrfToken,
        },
        body: payload,
      }),
    );
    expect(wrongOrigin.status).toBe(403);

    const noSession = await handler(
      new Request("http://service.test/v1/display-invitations", {
        method: "POST",
        headers: browserHeaders,
        body: payload,
      }),
    );
    expect(noSession.status).toBe(401);

    const noCsrf = await handler(
      new Request("http://service.test/v1/display-invitations", {
        method: "POST",
        headers: { ...browserHeaders, Cookie: owner.cookie },
        body: payload,
      }),
    );
    expect(noCsrf.status).toBe(403);
    expect(await noCsrf.json()).toEqual({ error: "csrf_rejected" });
  });
});
