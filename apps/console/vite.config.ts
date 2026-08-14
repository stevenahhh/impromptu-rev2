import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { versionedOfflineShell } from "../../packages/ui/vite/offlineShell";

export default defineConfig({
  plugins: [react(), versionedOfflineShell({ appId: "console" })],
  build: {
    sourcemap: true,
  },
});
