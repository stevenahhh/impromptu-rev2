import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

import { versionedOfflineShell } from "../../packages/ui/vite/offlineShell";
import { responseSecurityHeaders } from "../../packages/ui/vite/securityHeaders";

const serviceWorkerCohort = process.env.IMPROMPTU_RELEASE_COHORT ?? "stable";

/**
 * Local private-backend origin used by the repo's dev command
 * (services/private-backend defaults to 0.0.0.0:3001). Override with
 * CONSOLE_PRIVATE_API_ORIGIN when the backend runs elsewhere.
 */
const DEFAULT_PRIVATE_API_ORIGIN = "http://127.0.0.1:3001";

export function consolePrivateApiOrigin(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = environment.CONSOLE_PRIVATE_API_ORIGIN;
  return configured === undefined || configured.length === 0
    ? DEFAULT_PRIVATE_API_ORIGIN
    : configured;
}

/**
 * Same-origin `/v1` bridge for dev/preview. The Console ships with
 * connect-src 'self', so its private API must stay same-origin in the browser.
 * Host and Origin are forwarded untouched (changeOrigin stays false) so the
 * backend's exact-origin CSRF checks keep observing the browser origin.
 */
const privateApiProxy: ProxyOptions = {
  target: consolePrivateApiOrigin(),
  changeOrigin: false,
};

export default defineConfig({
  plugins: [
    react(),
    responseSecurityHeaders("console"),
    versionedOfflineShell({ appId: "console", cohort: serviceWorkerCohort }),
  ],
  define: {
    "import.meta.env.IMPROMPTU_SW_COHORT": JSON.stringify(serviceWorkerCohort),
  },
  server: { proxy: { "/v1": privateApiProxy } },
  preview: { proxy: { "/v1": privateApiProxy } },
  build: {
    sourcemap: true,
  },
});
