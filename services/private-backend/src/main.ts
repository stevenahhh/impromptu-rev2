import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ModelRoutingRegistry,
  NodePermissionAdapterIsolate,
  ServerModelRouter,
  StaticPolicyVersionAuthority,
} from "@impromptu/model-router";
import { z } from "zod";
import { createAccountDirectory } from "./account-directory.ts";
import { parsePrivateBackendConfig } from "./config.ts";
import { createDeckRenderSubprocess } from "./deck-render-subprocess.ts";
import { createDeckUploadService } from "./deck-upload-service.ts";
import { createDeckUploadWorker } from "./deck-upload-worker.ts";
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

function existingAbsoluteDirectory(path: string, name: string): string {
  if (!isAbsolute(path)) {
    throw new Error(`${name} must be an existing absolute directory: ${path}`);
  }
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch {
    throw new Error(`${name} must be an existing absolute directory: ${path}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`${name} must be an existing absolute directory: ${path}`);
  }
  return path;
}

function renderDeadlineMs(value: string | undefined): number {
  if (value === undefined) return 60_000;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("DECK_RENDER_DEADLINE_MS must be a positive integer of milliseconds");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("DECK_RENDER_DEADLINE_MS must be a positive integer of milliseconds");
  }
  return parsed;
}

const DEFAULT_INGESTION_PROJECT = fileURLToPath(
  new URL("../../../services/ingestion", import.meta.url),
);

const config = parsePrivateBackendConfig(Bun.env);
const internalAuthToken = required("SERVICE_AUTH_TOKEN");
const bootstrapUsername = required("CONTROLLER_USERNAME");
const bootstrapPassword = required("CONTROLLER_PASSWORD");
const accountId = required("CONTROLLER_ACCOUNT_ID");
const accountDirectory = createAccountDirectory();
const bootstrapAccount = await accountDirectory.register(
  { username: bootstrapUsername, password: bootstrapPassword },
  Date.now(),
  { accountId },
);
if (bootstrapAccount.outcome !== "APPLIED") {
  throw new Error(`bootstrap account rejected: ${bootstrapAccount.reason}`);
}
const projectionGatewayOrigin = required("PROJECTION_GATEWAY_ORIGIN");
const projection = new ProjectionHttpPort(projectionGatewayOrigin, internalAuthToken);
const deckStagingRoot = existingAbsoluteDirectory(
  required("DECK_STAGING_ROOT"),
  "DECK_STAGING_ROOT",
);
const deckArtifactRoot = existingAbsoluteDirectory(
  required("DECK_ARTIFACT_ROOT"),
  "DECK_ARTIFACT_ROOT",
);
const ingestionProject = existingAbsoluteDirectory(
  Bun.env.INGESTION_PROJECT_PATH ?? DEFAULT_INGESTION_PROJECT,
  "INGESTION_PROJECT_PATH",
);
const deckUploadService = createDeckUploadService({
  projectionGatewayOrigin,
  worker: createDeckUploadWorker({
    subprocess: createDeckRenderSubprocess({ ingestionProject }),
    stagingRoot: deckStagingRoot,
    artifactRoot: deckArtifactRoot,
    deadlineMs: renderDeadlineMs(Bun.env.DECK_RENDER_DEADLINE_MS),
  }),
});
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
  livePublicEnabled: config.livePublicEnabled,
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
    identityVerifier: accountDirectory,
    now: Date.now,
    recommendations,
    persist,
    uploads: deckUploadService,
  }),
});

console.log(`private-backend listening on ${server.url}`);
