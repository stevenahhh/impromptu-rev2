import { parsePrivateBackendConfig } from "./config.ts";
import { createPrivateBackendHandler } from "./http.ts";

const config = parsePrivateBackendConfig(Bun.env);
const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch: createPrivateBackendHandler(config),
});

console.log(`private-backend listening on ${server.url}`);
