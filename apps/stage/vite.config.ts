import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { versionedOfflineShell } from "../../packages/ui/vite/offlineShell";
import { responseSecurityHeaders } from "../../packages/ui/vite/securityHeaders";

const serviceWorkerCohort = process.env.IMPROMPTU_RELEASE_COHORT ?? "stable";

export default defineConfig({
  plugins: [
    react(),
    responseSecurityHeaders("stage"),
    versionedOfflineShell({ appId: "stage", cohort: serviceWorkerCohort }),
  ],
  define: {
    "import.meta.env.IMPROMPTU_SW_COHORT": JSON.stringify(serviceWorkerCohort),
  },
  build: {
    sourcemap: true,
  },
});
