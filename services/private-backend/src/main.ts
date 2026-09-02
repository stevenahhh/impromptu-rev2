import { fileURLToPath } from "node:url";
import { SQL } from "bun";
import postgres from "postgres";
import { createAccountDirectory } from "./account-directory.ts";
import { createPostgresAccountSessionStore } from "./account-session-store-postgres.ts";
import { createPostgresAccountStore } from "./account-store-postgres.ts";
import { createAudio } from "./bootstrap/audio.ts";
import {
  existingAbsoluteDirectory,
  optionalWhisperCppPaths,
  positiveNumber,
  renderDeadlineMs,
  required,
} from "./bootstrap/env.ts";
import { createModelRouter } from "./bootstrap/model-router.ts";
import { createRecommendations } from "./bootstrap/recommendations.ts";
import { createRetrievalStack } from "./bootstrap/retrieval-stack.ts";
import { createSessionReportRead } from "./bootstrap/session-reports.ts";
import { parsePrivateBackendConfig } from "./config.ts";
import { createDeckRenderSubprocess } from "./deck-render-subprocess.ts";
import { createDeckUploadService } from "./deck-upload-service.ts";
import { createDeckUploadWorker } from "./deck-upload-worker.ts";
import { createPrivateBackendHandler } from "./http.ts";
import { createJsonLogger, createMetricsRegistry } from "./observability.ts";
import { PreparedEvidenceCoordinator } from "./prepared-evidence.ts";
import { createPostgresPreparedEvidencePersistence } from "./prepared-evidence-store-postgres.ts";
import { ProjectionHttpPort } from "./projection-http-port.ts";
import { createTokenBucketRateLimiter } from "./rate-limit.ts";
import { createPostgresSessionReportRepository } from "./report/postgres-session-report-repository.ts";
import { createProvisionedSessionReportRepository } from "./report/provisioned-session-report-repository.ts";
import {
  createPreparedEvidenceReportObserver,
  SessionReportFinalizer,
} from "./report/session-report-finalizer.ts";

const DEFAULT_INGESTION_PROJECT = fileURLToPath(
  new URL("../../../services/ingestion", import.meta.url),
);

const config = parsePrivateBackendConfig(Bun.env);
const internalAuthToken = required("SERVICE_AUTH_TOKEN");
const bootstrapUsername = required("CONTROLLER_USERNAME");
const bootstrapPassword = required("CONTROLLER_PASSWORD");
const accountId = required("CONTROLLER_ACCOUNT_ID");
const logger = createJsonLogger();
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
const persistence = await createPostgresPreparedEvidencePersistence(preparedEvidenceSql, {
  ...(Bun.env.PRIVATE_PREPARED_EVIDENCE_STATE_KEY === undefined
    ? {}
    : { stateKey: Bun.env.PRIVATE_PREPARED_EVIDENCE_STATE_KEY }),
});
const store = persistence.store;
const sessionReports = createProvisionedSessionReportRepository(
  privateSql,
  createPostgresSessionReportRepository(privateSql),
);
const sessionReportFinalizer = new SessionReportFinalizer(sessionReports);
const reportObserver = createPreparedEvidenceReportObserver(sessionReportFinalizer, (error) => {
  logger.error({
    requestId: `session-report:${crypto.randomUUID()}`,
    path: "/internal/session-report",
    errorType: error instanceof Error ? error.name : "UnknownError",
  });
});
const accountDirectory = createAccountDirectory(createPostgresAccountStore(privateSql));
let coordinator: PreparedEvidenceCoordinator;
// The recommendation pipeline needs the coordinator (session contexts) while the coordinator
// needs the pipeline (publication authorization); closures resolve the cycle lazily.
const readCoordinator = () => coordinator;
const whisperPaths = optionalWhisperCppPaths();
const modelRouter = await createModelRouter(whisperPaths);
const retrievalStack = createRetrievalStack({
  privateSql,
  store,
  deckArtifactRoot,
  ingestionProject,
  logger,
  modelRouter,
  readCoordinator,
});
const recommendations = createRecommendations({
  modelRouter,
  slideText: retrievalStack.retrievalStore,
  internalRetrieval: retrievalStack.internalRetrieval,
  externalSearch: retrievalStack.externalSearch,
  externalFetcher: retrievalStack.externalFetcher,
  logger,
  readCoordinator,
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
const audio = createAudio({
  whisperPaths,
  modelRouter,
  store,
  recommendations,
  sessionReportFinalizer,
});
const sessionReportRead = createSessionReportRead({
  store,
  sessionReportFinalizer,
});
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
const bootstrapAccount = await accountDirectory.register(
  { username: bootstrapUsername, password: bootstrapPassword },
  Date.now(),
  { accountId },
);
if (bootstrapAccount.outcome === "REJECTED" && bootstrapAccount.reason !== "USERNAME_TAKEN") {
  throw new Error(`bootstrap account rejected: ${bootstrapAccount.reason}`);
}
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
    referenceDocuments: retrievalStack.referenceDocuments,
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
