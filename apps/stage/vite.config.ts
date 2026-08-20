import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

import { versionedOfflineShell } from "../../packages/ui/vite/offlineShell";
import { responseSecurityHeaders } from "../../packages/ui/vite/securityHeaders";
import { stagePublicApiOrigin, stageWebSocketOrigin } from "./vite-runtime-config";

export default defineConfig(({ command }) => {
  const productionBuild = command === "build" || process.env.NODE_ENV === "production";
  const serviceWorkerCohort = process.env.IMPROMPTU_RELEASE_COHORT ?? "stable";
  const projectionGatewayOrigin = stagePublicApiOrigin(process.env, productionBuild);
  const publicApiProxy: ProxyOptions = {
    target: projectionGatewayOrigin,
    changeOrigin: false,
  };

  return {
    plugins: [
      react(),
      responseSecurityHeaders("stage", {
        connectSources: [projectionGatewayOrigin, stageWebSocketOrigin(projectionGatewayOrigin)],
        imageSources: [projectionGatewayOrigin],
      }),
      versionedOfflineShell({ appId: "stage", cohort: serviceWorkerCohort }),
    ],
    define: {
      "import.meta.env.IMPROMPTU_SW_COHORT": JSON.stringify(serviceWorkerCohort),
      "import.meta.env.STAGE_PUBLIC_API_ORIGIN": JSON.stringify(projectionGatewayOrigin),
    },
    server: { proxy: { "/v1": publicApiProxy } },
    preview: { proxy: { "/v1": publicApiProxy } },
    build: {
      sourcemap: true,
    },
  };
});
