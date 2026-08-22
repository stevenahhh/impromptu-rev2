import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTrustedModelContext,
  FetchProviderEgressTransport,
  ModelRoutingRegistry,
  NodePermissionAdapterIsolate,
  ServerModelRouter,
  StaticExactEgressPolicy,
  StaticPolicyVersionAuthority,
} from "@impromptu/model-router";
import { SQL } from "bun";
import postgres from "postgres";
import { z } from "zod";
import { createAccountDirectory } from "./account-directory.ts";
import { createPostgresAccountSessionStore } from "./account-session-store-postgres.ts";
import { createPostgresAccountStore } from "./account-store-postgres.ts";
import { createAudioIngestService } from "./audio-ingest.ts";
import { parsePrivateBackendConfig } from "./config.ts";
import { createDeckRenderSubprocess } from "./deck-render-subprocess.ts";
import { createDeckUploadService } from "./deck-upload-service.ts";
import { createDeckUploadWorker } from "./deck-upload-worker.ts";
import { createPrivateBackendHandler } from "./http.ts";
import { registerOpenAiCompatibleAdapters } from "./model-adapters/openai-compatible.ts";
import {
  registerWhisperCppStreamingStt,
  verifyWhisperCppInstallation,
  WHISPER_CPP_ADAPTER_ID,
  WhisperCppAdapterIsolate,
} from "./model-adapters/stt-whisper-cpp.ts";
import { createJsonLogger, createMetricsRegistry } from "./observability.ts";
import { PreparedEvidenceCoordinator } from "./prepared-evidence.ts";
import { createPostgresPreparedEvidencePersistence } from "./prepared-evidence-store-postgres.ts";
import { ProjectionHttpPort } from "./projection-http-port.ts";
import { createTokenBucketRateLimiter } from "./rate-limit.ts";
import { createSessionReportRouteHandler } from "./report/http.ts";
import { createPostgresSessionReportRepository } from "./report/postgres-session-report-repository.ts";
import {
  createPreparedEvidenceReportObserver,
  SessionReportFinalizer,
} from "./report/session-report-finalizer.ts";
import {
  NodePinnedHttpsTransport,
  NodePublicDnsResolver,
  SafeExternalEvidenceFetcher,
} from "./retrieval/external-fetch.ts";
import {
  externalSearchCredentialsFromEnvironment,
  KeylessFirstExternalSearchBoundary,
} from "./retrieval/external-search.ts";
import { InternalRetrievalService } from "./retrieval/internal-retrieval.ts";
import { PostgresDeckRetrievalStore } from "./retrieval/postgres-deck-retrieval.ts";
import { createTenantScopedPostgresRepository } from "./retrieval/tenant-scoped-postgres-repository.ts";
import { PrivateRecommendationPipeline } from "./verifier/recommendation-pipeline.ts";

