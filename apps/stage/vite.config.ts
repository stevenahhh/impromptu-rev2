import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type ProxyOptions, type ResolvedConfig } from "vite";

import { versionedOfflineShell } from "../../packages/ui/vite/offlineShell";
import { responseSecurityHeaders } from "../../packages/ui/vite/securityHeaders";
import {
  stageGatewayProxyTarget,
  stagePublicApiOrigin,
  stageWebSocketOrigin,
} from "./vite-runtime-config";

/**
 * The one-use invitation rides in the URL fragment, so no request can ever distinguish the
 * invitation landing from the rest of the Stage SPA: every Stage document ships
 * `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. Stage's same-origin /v1
 * mutations pin `referrerPolicy: "same-origin"` per fetch, keeping the gateway's exact
 * Origin/Referer mutation checks working under the page policy. Hashed assets stay cacheable;
 * only document responses carry no-store.
 */
function stageDocumentHeaders(): Plugin {
  let resolvedConfig: ResolvedConfig;
  const headers = {
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  } as const;
  return {
    name: "impromptu-stage-invitation-headers",
    config() {
      // server.headers/preview.headers are defaults: Vite still sets its own immutable
      // Cache-Control on hashed assets and optimized dependencies, so this only hardens the
      // documents Vite leaves unmarked. Plugin order makes this Referrer-Policy win over the
      // shared strict-origin-when-cross-origin default.
      return { server: { headers }, preview: { headers } };
    },
    configResolved(config) {
      resolvedConfig = config;
    },
    closeBundle() {
      // Runs after responseSecurityHeaders writes _headers. A Netlify/CF Pages host would
      // merge two same-name headers additively, so the global rule is rewritten in place
      // rather than appended, keeping a single unambiguous policy.
      const outputDirectory = resolve(resolvedConfig.root, resolvedConfig.build.outDir);
      const headersPath = join(outputDirectory, "_headers");
      const generated = readFileSync(headersPath, "utf8");
      const hardened = generated.replace(
        "Referrer-Policy: strict-origin-when-cross-origin",
        "Referrer-Policy: no-referrer",
      );
      writeFileSync(
        headersPath,
        `${hardened}\n/\n  Cache-Control: no-store\n/index.html\n  Cache-Control: no-store\n/display/*\n  Cache-Control: no-store\n`,
      );
    },
  };
}

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
      stageDocumentHeaders(),
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
