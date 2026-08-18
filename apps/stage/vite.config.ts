import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

import { versionedOfflineShell } from "../../packages/ui/vite/offlineShell";
import { responseSecurityHeaders } from "../../packages/ui/vite/securityHeaders";

const serviceWorkerCohort = process.env.IMPROMPTU_RELEASE_COHORT ?? "stable";
const projectionGatewayOrigin = process.env.STAGE_PUBLIC_API_ORIGIN ?? "http://127.0.0.1:3002";
const publicApiProxy: ProxyOptions = {
  target: projectionGatewayOrigin,
  changeOrigin: false,
};

export default defineConfig({
  plugins: [
    react(),
    responseSecurityHeaders("stage"),
    versionedOfflineShell({ appId: "stage", cohort: serviceWorkerCohort }),
  ],
  define: {
    "import.meta.env.IMPROMPTU_SW_COHORT": JSON.stringify(serviceWorkerCohort),
  },
  server: { proxy: { "/v1": publicApiProxy } },
  preview: { proxy: { "/v1": publicApiProxy } },
  build: {
    sourcemap: true,
  },
});