function required(name: string): string {
  const value = Bun.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function optionalWhisperCppPaths(): {
  readonly ffmpegPath: string;
  readonly whisperBinaryPath: string;
  readonly modelPath: string;
} | null {
  const ffmpegPath = Bun.env.FFMPEG_BINARY_PATH;
  const whisperBinaryPath = Bun.env.WHISPER_CPP_BINARY_PATH;
  const modelPath = Bun.env.WHISPER_CPP_MODEL_PATH;
  if (
    ffmpegPath === undefined ||
    ffmpegPath.length === 0 ||
    whisperBinaryPath === undefined ||
    whisperBinaryPath.length === 0 ||
    modelPath === undefined ||
    modelPath.length === 0
  ) {
    return null;
  }
  return { ffmpegPath, whisperBinaryPath, modelPath };
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

function positiveNumber(name: string, defaultValue: number): number {
  const value = Bun.env[name];
  if (value === undefined) return defaultValue;
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error(`${name} must be a positive finite number`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return parsed;
}

function credentialFreeHttpsBaseUrl(name: string): URL {
  const url = new URL(required(name));
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`${name} must be a credential-free HTTPS URL without query or fragment`);
  }
  return url;
}

function apiPrefix(url: URL): string {
  return url.pathname.replace(/\/$/, "") || "/";
}

const DEFAULT_INGESTION_PROJECT = fileURLToPath(
  new URL("../../../services/ingestion", import.meta.url),
);

const config = parsePrivateBackendConfig(Bun.env);
const internalAuthToken = required("SERVICE_AUTH_TOKEN");
const bootstrapUsername = required("CONTROLLER_USERNAME");
const bootstrapPassword = required("CONTROLLER_PASSWORD");
const accountId = required("CONTROLLER_ACCOUNT_ID");
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
const privateDatabaseUrl = required("PRIVATE_DATABASE_URL");
const privateSql = postgres(privateDatabaseUrl);
const preparedEvidenceSql = new SQL(privateDatabaseUrl);
const privateStateKey = Bun.env.PRIVATE_PREPARED_EVIDENCE_STATE_KEY;
const persistence = await createPostgresPreparedEvidencePersistence(preparedEvidenceSql, {
  ...(privateStateKey === undefined ? {} : { stateKey: privateStateKey }),
});
const store = persistence.store;
const sessionReports = createPostgresSessionReportRepository(privateSql);
const sessionReportFinalizer = new SessionReportFinalizer(sessionReports);
const reportObserver = createPreparedEvidenceReportObserver(sessionReportFinalizer, (error) => {
  logger.error({
    requestId: `session-report:${crypto.randomUUID()}`,
    path: "/internal/session-report",
    errorType: error instanceof Error ? error.name : "UnknownError",
  });
});
let coordinator: PreparedEvidenceCoordinator;
const chatModelApiKey = required("CHAT_MODEL_API_KEY");
const embeddingModelApiKey = required("EMBEDDING_MODEL_API_KEY");
const chatModelBaseUrl = credentialFreeHttpsBaseUrl("CHAT_MODEL_BASE_URL");
const embeddingModelBaseUrl = credentialFreeHttpsBaseUrl("EMBEDDING_MODEL_BASE_URL");
const accountDirectory = createAccountDirectory(createPostgresAccountStore(privateSql));
const modelRegistry = new ModelRoutingRegistry();
const chatModel = {
  origin: chatModelBaseUrl.origin,
  apiPrefix: apiPrefix(chatModelBaseUrl),
  model: required("LLM_MODEL"),
};
// Local capture is an optional deployment capability. Without a pinned whisper.cpp installation the
// service still composes and every /v1/audio route stays closed, instead of refusing to boot at all.
const whisperPaths = optionalWhisperCppPaths();
if (whisperPaths !== null) {
  await verifyWhisperCppInstallation(whisperPaths);
  registerWhisperCppStreamingStt(modelRegistry, whisperPaths);
}
const modelAdapterBindings = registerOpenAiCompatibleAdapters(modelRegistry, {
  embedding: {
    origin: embeddingModelBaseUrl.origin,
    apiPrefix: apiPrefix(embeddingModelBaseUrl),
    model: required("EMBEDDING_MODEL"),
    secretId: "embedding-model-api-key",
  },
  rerank: {
    ...chatModel,
    model: required("RERANK_MODEL"),
    secretId: "rerank-model-api-key",
    reasoningEffort: "none",
  },
  llm: { ...chatModel, secretId: "llm-model-api-key", reasoningEffort: "none" },
  verifier: {
    ...chatModel,
    model: required("VERIFIER_MODEL"),
    secretId: "verifier-model-api-key",
    reasoningEffort: "none",
  },
});
const modelBudget = {
  async reserve(request: { readonly estimatedCostUnits: number }) {
    return { reservationId: crypto.randomUUID(), reservedUnits: request.estimatedCostUnits };
  },
  async reconcile() {},
};
const modelRouter = new ServerModelRouter({
  registry: modelRegistry,
  adapterIsolate: new WhisperCppAdapterIsolate(new NodePermissionAdapterIsolate()),
  policyVersionAuthority: new StaticPolicyVersionAuthority("model-policy-v1"),
  quotaPolicy: { async assertWithinQuota() {} },
  budget: modelBudget,
  secretStore: {
    async read(secretId) {
      if (secretId === "embedding-model-api-key") return { value: embeddingModelApiKey };
      if (
        secretId === "rerank-model-api-key" ||
        secretId === "llm-model-api-key" ||
        secretId === "verifier-model-api-key"
      ) {
        return { value: chatModelApiKey };
      }
      throw new Error("Unknown model credential");
    },
  },
  egressPolicy: new StaticExactEgressPolicy(
    modelAdapterBindings.map(({ adapterId, origin }) => ({ adapterId, origin })),
  ),
  providerTransport: new FetchProviderEgressTransport(),
});
const logger = createJsonLogger();
const retrievalRepository = createTenantScopedPostgresRepository(privateSql);
const retrievalStore = new PostgresDeckRetrievalStore({
  repository: retrievalRepository,
  artifactRoot: deckArtifactRoot,
  access: {
    async authorize(principal, request) {
      return [...store.presentations.values()].some(
        (presentation) =>
          String(presentation.privateDeck.ownerAccountId) === principal.tenantId &&
          presentation.privateDeck.deckVersion === request.deckVersion &&
          presentation.privateDeck.manifestHash === request.manifestHash,
      );
    },
  },
  logger: {
    log(event) {
      const requestId = `deck-index:${crypto.randomUUID()}`;
      logger.request({
        requestId,
        method: "INDEX",
        path: "/internal/deck-retrieval",
        status: event.outcome === "FAILED" ? 500 : 200,
        durationMs: event.durationMs,
        outcome: `${event.outcome}:${event.reason}`,
      });
      if (event.errorType !== undefined) {
        logger.error({ requestId, path: "/internal/deck-retrieval", errorType: event.errorType });
      }
    },
  },
  embedding: {
    async embed(text, principal) {
      const startedAtMs = Date.now();
      const signal = AbortSignal.timeout(15_000);
      const result = await modelRouter.invoke(
        { capability: "embedding", input: { task: "EMBED_RETRIEVAL_QUERY", query: text } },
        createTrustedModelContext({
          tenantId: principal.tenantId,
          principalId: principal.principalId,
          policyVersion: "model-policy-v1",
          requestId: `deck-index:${crypto.randomUUID()}`,
          traceId: `deck-index:${principal.tenantId}:${startedAtMs}`,
          deadlineAtMs: startedAtMs + 15_000,
          signal,
        }),
      );
      if (!result.ok) throw new Error(`Deck embedding failed: ${result.error.code}`);
      return z
        .object({ vector: z.array(z.number().finite()).min(1).max(8_192) })
        .strict()
        .parse(result.output).vector;
    },
  },
});
const internalRetrieval = new InternalRetrievalService({
  principals: {
    async resolve(accountSessionId) {
      const session = await coordinator.readAccountSession(accountSessionId, Date.now());
      return session.outcome === "APPLIED"
        ? {
            tenantId: session.value.accountId,
            principalId: session.value.actorId,
            groupIds: [],
            attributes: { role: "controller" },
          }
        : null;
    },
  },
  policy: retrievalStore,
  ann: retrievalStore,
  objects: retrievalStore,
  corpus: retrievalStore,
});
const externalFetcher = new SafeExternalEvidenceFetcher({
  dns: new NodePublicDnsResolver(),
  transport: new NodePinnedHttpsTransport(),
});
const externalSearch = new KeylessFirstExternalSearchBoundary({
  ...externalSearchCredentialsFromEnvironment(Bun.env),
  diagnostics: {
    observe(diagnostic) {
      logger.request({
        requestId: `external-search:${crypto.randomUUID()}`,
        method: "SEARCH",
        path: `/internal/external-search/${diagnostic.provider}`,
        status: 204,
        durationMs: 0,
        outcome: diagnostic.failure,
      });
    },
  },
});
const bootstrapAccount = await accountDirectory.register(
  { username: bootstrapUsername, password: bootstrapPassword },
  Date.now(),
  { accountId },
);
if (bootstrapAccount.outcome === "REJECTED" && bootstrapAccount.reason !== "USERNAME_TAKEN") {
  throw new Error(`bootstrap account rejected: ${bootstrapAccount.reason}`);
}
const recommendations = new PrivateRecommendationPipeline({
  router: modelRouter,
  contexts: {
    async resolve(accountSessionId) {
      const session = await coordinator.readAccountSession(accountSessionId, Date.now());
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
  externalSearch,
  externalFetch: externalFetcher,
  stageObserver: {
    observe(event) {
      logger.request({
        requestId: `recommendation-stage:${crypto.randomUUID()}`,
        method: "INFERENCE",
        path: `/internal/recommendation/${event.stage}`,
        status: event.outcome === "SUCCESS" ? 200 : 500,
        durationMs: event.latencyMs,
        outcome:
          event.errorCode === undefined ? event.outcome : `${event.outcome}:${event.errorCode}`,
      });
    },
    observeHedge(event) {
      logger.request({
        requestId: `recommendation-hedge:${crypto.randomUUID()}`,
        method: "HEDGE",
        path: `/internal/recommendation/${event.stage}`,
        status: 200,
        durationMs: 0,
        outcome: event.outcome,
      });
    },
    observeReconciliation(event) {
      logger.request({
        requestId: `recommendation-reconcile:${crypto.randomUUID()}`,
        method: "RECONCILE",
        path: "/internal/recommendation/deterministic",
        status: 422,
        durationMs: 0,
        outcome: `${event.category}:${event.value}`,
      });
    },
  },
});
coordinator = new PreparedEvidenceCoordinator(projection, store, {
  accountSessionStore: createPostgresAccountSessionStore(privateSql),
  livePublicEnabled: config.livePublicEnabled,
  reportObserver,
  liveEvidenceAuthorizer: {
    async authorize(candidate) {
      return await recommendations.authorizeCandidateForPublication(candidate);
    },
  },
});
const audio =
  whisperPaths === null
    ? undefined
    : createAudioIngestService({
        router: modelRouter,
        adapterId: WHISPER_CPP_ADAPTER_ID,
        createGrantId: () => `capture_${crypto.randomUUID()}`,
        coachingPreviewEnabledFor: () => true,
        recommendations: {
          resolveContext(identity) {
            const presentation = store.presentations.get(identity.presentationSessionId);
            if (
              presentation?.lifecycle.ownerAccountId !== identity.accountId ||
              presentation.lifecycle.presentationSessionEpoch !==
                identity.presentationSessionEpoch ||
              presentation.lifecycle.status !== "ACTIVE"
            ) {
              return null;
            }
            return {
              deckVersion: presentation.privateDeck.deckVersion,
              manifestHash: presentation.privateDeck.manifestHash,
            };
          },
          recommend(accountSessionId, input) {
            return recommendations.recommend(accountSessionId, input);
          },
        },
        onFinal(identity, event) {
          sessionReportFinalizer.recordFinal(
            {
              tenantId: identity.accountId,
              presentationSessionId: identity.presentationSessionId,
              ownerSubject: identity.accountId,
            },
            {
              finalSegmentId: event.finalSegmentId,
              transcript: event.transcript,
            },
          );
        },
        contextFor(identity, signal) {
          const startedAtMs = Date.now();
          const requestId = `audio-stt:${crypto.randomUUID()}`;
          return createTrustedModelContext({
            tenantId: identity.accountId,
            principalId: identity.actorId,
            requestId,
            traceId: `${requestId}:${identity.presentationSessionId}`,
            policyVersion: "model-policy-v1",
            deadlineAtMs: startedAtMs + 60_000,
            signal,
          });
        },
      });
const reportOwners = {
  async resolve({
    accountId: requestedAccountId,
    presentationSessionId,
  }: {
    readonly accountId: string;
    readonly presentationSessionId: string;
  }) {
    const presentation = store.presentations.get(presentationSessionId);
    if (presentation?.lifecycle.ownerAccountId !== requestedAccountId) return null;
    return {
      tenantId: requestedAccountId,
      presentationSessionId,
      ownerSubject: requestedAccountId,
    };
  },
};
const preparedEvidenceFor = (presentationSessionId: string) => {
  const presentation = store.presentations.get(presentationSessionId);
  return {
    label: "준비된 근거" as const,
    items:
      presentation === undefined
        ? []
        : [...presentation.candidates.values()].map(({ candidate }) => ({
            evidenceId: candidate.candidateId,
            sourceId: candidate.causal.source.sourceId,
            sourceUrl: null,
            provenance: candidate.provenance,
          })),
  };
};
const sessionReportRead = createSessionReportRouteHandler(
  sessionReportFinalizer,
  reportOwners,
  {
    async resolve(principal) {
      return preparedEvidenceFor(principal.presentationSessionId);
    },
  },
  {
    async resolve(principal) {
      const presentation = store.presentations.get(principal.presentationSessionId);
      if (presentation === undefined) return null;
      const finalizedAtMs = Date.now();
      return {
        endedOffsetMs: Math.max(0, finalizedAtMs - presentation.lifecycle.createdAtMs),
        finalizedAtMs,
        preparedEvidence: preparedEvidenceFor(principal.presentationSessionId),
      };
    },
  },
);
const metrics = createMetricsRegistry("private_backend");
const loginRateLimiters = {
  account: createTokenBucketRateLimiter({
    capacity: positiveNumber("LOGIN_ACCOUNT_RATE_LIMIT_CAPACITY", 5),
    refillPerSecond: positiveNumber("LOGIN_ACCOUNT_RATE_LIMIT_REFILL_PER_SECOND", 0.1),
    now: Date.now,
  }),
  ip: createTokenBucketRateLimiter({
    capacity: positiveNumber("LOGIN_IP_RATE_LIMIT_CAPACITY", 20),
    refillPerSecond: positiveNumber("LOGIN_IP_RATE_LIMIT_REFILL_PER_SECOND", 1),
    now: Date.now,
  }),
};
const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch: createPrivateBackendHandler(config, {
    coordinator,
    internalAuthToken,
    identityVerifier: accountDirectory,
    accountRegistrar: accountDirectory,
    now: Date.now,
    recommendations,
    ...(audio === undefined ? {} : { audio }),
    sessionReportRead,
    persist: persistence.persist,
    uploads: deckUploadService,
    logger,
    metrics,
    loginRateLimiters,
    readiness: {
      async check() {
        await privateSql`SELECT 1`;
        try {
          const response = await fetch(`${projectionGatewayOrigin}/health`, {
            signal: AbortSignal.timeout(5_000),
          });
          return response.ok
            ? { outcome: "READY" }
            : { outcome: "NOT_READY", reason: "PROJECTION_GATEWAY_UNAVAILABLE" };
        } catch {
          return { outcome: "NOT_READY", reason: "PROJECTION_GATEWAY_UNAVAILABLE" };
        }
      },
    },
  }),
});

console.log(`private-backend listening on ${server.url}`);
