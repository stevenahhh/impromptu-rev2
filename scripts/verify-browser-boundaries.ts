import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

const browserApps = ["console", "stage"] as const;
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

const cacheNames = new Set<string>();

for (const app of browserApps) {
  const dist = `apps/${app}/dist`;
  if (!existsSync(dist)) {
    throw new Error(`Missing ${app} production bundle; run the build first`);
  }

  for (const requiredFile of ["_headers", "index.html", "manifest.webmanifest", "sw.js"]) {
    if (!existsSync(`${dist}/${requiredFile}`)) {
      throw new Error(`${app} bundle is missing ${requiredFile}`);
    }
  }

  for (const file of bundleFiles(dist)) {
    const content = readFileSync(file, "utf8").toLowerCase();
    for (const token of forbiddenBundleTokens) {
      if (content.includes(token)) {
        throw new Error(`Forbidden browser token ${token} found in ${file}`);
      }
    }
  }

  const deploymentHeaders = readFileSync(`${dist}/_headers`, "utf8");
  if (
    !deploymentHeaders.includes("Content-Security-Policy:") ||
    !deploymentHeaders.includes("frame-ancestors 'none'")
  ) {
    throw new Error(`${app} deployment artifact does not deny frame ancestors`);
  }

  const worker = readFileSync(`${dist}/sw.js`, "utf8");
  const precacheSource = worker.match(/const PRECACHE_URLS = (\[[\s\S]*?\]);/)?.[1];
  if (!precacheSource) {
    throw new Error(`${app} service worker has no generated precache manifest`);
  }
  const precache = JSON.parse(precacheSource) as string[];
  const expected = expectedShellAssets(dist);
  if (JSON.stringify(precache) !== JSON.stringify(expected)) {
    throw new Error(`${app} precache manifest does not cover its complete offline shell`);
  }
  if (!precache.some((asset) => /\/assets\/[^/]+-[^/]+\.js$/.test(asset))) {
    throw new Error(`${app} precache manifest is missing versioned JavaScript`);
  }
  if (!precache.some((asset) => /\/assets\/[^/]+-[^/]+\.css$/.test(asset))) {
    throw new Error(`${app} precache manifest is missing versioned CSS`);
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
  const networkIndex = worker.indexOf("await fetch(request)");
  const fallbackIndex = worker.indexOf('shellCache.match("/index.html"');
  if (networkIndex === -1 || fallbackIndex === -1 || networkIndex > fallbackIndex) {
    throw new Error(`${app} navigation must be network-first with scoped shell fallback`);
  }
  const cacheName = worker.match(/const CACHE_NAME = "([^"]+)"/)?.[1];
  if (!cacheName || cacheNames.has(cacheName)) {
    throw new Error(`${app} service worker cache identity is missing or shared`);
  }
  cacheNames.add(cacheName);
}

console.log(
  "Browser bundles verified: 2 isolated versioned offline shells, 0 forbidden provider/model tokens.",
);
