import { parseProjectionGatewayConfig } from "./config.ts";
import { createDeckAssetReader, createProjectionGatewayHandler } from "./http.ts";
import { createJsonLogger, createMetricsRegistry } from "./observability.ts";
import {
  createPostgresDisplayInvitationPersistence,
  createPostgresProjectionGatewayPersistence,
} from "./ports/postgres-projection-store.ts";
import { PreparedEvidenceProjectionGateway } from "./prepared-evidence.ts";
import { createTokenBucketRateLimiter } from "./rate-limit.ts";
import { createProjectionRealtimeProtocol, type ProjectionRealtimeConnection } from "./realtime.ts";

function required(name: string): string {
  const value = Bun.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
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

const internalAuthToken = Bun.env.SERVICE_AUTH_TOKEN;
if (internalAuthToken === undefined || internalAuthToken.length < 16) {
  throw new Error("SERVICE_AUTH_TOKEN of at least 16 characters is required");
}
const privateBackendOrigin = Bun.env.PRIVATE_BACKEND_ORIGIN;
if (
  privateBackendOrigin === undefined ||
  new URL(privateBackendOrigin).origin !== privateBackendOrigin
) {
  throw new Error("PRIVATE_BACKEND_ORIGIN must be an exact origin");
}
const config = parseProjectionGatewayConfig(Bun.env);
const deckArtifactRoot = Bun.env.DECK_ARTIFACT_ROOT;
if (
  deckArtifactRoot === undefined ||
  (!deckArtifactRoot.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(deckArtifactRoot))
) {
  throw new Error("DECK_ARTIFACT_ROOT must be an existing absolute directory");
}
const deckArtifactStats = await Bun.file(deckArtifactRoot)
  .stat()
  .catch(() => null);
if (deckArtifactStats === null || !deckArtifactStats.isDirectory()) {
  throw new Error("DECK_ARTIFACT_ROOT must be an existing absolute directory");
}
const projectionSql = new Bun.SQL(required("PROJECTION_DATABASE_URL"));
const projectionStateKey = Bun.env.PROJECTION_GATEWAY_STATE_KEY;
const persistence = await createPostgresProjectionGatewayPersistence(projectionSql, {
  ...(projectionStateKey === undefined ? {} : { stateKey: projectionStateKey }),
});
// Invitations restore into the same in-memory store from their own versioned row, before
// the gateway ever serves a request.
const invitationStateKey = Bun.env.PROJECTION_INVITATION_STATE_KEY;
const invitationPersistence = await createPostgresDisplayInvitationPersistence(
  projectionSql,
  persistence.store,
  invitationStateKey === undefined ? {} : { stateKey: invitationStateKey },
);
const gateway = new PreparedEvidenceProjectionGateway(persistence.store);
const logger = createJsonLogger();
const metrics = createMetricsRegistry("projection_gateway");
const publicRateLimiter = createTokenBucketRateLimiter({
  capacity: positiveNumber("PROJECTION_PUBLIC_RATE_LIMIT_CAPACITY", 120),
  refillPerSecond: positiveNumber("PROJECTION_PUBLIC_RATE_LIMIT_REFILL_PER_SECOND", 2),
  now: Date.now,
});
const connectionRateLimiter = createTokenBucketRateLimiter({
  capacity: positiveNumber("PROJECTION_CONNECTION_RATE_LIMIT_CAPACITY", 20),
  refillPerSecond: positiveNumber("PROJECTION_CONNECTION_RATE_LIMIT_REFILL_PER_SECOND", 1),
  now: Date.now,
});
const recordApplied = async (input: {
  readonly audienceDisplaySessionId: string;
  readonly commandId: string;
  readonly displayBindingEpoch: string;
}) => {
  try {
    const response = await fetch(`${privateBackendOrigin}/internal/stage-applied`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalAuthToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
};
const httpHandler = createProjectionGatewayHandler(config, {
  gateway,
  internalAuthToken,
  now: Date.now,
  persist: persistence.persist,
  persistInvitations: invitationPersistence.persist,
  stageReceiptWriter: { recordApplied },
  deckAssets: createDeckAssetReader(deckArtifactRoot),
  logger,
  metrics,
  publicRateLimiter,
  readiness: {
    async check() {
      await projectionSql`SELECT 1`;
      return { outcome: "READY" };
    },
  },
});
const realtime = createProjectionRealtimeProtocol({
  gateway,
  allowedOrigin: config.allowedOrigin,
  now: Date.now,
  recordApplied,
  connectionRateLimiter,
  metrics,
});
type RealtimeSocketData = {
  audienceDisplaySessionId: string;
  connection: ProjectionRealtimeConnection | null;
};
const server = Bun.serve<RealtimeSocketData, Record<never, never>>({
  hostname: config.host,
  port: config.port,
  fetch(request, server) {
    if (new URL(request.url).pathname !== "/v1/realtime") return httpHandler(request);
    const authentication = realtime.authenticate(request);
    if (authentication.outcome === "REJECTED") {
      const rateLimited = authentication.reason === "RATE_LIMITED";
      return new Response(JSON.stringify({ error: authentication.reason }), {
        status: rateLimited ? 429 : 403,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          ...(rateLimited
            ? {
                "retry-after": String(
                  Math.max(1, Math.ceil((authentication.retryAfterMs ?? 1_000) / 1_000)),
                ),
              }
            : {}),
        },
      });
    }
    return server.upgrade(request, {
      data: {
        audienceDisplaySessionId: authentication.audienceDisplaySessionId,
        connection: null,
      },
    })
      ? undefined
      : new Response(JSON.stringify({ error: "upgrade_required" }), { status: 426 });
  },
  websocket: {
    open(socket) {
      socket.data.connection = realtime.connect(socket.data.audienceDisplaySessionId, (message) =>
        socket.send(JSON.stringify(message)),
      );
      if (socket.data.connection === null) socket.close(1008, "display session unavailable");
    },
    async message(socket, message) {
      await socket.data.connection?.receive(message);
    },
    close(socket) {
      socket.data.connection?.close();
      socket.data.connection = null;
    },
  },
});

console.log(`projection-gateway listening on ${server.url}`);
