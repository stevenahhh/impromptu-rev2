import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

const forbiddenBundleTokens = [
  "openai_api_key",
  "anthropic_api_key",
  "aws_access_key_id",
  "azure_speech_key",
  "deepgram_api_key",
  "google_api_key",
  "@google/generative-ai",
  "@azure/cognitiveservices-speech-sdk",
  "@aws-sdk/client-bedrock",
  "@aws-sdk/client-transcribe-streaming",
  "@deepgram/sdk",
  "onnxruntime",
  "tensorflow",
  "transformers.js",
  "services/model-router",
  "services/retrieval",
] as const;
const requiredSecurityHeaders = [
  "Content-Security-Policy",
  "Strict-Transport-Security",
  "X-Content-Type-Options",
  "Referrer-Policy",
  "Permissions-Policy",
] as const;

function bundleFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...bundleFiles(path));
    } else if ([".js", ".css", ".html", ".webmanifest"].includes(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

function assertNoForbiddenBundleTokens(files: readonly string[]): void {
  for (const file of files) {
    const content = readFileSync(file, "utf8").toLowerCase();
    for (const token of forbiddenBundleTokens) {
      if (content.includes(token)) {
        throw new Error(`Forbidden browser token ${token} found in ${file}`);
      }
    }
  }
}

function expectedShellAssets(root: string, directory = root): string[] {
  const assets: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      assets.push(...expectedShellAssets(root, path));
    } else if (
      entry.name !== "sw.js" &&
      entry.name !== "_headers" &&
      extname(entry.name) !== ".map"
    ) {
      assets.push(`/${path.slice(root.length + 1).replaceAll("\\", "/")}`);
    }
  }
  return assets.sort();
}

function verifyWorker(worker: string, app: "console" | "stage"): string {
  const precacheSource = worker.match(/const PRECACHE_URLS = (\[[\s\S]*?\]);/)?.[1];
  if (!precacheSource) throw new Error(`${app} service worker has no precache manifest`);
  const precache = JSON.parse(precacheSource) as string[];
  if (app === "console") {
    const expected = ["/icon.svg", "/manifest.webmanifest", "/offline.html"];
    if (JSON.stringify([...precache].sort()) !== JSON.stringify(expected)) {
      throw new Error("console precache manifest must contain its complete static offline shell");
    }
  } else {
    const expected = expectedShellAssets("apps/stage/dist");
    if (JSON.stringify(precache) !== JSON.stringify(expected)) {
      throw new Error("stage precache manifest does not cover its complete offline shell");
    }
    if (!precache.some((asset) => /\/assets\/[^/]+-[^/]+\.js$/.test(asset))) {
      throw new Error("stage precache manifest is missing versioned JavaScript");
    }
    if (!precache.some((asset) => /\/assets\/[^/]+-[^/]+\.css$/.test(asset))) {
      throw new Error("stage precache manifest is missing versioned CSS");
    }
  }
  if (worker.includes("caches.match(")) {
    throw new Error(`${app} service worker may not search global caches`);
  }
  const installBlock = worker.slice(
    worker.indexOf('self.addEventListener("install"'),
    worker.indexOf('self.addEventListener("activate"'),
  );
  if (installBlock.includes("skipWaiting") || worker.includes("clients.claim")) {
    throw new Error(`${app} service worker may not take over clients during installation`);
  }
  if (!worker.includes('type !== "IMPROMPTU_ACTIVATE_UPDATE"')) {
    throw new Error(`${app} service worker has no explicit activation handshake`);
  }
  const networkIndex = worker.indexOf("fetch(");
  const fallbackAsset = app === "console" ? "/offline.html" : "/index.html";
  const fallbackIndex = worker.indexOf(`match("${fallbackAsset}"`);
  if (networkIndex === -1 || fallbackIndex === -1 || networkIndex > fallbackIndex) {
    throw new Error(`${app} navigation must be network-first with scoped shell fallback`);
  }
  const cacheName = worker.match(/const CACHE_NAME = `?"?([^"`;]+)["`]?;/)?.[1];
  if (!cacheName) throw new Error(`${app} service worker cache identity is missing`);
  return cacheName;
}

