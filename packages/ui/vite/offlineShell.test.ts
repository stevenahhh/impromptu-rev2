import { describe, expect, test } from "bun:test";

import { createServiceWorkerSource } from "./offlineShell";

const assets = [
  "/assets/index-a1b2c3.js",
  "/assets/index-d4e5f6.css",
  "/icon.svg",
  "/index.html",
  "/manifest.webmanifest",
];

describe("versioned offline shell", () => {
  test("preloads every emitted shell asset into an app-scoped release cache", () => {
    const worker = createServiceWorkerSource({
      appId: "stage",
      assets,
      buildId: "release123",
    });

    expect(worker).toContain('const CACHE_PREFIX = "impromptu-stage-shell-"');
    expect(worker).toContain('const CACHE_NAME = "impromptu-stage-shell-release123"');
    for (const asset of assets) {
      expect(worker).toContain(`"${asset}"`);
    }
    expect(worker).toContain("cache.addAll(PRECACHE_URLS)");
    expect(worker).toContain("key.startsWith(CACHE_PREFIX)");
  });

  test("waits for an explicit session-safe activation handshake", () => {
    const worker = createServiceWorkerSource({
      appId: "console",
      assets,
      buildId: "release123",
    });
    const installBlock = worker.slice(
      worker.indexOf('self.addEventListener("install"'),
      worker.indexOf('self.addEventListener("activate"'),
    );

    expect(installBlock).not.toContain("skipWaiting");
    expect(worker).not.toContain("clients.claim");
    expect(worker).toContain('type !== "IMPROMPTU_ACTIVATE_UPDATE"');
    expect(worker).toContain('reason !== "SESSION_ENDED"');
    expect(worker).toContain('reason !== "OPERATOR_CONFIRMED"');
    expect(worker.indexOf("self.skipWaiting()")).toBeGreaterThan(
      worker.indexOf('self.addEventListener("message"'),
    );
  });

  test("uses network-first documents and never searches foreign caches", () => {
    const worker = createServiceWorkerSource({
      appId: "stage",
      assets,
      buildId: "release123",
    });

    expect(worker).not.toContain("caches.match(");
    expect(worker).toContain('request.mode === "navigate"');
    expect(worker.indexOf("await fetch(request)")).toBeLessThan(
      worker.indexOf('shellCache.match("/index.html"'),
    );
    expect(worker).toContain("requestUrl.origin !== self.location.origin");
  });
});
