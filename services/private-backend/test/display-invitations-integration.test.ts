import { expect, test } from "bun:test";
import { AccountIdSchema } from "@impromptu/contracts/private";
import {
  AudienceDisplaySessionSchema,
  CreateDisplayInvitationResponseSchema,
  DisplayBindingEpochSchema,
  DisplayInvitationPendingViewSchema,
  DisplayJoinSchema,
} from "@impromptu/contracts/public";
import {
  createProjectionGatewayHandler,
  createProjectionGatewayStore,
  PreparedEvidenceProjectionGateway,
  parseProjectionGatewayConfig,
} from "@impromptu/projection-gateway";
import { parsePrivateBackendConfig } from "../src/config.ts";
import { createPrivateBackendHandler } from "../src/http.ts";
import { createPreparedDeckArtifacts } from "../src/prepared-deck-upload.ts";
import { PreparedEvidenceCoordinator } from "../src/prepared-evidence.ts";
import { ProjectionHttpPort } from "../src/projection-http-port.ts";

const consoleOrigin = "https://console.example.test";
const stageOrigin = "https://stage.example.test";
const internalAuthToken = "display-invitation-integration-token";

// Exercise both HTTP boundaries and the production service port, not an in-process gateway
// substituted for the port. Every request has a bounded deadline; expiry uses an injected clock.
test("HTTP invitation exchange stays non-authorizing until exact-identity, current-CAS approval", async () => {
  const clock = { now: 1_000 };
  const store = createProjectionGatewayStore();
  const gatewayServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createProjectionGatewayHandler(
      parseProjectionGatewayConfig({ STAGE_ORIGIN: stageOrigin }),
      {
        gateway: new PreparedEvidenceProjectionGateway(store),
        internalAuthToken,
        now: () => clock.now,
        stageReceiptWriter: {
          async recordApplied() {
            return null;
          },
        },
      },
    ),
  });
  const privateServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createPrivateBackendHandler(
      parsePrivateBackendConfig({ CONSOLE_ORIGIN: consoleOrigin }),
      {
        coordinator: new PreparedEvidenceCoordinator(
          new ProjectionHttpPort(gatewayServer.url.origin, internalAuthToken),
        ),
        internalAuthToken,
        now: () => clock.now,
        identityVerifier: {
          async verifyCredentials(username, password) {
            return username === "presenter" && password === "test-password"
              ? { accountId: "account_alpha", actorId: "actor_alpha" }
              : null;
          },
        },
      },
    ),
  });
  const consoleHeaders = new Headers({ Origin: consoleOrigin, Referer: `${consoleOrigin}/` });
  const stageHeaders = new Headers({ Origin: stageOrigin, Referer: `${stageOrigin}/` });
  const request = (base: URL, headers: Headers, path: string, body?: unknown) =>
    fetch(new URL(path, base), {
      method: body === undefined ? "GET" : "POST",
      headers: { ...Object.fromEntries(headers), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(2_000),
    });
  const privateRequest = (path: string, body?: unknown) =>
    request(privateServer.url, consoleHeaders, path, body);
  const publicRequest = (path: string, body?: unknown) =>
    request(gatewayServer.url, stageHeaders, path, body);

  try {
    const login = await privateRequest("/v1/account-sessions", {
      username: "presenter",
      password: "test-password",
    });
    expect(login.status).toBe(201);
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    const credentials = await login.json();
    if (cookie === undefined) throw new Error("sign-in did not return a cookie");
    consoleHeaders.set("cookie", cookie);
    consoleHeaders.set("x-csrf-token", credentials.csrfToken);

    const { privateDeck, publicDeck } = createPreparedDeckArtifacts(
      AccountIdSchema.parse("account_alpha"),
      { title: "Public deck", content: "PRIVATE_NOT_FOR_STAGE" },
    );
    const created = await privateRequest("/v1/presentation-sessions", { privateDeck, publicDeck });
    expect(created.status).toBe(201);
    const {
      lifecycle: { presentationSessionId },
    } = await created.json();
    const issue = async () => {
      const response = await privateRequest("/v1/display-invitations", { presentationSessionId });
      expect(response.status).toBe(201);
      return CreateDisplayInvitationResponseSchema.parse(await response.json());
    };
    const pending = async (invitationId: string) => {
      const response = await privateRequest(`/v1/display-invitations/${invitationId}/pending`);
      expect(response.status).toBe(200);
      return DisplayInvitationPendingViewSchema.parse(await response.json());
    };
    const invitation = await issue();
    expect(invitation.expiresAtMs - clock.now).toBeLessThanOrEqual(90_000);
    expect(new URL(invitation.stagePath, stageOrigin).searchParams.has("invite")).toBe(false);
    expect((await pending(invitation.invitationId)).displayBindingEpoch).toBe(
      DisplayBindingEpochSchema.parse("dbe_0"),
    );
    const joinInput = {
      displayId: "display_projector",
      deckVersion: publicDeck.deckVersion,
      displayFingerprint: "fingerprint-visible-projector",
      invitationToken: invitation.token,
    };
    // Racing the same token through the real route must produce only one pending join.
    const exchanges = await Promise.all([
      publicRequest("/v1/display-joins", joinInput),
      publicRequest("/v1/display-joins", joinInput),
    ]);
    expect(exchanges.map((response) => response.status).sort()).toEqual([201, 409]);
    const accepted = exchanges.find((response) => response.status === 201);
    const rejected = exchanges.find((response) => response.status === 409);
    if (accepted === undefined || rejected === undefined) throw new Error("exchange race failed");
    expect(accepted.headers.get("set-cookie")).toBeNull();
    expect(await rejected.json()).toEqual({ outcome: "REJECTED", reason: "INVITATION_CONSUMED" });
    const join = DisplayJoinSchema.parse(await accepted.json());
    expect(store.joins.size).toBe(1);
    expect(store.projections.size).toBe(0);
    const prematureClaim = await publicRequest("/v1/display-session", join);
    expect(prematureClaim.status).toBe(409);
    expect(await prematureClaim.json()).toEqual({ error: "display_not_approved" });
    expect(prematureClaim.headers.get("set-cookie")).toBeNull();

    const view = await pending(invitation.invitationId);
    expect(view.join).toEqual(join);
    const approval = {
      presentationSessionId,
      displayJoinId: join.displayJoinId,
      expectedDisplayBindingEpoch: view.displayBindingEpoch,
      expectedDeckVersion: view.deckVersion,
      approvedDisplayId: join.displayId,
      approvedDisplayFingerprint: join.displayFingerprint,
    };
    const forged = await privateRequest("/v1/display-bindings", {
      ...approval,
      approvedDisplayFingerprint: "fingerprint-not-the-projector",
    });
    expect(forged.status).toBe(409);
    expect(await forged.json()).toEqual({ error: "DISPLAY_IDENTITY_MISMATCH" });
    expect(store.projections.size).toBe(0);
    const approved = await privateRequest("/v1/display-bindings", approval);
    expect(approved.status).toBe(201);
    expect(
      AudienceDisplaySessionSchema.parse(await approved.json()).binding.displayBindingEpoch,
    ).toBe(DisplayBindingEpochSchema.parse("dbe_1"));
    const claimed = await publicRequest("/v1/display-session", join);
    expect(claimed.status).toBe(201);
    const displayCookie = claimed.headers.get("set-cookie")?.split(";", 1)[0];
    if (displayCookie === undefined)
      throw new Error("approval did not permit claiming the display");
    stageHeaders.set("cookie", displayCookie);
    const snapshot = await publicRequest("/v1/snapshot");
    expect(snapshot.status).toBe(200);
    const publicBody = await snapshot.json();
    expect(publicBody.deck).toEqual(publicDeck);
    expect(JSON.stringify(publicBody)).not.toContain("PRIVATE_NOT_FOR_STAGE");
    expect(JSON.stringify(publicBody)).not.toContain(credentials.csrfToken);
    expect(JSON.stringify(publicBody)).not.toContain(invitation.token);

    const replacement = await issue();
    const replacementResponse = await publicRequest("/v1/display-joins", {
      ...joinInput,
      invitationToken: replacement.token,
      displayId: "display_replacement",
    });
    expect(replacementResponse.status).toBe(201);
    const replacementJoin = DisplayJoinSchema.parse(await replacementResponse.json());
    const replacementView = await pending(replacement.invitationId);
    expect(replacementView.displayBindingEpoch).toBe(DisplayBindingEpochSchema.parse("dbe_1"));
    const staleApproval = {
      ...approval,
      displayJoinId: replacementJoin.displayJoinId,
      approvedDisplayId: replacementJoin.displayId,
    };
    const stale = await privateRequest("/v1/display-bindings", staleApproval);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "STALE_DISPLAY_BINDING" });
    expect(store.joins.get(replacementJoin.displayJoinId)?.consumed).toBe(false);
    const rebound = await privateRequest("/v1/display-bindings", {
      ...staleApproval,
      expectedDisplayBindingEpoch: replacementView.displayBindingEpoch,
    });
    expect(rebound.status).toBe(201);
    expect(
      AudienceDisplaySessionSchema.parse(await rebound.json()).binding.displayBindingEpoch,
    ).toBe(DisplayBindingEpochSchema.parse("dbe_2"));
    const oldDisplay = await publicRequest("/v1/snapshot");
    expect(oldDisplay.status).toBe(401);
    expect(await oldDisplay.json()).toEqual({ error: "display_session_expired" });

    const expiring = await issue();
    clock.now = expiring.expiresAtMs;
    const expired = await publicRequest("/v1/display-joins", {
      ...joinInput,
      invitationToken: expiring.token,
    });
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({ outcome: "REJECTED", reason: "INVITATION_EXPIRED" });
    expect(store.joins.size).toBe(2);
  } finally {
    await privateServer.stop(true);
    await gatewayServer.stop(true);
  }
}, 10_000);
