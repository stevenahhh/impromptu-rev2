import { parseProjectionGatewayConfig } from "./config.ts";
import { createProjectionGatewayHandler } from "./http.ts";
import {
  createProjectionGatewayStore,
  PreparedEvidenceProjectionGateway,
  ProjectionGatewaySnapshotError,
  restoreProjectionGatewayStore,
  snapshotProjectionGatewayStore,
} from "./prepared-evidence.ts";

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
const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch: createProjectionGatewayHandler(config, {
    gateway,
    internalAuthToken,
    now: Date.now,
    persist,
    stageReceiptWriter: {
      async recordApplied(input) {
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
      },
    },
  }),
});

console.log(`projection-gateway listening on ${server.url}`);
