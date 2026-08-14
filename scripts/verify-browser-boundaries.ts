import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

const browserApps = ["console", "stage"] as const;
const forbiddenBundleTokens = [
  "openai_api_key",
  "anthropic_api_key",
  "google_api_key",
  "@google/generative-ai",
  "@aws-sdk/client-bedrock",
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

for (const app of browserApps) {
  const dist = `apps/${app}/dist`;
  if (!existsSync(dist)) {
    throw new Error(`Missing ${app} production bundle; run the build first`);
  }

  for (const requiredFile of ["index.html", "manifest.webmanifest", "sw.js"]) {
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
}

const consoleWorker = readFileSync("apps/console/dist/sw.js", "utf8");
const stageWorker = readFileSync("apps/stage/dist/sw.js", "utf8");
if (consoleWorker === stageWorker) {
  throw new Error("Console and Stage must not share a service worker implementation");
}

console.log("Browser bundles verified: 2 isolated PWAs, 0 forbidden provider/model tokens.");