function verifyStage(): string {
  const dist = "apps/stage/dist";
  if (!existsSync(dist)) throw new Error("Missing stage production bundle; run the build first");
  for (const requiredFile of ["_headers", "index.html", "manifest.webmanifest", "sw.js"]) {
    if (!existsSync(`${dist}/${requiredFile}`)) {
      throw new Error(`stage bundle is missing ${requiredFile}`);
    }
  }
  assertNoForbiddenBundleTokens(bundleFiles(dist));
  const deploymentHeaders = readFileSync(`${dist}/_headers`, "utf8");
  for (const header of requiredSecurityHeaders) {
    if (!deploymentHeaders.includes(`${header}:`)) {
      throw new Error(`stage deployment artifact is missing ${header}`);
    }
  }
  if (
    !deploymentHeaders.includes("frame-ancestors 'none'") ||
    deploymentHeaders.includes("'unsafe-inline'")
  ) {
    throw new Error("stage deployment CSP is not strict");
  }
  return verifyWorker(readFileSync(`${dist}/sw.js`, "utf8"), "stage");
}

type RoutesManifest = {
  readonly headers: readonly {
    readonly source: string;
    readonly headers: readonly { readonly key: string; readonly value: string }[];
  }[];
};
type MiddlewareManifest = {
  readonly middleware: Readonly<Record<string, { readonly files: readonly string[] }>>;
};

function verifyConsole(): string {
  const nextRoot = "apps/console/.next";
  if (!existsSync(`${nextRoot}/BUILD_ID`)) {
    throw new Error("Missing console Next.js production bundle; run the build first");
  }
  for (const requiredFile of ["offline.html", "icon.svg", "manifest.webmanifest", "sw.js"]) {
    if (!existsSync(`apps/console/public/${requiredFile}`)) {
      throw new Error(`console bundle is missing public/${requiredFile}`);
    }
  }
  assertNoForbiddenBundleTokens([
    ...bundleFiles(`${nextRoot}/static`),
    ...bundleFiles("apps/console/public"),
  ]);

  const routes = JSON.parse(
    readFileSync(`${nextRoot}/routes-manifest.json`, "utf8"),
  ) as RoutesManifest;
  const globalHeaders = routes.headers.find(({ source }) => source === "/:path*")?.headers ?? [];
  for (const header of requiredSecurityHeaders.filter(
    (name) => name !== "Content-Security-Policy",
  )) {
    if (!globalHeaders.some(({ key }) => key.toLowerCase() === header.toLowerCase())) {
      throw new Error(`console route manifest is missing ${header}`);
    }
  }

  const middlewareManifest = JSON.parse(
    readFileSync(`${nextRoot}/server/middleware-manifest.json`, "utf8"),
  ) as MiddlewareManifest;
  const middlewareFiles = Object.values(middlewareManifest.middleware).flatMap(({ files }) =>
    files.map((file) => `${nextRoot}/${file}`),
  );
  if (middlewareFiles.length === 0 || middlewareFiles.some((file) => !existsSync(file))) {
    throw new Error("console production bundle is missing its CSP middleware");
  }
  const middlewareSource = middlewareFiles.map((file) => readFileSync(file, "utf8")).join("\n");
  if (
    !middlewareSource.includes("Content-Security-Policy") ||
    !middlewareSource.includes("nonce-") ||
    middlewareSource.includes("'unsafe-inline'")
  ) {
    throw new Error("console production CSP middleware is missing or unsafe");
  }
  return verifyWorker(readFileSync("apps/console/public/sw.js", "utf8"), "console");
}

const cacheNames = [verifyConsole(), verifyStage()];
if (new Set(cacheNames).size !== cacheNames.length) {
  throw new Error("Browser service worker cache identity is shared");
}

console.log(
  "Browser bundles verified: Next.js Console and static Stage enforce strict production headers with isolated offline shells.",
);
