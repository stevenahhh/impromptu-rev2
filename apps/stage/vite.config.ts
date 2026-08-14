import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { versionedOfflineShell } from "../../packages/ui/vite/offlineShell";
import { responseSecurityHeaders } from "../../packages/ui/vite/securityHeaders";

export default defineConfig({
  plugins: [react(), responseSecurityHeaders("stage"), versionedOfflineShell({ appId: "stage" })],
  build: {
    sourcemap: true,
  },
});
