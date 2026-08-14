import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

import type { Plugin, ResolvedConfig } from "vite";

interface ServiceWorkerOptions {
  appId: "console" | "stage";
  assets: string[];
  buildId: string;
}

interface OfflineShellOptions {
  appId: ServiceWorkerOptions["appId"];
}

const excludedExtensions = new Set([".map"]);
const excludedFiles = new Set(["_headers", "sw.js"]);

function collectShellAssets(root: string, directory = root): string[] {
  const assets: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      assets.push(...collectShellAssets(root, path));
    } else if (!excludedFiles.has(entry.name) && !excludedExtensions.has(extname(entry.name))) {
      assets.push(`/${relative(root, path).replaceAll("\\", "/")}`);
    }
  }

  return assets.sort();
}

function createBuildId(root: string, assets: string[]): string {
  const hash = createHash("sha256");
  for (const asset of assets) {
    hash.update(asset);
    hash.update(readFileSync(join(root, asset.slice(1))));
  }
  return hash.digest("hex").slice(0, 12);
}

export function createServiceWorkerSource({ appId, assets, buildId }: ServiceWorkerOptions) {
  const cachePrefix = `impromptu-${appId}-shell-`;
  const cacheName = `${cachePrefix}${buildId}`;

  return `const CACHE_PREFIX = ${JSON.stringify(cachePrefix)};
const CACHE_NAME = ${JSON.stringify(cacheName)};
const PRECACHE_URLS = ${JSON.stringify(assets, null, 2)};

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(async (keys) => {
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      );
    }),
  );
});

self.addEventListener("message", (event) => {
  const { type, reason } = event.data ?? {};
  if (
    type !== "IMPROMPTU_ACTIVATE_UPDATE" ||
    (reason !== "SESSION_ENDED" && reason !== "OPERATOR_CONFIRMED")
  ) {
    return;
  }

  event.waitUntil(
    self.skipWaiting().then(() => {
      event.ports[0]?.postMessage({
        type: "IMPROMPTU_UPDATE_ACTIVATION_ACCEPTED",
        reason,
      });
    }),
  );
});

async function serveRequest(request) {
  const requestUrl = new URL(request.url);
  if (request.method !== "GET" || requestUrl.origin !== self.location.origin) {
    return fetch(request);
  }

  const shellCache = await caches.open(CACHE_NAME);
  if (request.mode === "navigate") {
    try {
      return await fetch(request);
    } catch {
      return (await shellCache.match("/index.html", { ignoreSearch: true })) ?? Response.error();
    }
  }

  return (
    (await shellCache.match(requestUrl.pathname, { ignoreSearch: true })) ?? fetch(request)
  );
}

self.addEventListener("fetch", (event) => {
  event.respondWith(serveRequest(event.request));
});
`;
}

export function versionedOfflineShell({ appId }: OfflineShellOptions): Plugin {
  let resolvedConfig: ResolvedConfig;

  return {
    name: `impromptu-${appId}-offline-shell`,
    apply: "build",
    configResolved(config) {
      resolvedConfig = config;
    },
    closeBundle() {
      const outputDirectory = resolve(resolvedConfig.root, resolvedConfig.build.outDir);
      const assets = collectShellAssets(outputDirectory);
      const buildId = createBuildId(outputDirectory, assets);
      const worker = createServiceWorkerSource({ appId, assets, buildId });
      writeFileSync(join(outputDirectory, "sw.js"), worker);
    },
  };
}
