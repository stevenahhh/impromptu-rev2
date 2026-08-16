import { parseProjectionGatewayConfig } from "./config.ts";
import { createDeckAssetReader, createProjectionGatewayHandler } from "./http.ts";
import {
  createProjectionGatewayStore,
  PreparedEvidenceProjectionGateway,
  ProjectionGatewaySnapshotError,
  restoreProjectionGatewayStore,
  snapshotProjectionGatewayStore,
} from "./prepared-evidence.ts";
import { createProjectionRealtimeProtocol, type ProjectionRealtimeConnection } from "./realtime.ts";

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
const databasePath = Bun.env.PROJECTION_DATABASE_PATH;
if (databasePath === undefined || databasePath.length === 0) {
  throw new Error("PROJECTION_DATABASE_PATH is required");
}
const databaseFile = Bun.file(databasePath);
let store = createProjectionGatewayStore();
if (await databaseFile.exists()) {
  let input: unknown;
  try {
    input = await databaseFile.json();
  } catch {
    throw new ProjectionGatewaySnapshotError("projection database snapshot is not valid JSON");
  }
  const restored = restoreProjectionGatewayStore(input);
  if (restored.outcome !== "RESTORED") {
    throw new ProjectionGatewaySnapshotError("projection database snapshot failed validation");
  }
  store = restored.store;
}
const gateway = new PreparedEvidenceProjectionGateway(store);
const persist = async () => {
  await Bun.write(databasePath, JSON.stringify(snapshotProjectionGatewayStore(store)));
};
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
  persist,
  stageReceiptWriter: { recordApplied },
  deckAssets: createDeckAssetReader(deckArtifactRoot),
});
const realtime = createProjectionRealtimeProtocol({
  gateway,
  allowedOrigin: config.allowedOrigin,
  now: Date.now,
  recordApplied,
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
      return new Response(JSON.stringify({ error: authentication.reason }), {
        status: 403,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
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
