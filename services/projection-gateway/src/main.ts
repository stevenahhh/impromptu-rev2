import { parseProjectionGatewayConfig } from "./config.ts";
import { createProjectionGatewayHandler } from "./http.ts";
import { PreparedEvidenceProjectionGateway } from "./prepared-evidence.ts";

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
const gateway = new PreparedEvidenceProjectionGateway();
const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch: createProjectionGatewayHandler(config, {
    gateway,
    internalAuthToken,
    now: Date.now,
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
