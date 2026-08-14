import { parseProjectionGatewayConfig } from "./config.ts";
import { createProjectionGatewayHandler } from "./http.ts";

const config = parseProjectionGatewayConfig(Bun.env);
const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch: createProjectionGatewayHandler(config),
});

console.log(`projection-gateway listening on ${server.url}`);
