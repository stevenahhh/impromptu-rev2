import { fileURLToPath } from "node:url";
import {
  ModelRoutingRegistry,
  NodePermissionAdapterIsolate,
  ServerModelRouter,
  StaticPolicyVersionAuthority,
} from "@impromptu/model-router";
import { z } from "zod";
import { parsePrivateBackendConfig } from "./config.ts";
import { createPrivateBackendHandler } from "./http.ts";
import {
  createPreparedEvidenceStore,
  PreparedEvidenceCoordinator,
  PreparedEvidenceSnapshotError,
  restorePreparedEvidenceStore,
  snapshotPreparedEvidenceStore,
} from "./prepared-evidence.ts";
import { ProjectionHttpPort } from "./projection-http-port.ts";
import { SafeExternalEvidenceFetcher } from "./retrieval/external-fetch.ts";
import { InternalRetrievalService } from "./retrieval/internal-retrieval.ts";
import { PrivateRecommendationPipeline } from "./verifier/recommendation-pipeline.ts";

function required(name: string): string {
  const value = Bun.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

const config = parsePrivateBackendConfig(Bun.env);
const internalAuthToken = required("SERVICE_AUTH_TOKEN");
const expectedAuthorizationCode = required("CONTROLLER_AUTHORIZATION_CODE");
const accountId = required("CONTROLLER_ACCOUNT_ID");
const actorId = required("CONTROLLER_ACTOR_ID");
const takeoverAuthorizationCode = Bun.env.TAKEOVER_AUTHORIZATION_CODE;
const takeoverActorId = Bun.env.TAKEOVER_ACTOR_ID;
if ((takeoverAuthorizationCode === undefined) !== (takeoverActorId === undefined)) {
  throw new Error("TAKEOVER_AUTHORIZATION_CODE and TAKEOVER_ACTOR_ID must be configured together");
}
const projection = new ProjectionHttpPort(required("PROJECTION_GATEWAY_ORIGIN"), internalAuthToken);
const snapshotPath = required("PRIVATE_SNAPSHOT_PATH");
const snapshotFile = Bun.file(snapshotPath);
let store = createPreparedEvidenceStore();
if (await snapshotFile.exists()) {
  let input: unknown;
  try {
    input = await snapshotFile.json();
  } catch {
    throw new PreparedEvidenceSnapshotError("private snapshot is not valid JSON");
  }
  const restored = restorePreparedEvidenceStore(input);
  if (restored.outcome !== "RESTORED") {
    throw new PreparedEvidenceSnapshotError("private snapshot failed validation");
  }
  store = restored.store;
}
const fixtureObjectId = "runtime-fixture";
const fixtureContent = "Acme revenue was 42 million USD in 2025.";
const fixtureSourceHash = new Bun.CryptoHasher("sha256").update(fixtureContent).digest("hex");
const fixtureManifestHash = "a".repeat(64);
let coordinator: PreparedEvidenceCoordinator;
const internalRetrieval = new InternalRetrievalService({
  principals: {
    async resolve(accountSessionId) {
      const session = coordinator.readAccountSession(accountSessionId, Date.now());
      return session.outcome === "APPLIED"
        ? {
            tenantId: session.value.accountId,
            principalId: session.value.actorId,
            groupIds: ["runtime-fixture-readers"],
            attributes: { role: "controller" },
          }
        : null;
    },
  },
  policy: {
    async prefilter(principal, request) {
      const eligible =
        principal.groupIds.includes("runtime-fixture-readers") &&
        request.deckVersion === "deck_v1" &&
        request.manifestHash === fixtureManifestHash;
      return {
        version: "acl-runtime-v1",
        current: true,
        authorizedObjectIds: eligible ? [fixtureObjectId] : [],
      };
    },
    async authorizeObject(principal, object, version) {
      return (
        version === "acl-runtime-v1" &&
        principal.tenantId === object.tenantId &&
        object.objectId === fixtureObjectId
      );
    },
    async isCurrent(_tenantId, version) {
      return version === "acl-runtime-v1";
    },
  },
  ann: {
    async search(input) {
      return input.authorizedObjectIds.includes(fixtureObjectId)
        ? [
            {
              tenantId: input.tenantId,
              objectId: fixtureObjectId,
              score: 1,
              indexedSourceHash: fixtureSourceHash,
              indexedDeckVersion: "deck_v1",
              indexedManifestHash: fixtureManifestHash,
              indexedAuthorizationVersion: "acl-runtime-v1",
            },
          ]
        : [];
    },
  },
  objects: {
    async readMetadata(tenantId, objectId) {
      return objectId === fixtureObjectId
        ? {
            tenantId,
            objectId,
            sourceId: "source_runtime",
            sourceRevision: "r1",
            sourceHash: fixtureSourceHash,
            deckVersion: "deck_v1",
            manifestHash: fixtureManifestHash,
            title: "Runtime evidence fixture",
            anchor: "fixture=runtime",
            rights: "APPROVED",
            containsPii: false,
          }
        : null;
    },
    async readContent(_tenantId, objectId) {
      return objectId === fixtureObjectId ? fixtureContent : null;
    },
  },
});
const externalFetcher = new SafeExternalEvidenceFetcher({
  dns: {
    async resolve() {
      return ["93.184.216.34"];
    },
  },
  transport: {
    async request() {
      throw new Error("Pinned external retrieval transport is not configured");
    },
  },
});
const modelRegistry = new ModelRoutingRegistry();
const fixedAdapterModule = fileURLToPath(
  new URL("./model-adapters/fixed-retrieval.mjs", import.meta.url),
);
for (const capability of ["embedding", "rerank", "llm", "verifier"] as const) {
  const registration = modelRegistry.registerIsolatedUnary({
    descriptor: {
      adapterId: `fixed-runtime-${capability}`,
      capability,
      provider: "fixed-runtime-provider",
      model: `fixed-runtime-${capability}`,
      modelVersion: "1",
      estimatedCostUnits: 1,
    },
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    module: { modulePath: fixedAdapterModule, exportName: capability, allowedReadPaths: [] },
  });
  if (registration !== undefined) throw new Error(`Failed to register ${capability} adapter`);
}
const modelBudget = {
  async reserve(request: { readonly estimatedCostUnits: number }) {
    return { reservationId: crypto.randomUUID(), reservedUnits: request.estimatedCostUnits };
  },
  async reconcile() {},
};
const modelRouter = new ServerModelRouter({
  registry: modelRegistry,
  adapterIsolate: new NodePermissionAdapterIsolate(),
  policyVersionAuthority: new StaticPolicyVersionAuthority("model-policy-v1"),
  quotaPolicy: { async assertWithinQuota() {} },
  budget: modelBudget,
});
const recommendations = new PrivateRecommendationPipeline({
  router: modelRouter,
  contexts: {
    async resolve(accountSessionId) {
      const session = coordinator.readAccountSession(accountSessionId, Date.now());
      return session.outcome === "APPLIED"
        ? {
            tenantId: session.value.accountId,
            principalId: session.value.actorId,
            policyVersion: "model-policy-v1",
          }
        : null;
    },
  },
  internal: internalRetrieval,
  externalFetch: externalFetcher,
});
coordinator = new PreparedEvidenceCoordinator(projection, store, {
  liveEvidenceAuthorizer: {
    async authorize(candidate) {
      return await recommendations.authorizeCandidateForPublication(candidate);
    },
  },
});
const persist = async () => {
  await Bun.write(snapshotPath, JSON.stringify(snapshotPreparedEvidenceStore(store)));
};
const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch: createPrivateBackendHandler(config, {
    coordinator,
    internalAuthToken,
    identityVerifier: {
      async exchangeAuthorizationCode(code) {
        if (code === expectedAuthorizationCode) return { accountId, actorId };
        return code === takeoverAuthorizationCode && takeoverActorId !== undefined
          ? { accountId, actorId: takeoverActorId }
          : null;
      },
    },
    now: Date.now,
    recommendations,
    persist,
  }),
});

console.log(`private-backend listening on ${server.url}`);
