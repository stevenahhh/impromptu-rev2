import {
  ModelRoutingRegistry,
  ServerModelRouter,
  StaticPolicyVersionAuthority,
} from "@impromptu/model-router";
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
let coordinator: PreparedEvidenceCoordinator;
const internalRetrieval = new InternalRetrievalService({
  principals: {
    async resolve(accountSessionId) {
      const session = coordinator.readAccountSession(accountSessionId, Date.now());
      return session.outcome === "APPLIED"
        ? {
            tenantId: session.value.accountId,
            principalId: session.value.actorId,
            groupIds: [],
            attributes: {},
          }
        : null;
    },
  },
  policy: {
    async prefilter() {
      return { version: "acl-runtime-v1", current: true, authorizedObjectIds: [] };
    },
    async authorizeObject() {
      return false;
    },
    async isCurrent(_tenantId, version) {
      return version === "acl-runtime-v1";
    },
  },
  ann: {
    async search() {
      return [];
    },
  },
  objects: {
    async readMetadata() {
      return null;
    },
    async readContent() {
      return null;
    },
  },
});
const externalFetcher = new SafeExternalEvidenceFetcher({
  dns: {
    async resolve() {
      return [];
    },
  },
  transport: {
    async request() {
      throw new Error("External retrieval transport is not configured");
    },
  },
});
const modelRegistry = new ModelRoutingRegistry();
const modelBudget = {
  async reserve(request: { readonly estimatedCostUnits: number }) {
    return { reservationId: crypto.randomUUID(), reservedUnits: request.estimatedCostUnits };
  },
  async reconcile() {},
};
const modelRouter = new ServerModelRouter({
  registry: modelRegistry,
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
