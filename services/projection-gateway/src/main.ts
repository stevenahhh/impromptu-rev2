import { parseProjectionGatewayConfig } from "./config.ts";
import { createProjectionGatewayHandler } from "./http.ts";
import { PreparedEvidenceProjectionGateway } from "./prepared-evidence.ts";

const internalAuthToken = Bun.env.SERVICE_AUTH_TOKEN;
if (internalAuthToken === undefined || internalAuthToken.length < 16) {
  throw new Error("SERVICE_AUTH_TOKEN of at least 16 characters is required");
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
  }),
});

console.log(`projection-gateway listening on ${server.url}`);
