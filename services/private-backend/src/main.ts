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
const coordinator = new PreparedEvidenceCoordinator(projection, store);
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
        return code === expectedAuthorizationCode ? { accountId, actorId } : null;
      },
    },
    now: Date.now,
    persist,
  }),
});

console.log(`private-backend listening on ${server.url}`);
