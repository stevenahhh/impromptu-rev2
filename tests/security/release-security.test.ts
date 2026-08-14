import { describe, expect, test } from "bun:test";
import {
  createProjectionGatewayStore,
  PreparedEvidenceProjectionGateway,
  restoreProjectionGatewayStore,
  snapshotProjectionGatewayStore,
} from "@impromptu/projection-gateway";
import { parsePrivateBackendConfig } from "../../services/private-backend/src/config.ts";
import { createPrivateBackendHandler } from "../../services/private-backend/src/http.ts";
import { PreparedEvidenceCoordinator } from "../../services/private-backend/src/prepared-evidence.ts";
import { parseProjectionGatewayConfig } from "../../services/projection-gateway/src/config.ts";
import { createProjectionGatewayHandler } from "../../services/projection-gateway/src/http.ts";

const consoleOrigin = "https://console.example.test";
const stageOrigin = "https://stage.example.test";
const internalToken = "release-security-internal-token";
const privateMarker = "private://tenant-alpha/source";
const deck = {
  deckVersion: "deck_release",
  manifestHash: "a".repeat(64),
  title: "Release deck",
  slides: [
    {
      publicSlideKey: "slide_release",
      ordinal: 1,
      accessibilityLabel: "Release slide",
      image: {
        url: "https://public.example.test/release.png",
        contentHash: "b".repeat(64),
        width: 1920,
        height: 1080,
      },
    },
  ],
};

function stageRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`https://projection.example.test${path}`, {
    ...init,
    headers: {
      Origin: stageOrigin,
      Referer: `${stageOrigin}/`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

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

function releaseGateways() {
  const gateway = new PreparedEvidenceProjectionGateway();
  return {
    gateway,
    publicHandler: createProjectionGatewayHandler(
      parseProjectionGatewayConfig({ STAGE_ORIGIN: stageOrigin }),
      {
        gateway,
        internalAuthToken: internalToken,
        now: () => 1_000,
        stageReceiptWriter: {
          async recordApplied() {
            return null;
          },
        },
      },
    ),
  };
}

function releasePrivateHandler(coordinator: PreparedEvidenceCoordinator) {
  return createPrivateBackendHandler(parsePrivateBackendConfig({ CONSOLE_ORIGIN: consoleOrigin }), {
    coordinator,
    identityVerifier: {
      async exchangeAuthorizationCode(code) {
        return code.startsWith("tenant-")
          ? {
              accountId: `account_${code.replace("tenant-", "tenant_")}`,
              actorId: `actor_${code.replace("tenant-", "tenant_")}`,
            }
          : null;
      },
    },
    internalAuthToken: internalToken,
    now: () => 1_000,
  });
}

async function responseText(response: Response): Promise<string> {
  const text = await response.text();
  expect(text).not.toContain(privateMarker);
  return text;
}

const privateScope = { privateSourceUri: privateMarker };

const publicPayloadCases = [
  {
    name: "display join",
    path: "/v1/display-joins",
    body: {
      displayId: "display_release",
      deckVersion: deck.deckVersion,
      displayFingerprint: "fingerprint-release-stage",
      ...privateScope,
    },
  },
  {
    name: "display claim",
    path: "/v1/display-session",
    body: {
      displayJoinId: "join_release",
      displayId: "display_release",
      displayFingerprint: "fingerprint-release-stage",
      ...privateScope,
    },
  },
  {
    name: "Stage receipt",
    path: "/v1/stage-applied",
    headers: { Cookie: "__Host-display=audience_forged" },
    body: { commandId: "cmd_release", displayBindingEpoch: "dbe_1", ...privateScope },
  },
] as const;

const internalPublicPayloadCases = [
  ["display binding", "/internal/display-bindings"],
  ["playback", "/internal/playback"],
  ["playback receipt", "/internal/playback-applied"],
  ["card", "/internal/cards"],
] as const;

const anonymousPrivateRoutes = [
  ["GET", "/v1/account-session"],
  ["GET", "/v1/playback/controller-events?presentationSessionId=ps_other"],
  ["GET", "/v1/publications/live-candidates?presentationSessionId=ps_other"],
  ["DELETE", "/v1/account-session"],
  ["POST", "/v1/recommendations"],
  ["POST", "/v1/candidates/live"],
  ["POST", "/v1/deck-artifacts"],
  ["POST", "/v1/presentation-sessions"],
  ["POST", "/v1/display-bindings"],
  ["POST", "/v1/playback/lease-takeover"],
  ["POST", "/v1/playback/slide-set"],
  ["POST", "/v1/candidates/curated"],
  ["POST", "/v1/publications/teammates"],
  ["POST", "/v1/publications/approve"],
  ["POST", "/v1/publications/terminate"],
] as const;

function bindGateway(gateway: PreparedEvidenceProjectionGateway) {
  const join = gateway.createDisplayJoin(
    {
      displayId: "display_release",
      deckVersion: deck.deckVersion,
      displayFingerprint: "fingerprint-release-stage",
    },
    1_000,
  );
  const bound = gateway.bindDisplay(
    {
      displayJoinId: join.displayJoinId,
      presentationSessionId: "ps_release",
      presentationSessionEpoch: "pse_1",
      publicationPolicyVersion: "publication-policy-1",
      expectedDisplayBindingEpoch: "dbe_0",
      expectedDeckVersion: deck.deckVersion,
      approvedDisplayId: join.displayId,
      approvedDisplayFingerprint: join.displayFingerprint,
      deck,
    },
    1_000,
  );
  if (bound.outcome !== "BOUND") throw new Error("release fixture did not bind");
  return bound.session;
}

describe("WP10 release security gate", () => {
  test("rejects private-scope payloads at every public write route", async () => {
    const { publicHandler } = releaseGateways();
    let rejected = 0;
    for (const item of publicPayloadCases) {
      const response = await publicHandler(
        stageRequest(item.path, {
          method: "POST",
          headers: "headers" in item ? item.headers : {},
          body: JSON.stringify(item.body),
        }),
      );
      expect(response.status, item.name).toBe(400);
      await responseText(response);
      rejected += 1;
    }
    for (const [name, path] of internalPublicPayloadCases) {
      const response = await publicHandler(
        stageRequest(path, {
          method: "POST",
          headers: { Authorization: `Bearer ${internalToken}` },
          body: JSON.stringify(privateScope),
        }),
      );
      expect(response.status, name).toBe(400);
      await responseText(response);
      rejected += 1;
    }
    expect(rejected).toBe(7);
  });

  test("rejects anonymous public/Stage reachability across every private route", async () => {
    const coordinator = new PreparedEvidenceCoordinator(new PreparedEvidenceProjectionGateway());
    const handler = releasePrivateHandler(coordinator);
    let rejected = 0;
    for (const [method, path] of anonymousPrivateRoutes) {
      const response = await handler(
        privateRequest(path, {
          method,
          ...(method === "GET" ? {} : { body: JSON.stringify({ role: "PUBLIC_STAGE" }) }),
        }),
      );
      expect(response.status, `${method} ${path}`).toBe(401);
      await responseText(response);
      rejected += 1;
    }
    const internal = await handler(
      privateRequest("/internal/stage-applied", {
        method: "POST",
        body: JSON.stringify({ role: "PUBLIC_STAGE" }),
      }),
    );
    expect(internal.status).toBe(401);
    await responseText(internal);
    expect(rejected + 1).toBe(16);
  });

  test("denies cross-tenant private reads", async () => {
    const coordinator = new PreparedEvidenceCoordinator(new PreparedEvidenceProjectionGateway());
    const handler = releasePrivateHandler(coordinator);
    const signIn = async (tenant: string) => {
      const response = await handler(
        privateRequest("/v1/account-sessions", {
          method: "POST",
          body: JSON.stringify({ authorizationCode: tenant }),
        }),
      );
      const payload = (await response.json()) as { csrfToken: string };
      const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      return { cookie, csrf: payload.csrfToken };
    };
    const tenantA = await signIn("tenant-a");
    const tenantB = await signIn("tenant-b");
    const created = await handler(
      privateRequest("/v1/presentation-sessions", {
        method: "POST",
        headers: { Cookie: tenantB.cookie, "x-csrf-token": tenantB.csrf },
        body: JSON.stringify({
          privateDeck: {
            deckId: "private_deck_release",
            deckVersion: deck.deckVersion,
            manifestHash: deck.manifestHash,
            ownerAccountId: "account_tenant_b",
            title: "Private B",
            aclPolicyVersion: "acl-policy-1",
            privateObjectPrefix: "private-decks/tenant-b/release",
            slides: [
              {
                privateSlideId: "private_slide_release",
                publicSlideKey: "slide_release",
                ordinal: 1,
                speakerNotes: "private",
                extractedText: "private",
                sourceAssetIds: ["asset_release"],
              },
            ],
          },
          publicDeck: deck,
        }),
      }),
    );
    expect(created.status).toBe(201);
    const presentation = (await created.json()) as { lifecycle: { presentationSessionId: string } };
    const denied = await handler(
      privateRequest(
        `/v1/publications/live-candidates?presentationSessionId=${presentation.lifecycle.presentationSessionId}`,
        { headers: { Cookie: tenantA.cookie } },
      ),
    );
    expect(denied.status).toBe(403);
    expect(await responseText(denied)).not.toContain("tenant-b");
  });

  test("contains a compromised Stage with no private exposure", async () => {
    const gateway = new PreparedEvidenceProjectionGateway();
    const session = bindGateway(gateway);
    const staleIngress = gateway.projectCardResult("ps_release", {
      projectionId: "projection_stale_live",
      status: "PUBLISHED",
      mode: "LIVE",
      leaseExpiresAtMs: 3_000,
      publicationPolicyVersion: "publication-policy-1",
      cardVersion: "card-version-release-1",
      liveBinding: {
        presentationSessionEpoch: "pse_1",
        displayBindingEpoch: "dbe_0",
        publicSlideOccurrence: { publicSlideKey: "slide_release", occurrenceSeq: 1 },
        publicationPolicyVersion: "publication-policy-1",
        cardVersion: "card-version-release-1",
      },
      claim: privateMarker,
      supportSummary: privateMarker,
      sourceLabel: privateMarker,
      publishedAtMs: 1_001,
      expiresAtMs: 3_000,
      publicCardRevision: "pcr_1",
      deckVersion: deck.deckVersion,
      manifestHash: deck.manifestHash,
      occurrence: { publicSlideKey: "slide_release", occurrenceSeq: 1 },
    });
    expect(staleIngress).toEqual({ outcome: "REJECTED", reason: "STALE_LIVE_BINDING" });

    const forged = structuredClone(
      snapshotProjectionGatewayStore(createProjectionGatewayStore()),
    ) as Record<string, unknown>;
    forged.privateDeck = privateMarker;
    expect(restoreProjectionGatewayStore(forged)).toEqual({ outcome: "INVALID_SNAPSHOT" });

    const { publicHandler } = releaseGateways();
    const directWrite = await publicHandler(
      stageRequest("/v1/projections/ps_release", {
        method: "POST",
        body: JSON.stringify({ claim: privateMarker }),
      }),
    );
    expect(directWrite.status).toBe(403);
    expect(await responseText(directWrite)).not.toContain(privateMarker);
    expect(gateway.snapshot(session.audienceDisplaySessionId, 1_002)?.cards).toEqual([]);
  });

  test("restores backup tombstones and cannot resurrect retention-deleted content", () => {
    const store = createProjectionGatewayStore();
    const gateway = new PreparedEvidenceProjectionGateway(store, { tombstoneRetentionMs: 60_000 });
    const session = bindGateway(gateway);
    expect(
      gateway.projectCard("ps_release", {
        projectionId: "projection_deleted",
        status: "PUBLISHED",
        claim: "Public claim",
        supportSummary: "Public support",
        sourceLabel: "Public source",
        publishedAtMs: 1_001,
        expiresAtMs: null,
        publicCardRevision: "pcr_1",
        deckVersion: deck.deckVersion,
        manifestHash: deck.manifestHash,
        occurrence: { publicSlideKey: "slide_release", occurrenceSeq: 1 },
      }),
    ).toBe(true);
    expect(
      gateway.projectCard("ps_release", {
        projectionId: "projection_deleted",
        status: "RETRACTED",
        publicCardRevision: "pcr_2",
        occurredAtMs: 1_002,
      }),
    ).toBe(true);
    expect(gateway.snapshot(session.audienceDisplaySessionId, 1_003)?.cards).toEqual([]);

    const backup = snapshotProjectionGatewayStore(store);
    const restored = restoreProjectionGatewayStore(structuredClone(backup));
    expect(restored.outcome).toBe("RESTORED");
    if (restored.outcome !== "RESTORED") throw new Error("backup restore failed");
    const restarted = new PreparedEvidenceProjectionGateway(restored.store, {
      tombstoneRetentionMs: 60_000,
    });
    const snapshot = restarted.snapshot(session.audienceDisplaySessionId, 1_003);
    expect(snapshot?.cards).toEqual([]);
    expect(snapshot?.tombstones.map((entry) => entry.status)).toEqual(["RETRACTED"]);
    expect(
      restarted.projectCardResult("ps_release", {
        projectionId: "projection_deleted",
        status: "PUBLISHED",
        claim: "Resurrection",
        supportSummary: "Forbidden",
        sourceLabel: "Forbidden",
        publishedAtMs: 1_004,
        expiresAtMs: null,
        publicCardRevision: "pcr_3",
        deckVersion: deck.deckVersion,
        manifestHash: deck.manifestHash,
        occurrence: { publicSlideKey: "slide_release", occurrenceSeq: 1 },
      }),
    ).toEqual({ outcome: "REJECTED", reason: "TERMINAL_PROJECTION" });
  });
});
