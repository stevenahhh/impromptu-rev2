import { parsePrivateBackendConfig } from "./config.ts";
import { createPrivateBackendHandler } from "./http.ts";
import { PreparedEvidenceCoordinator } from "./prepared-evidence.ts";
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
const coordinator = new PreparedEvidenceCoordinator(projection);
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
  }),
});

console.log(`private-backend listening on ${server.url}`);
