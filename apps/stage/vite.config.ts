import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

import { versionedOfflineShell } from "../../packages/ui/vite/offlineShell";
import { responseSecurityHeaders } from "../../packages/ui/vite/securityHeaders";
import {
  stageGatewayProxyTarget,
  stagePublicApiOrigin,
  stageWebSocketOrigin,
} from "./vite-runtime-config";

export default defineConfig(({ command }) => {
  const productionBuild = command === "build" || process.env.NODE_ENV === "production";
  const serviceWorkerCohort = process.env.IMPROMPTU_RELEASE_COHORT ?? "stable";
  const publicApiOrigin = stagePublicApiOrigin(process.env, productionBuild);
  // `ws` carries the `/v1/realtime` upgrade; without it the dev server answers the upgrade itself
  // and the realtime channel never reaches the gateway.
  const publicApiProxy: ProxyOptions = {
    target: stageGatewayProxyTarget(process.env),
    changeOrigin: false,
    ws: true,
  };
  const realtimeOrigin = stageWebSocketOrigin(publicApiOrigin);
  // Same-origin Stage needs no extra sources: `'self'` already covers its own host, including the
  // `ws:`/`wss:` upgrade of that host.
  const connectSources = [publicApiOrigin, realtimeOrigin].filter((source) => source !== "");
  const imageSources = [publicApiOrigin].filter((source) => source !== "");

  return {
    plugins: [
      react(),
      responseSecurityHeaders("stage", { connectSources, imageSources }),
      versionedOfflineShell({ appId: "stage", cohort: serviceWorkerCohort }),
    ],
    define: {
      "import.meta.env.IMPROMPTU_SW_COHORT": JSON.stringify(serviceWorkerCohort),
      "import.meta.env.STAGE_PUBLIC_API_ORIGIN": JSON.stringify(publicApiOrigin),
    },
    server: { proxy: { "/v1": publicApiProxy } },
    preview: { proxy: { "/v1": publicApiProxy } },
    build: {
      sourcemap: true,
    },
  };
});
