import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { versionedOfflineShell } from "../../packages/ui/vite/offlineShell";
import { responseSecurityHeaders } from "../../packages/ui/vite/securityHeaders";

export default defineConfig({
  plugins: [
    react(),
    responseSecurityHeaders("console"),
    versionedOfflineShell({ appId: "console" }),
  ],
  build: {
    sourcemap: true,
  },
});
