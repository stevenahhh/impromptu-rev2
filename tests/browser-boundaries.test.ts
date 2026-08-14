import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

const browserRoots = ["apps/console", "apps/stage", "packages/ui"] as const;
const forbiddenImports = [
  "openai",
  "anthropic",
  "@google/generative-ai",
  "@aws-sdk/client-bedrock",
  "onnxruntime",
  "@tensorflow",
  "transformers",
  "langchain",
  "services/",
] as const;

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") {
      continue;
    }
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if ([".ts", ".tsx", ".js", ".jsx"].includes(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:from\s+|import\s*\()["']([^"']+)["']/g)].flatMap((match) =>
    match[1] ? [match[1]] : [],
  );
}

function readManifest(app: "console" | "stage") {
  return JSON.parse(readFileSync(`apps/${app}/public/manifest.webmanifest`, "utf8")) as {
    id: string;
    name: string;
    display: string;
    scope: string;
    start_url: string;
  };
}

describe("browser build boundaries", () => {
  test("keeps browser import graphs free of services and model providers", () => {
    for (const root of browserRoots) {
      const manifest = readFileSync(`${root}/package.json`, "utf8").toLowerCase();
      for (const forbidden of forbiddenImports) {
        expect(manifest).not.toContain(forbidden);
      }

      for (const file of sourceFiles(root)) {
        for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
          for (const forbidden of forbiddenImports) {
            expect(`${file}: ${specifier.toLowerCase()}`).not.toContain(forbidden);
          }
        }
      }
    }
  });

  test("ships independent PWA identities and service workers", () => {
    const consoleManifest = readManifest("console");
    const stageManifest = readManifest("stage");

    expect(consoleManifest.id).not.toBe(stageManifest.id);
    expect(consoleManifest.name).not.toBe(stageManifest.name);
    expect(consoleManifest.display).toBe("standalone");
    expect(stageManifest.display).toBe("fullscreen");
    expect(consoleManifest.scope).toBe("/");
    expect(stageManifest.scope).toBe("/");
    expect(consoleManifest.start_url).toBe("/");
    expect(stageManifest.start_url).toBe("/");

    const consoleWorker = readFileSync("apps/console/public/sw.js", "utf8");
    const stageWorker = readFileSync("apps/stage/public/sw.js", "utf8");
    const consoleCache = consoleWorker.match(/CACHE_NAME = "([^"]+)"/)?.[1];
    const stageCache = stageWorker.match(/CACHE_NAME = "([^"]+)"/)?.[1];

    expect(consoleCache).toBeTruthy();
    expect(stageCache).toBeTruthy();
    expect(consoleCache).not.toBe(stageCache);
    expect(consoleWorker).not.toMatch(/https?:\/\//);
    expect(stageWorker).not.toMatch(/https?:\/\//);
    expect(consoleWorker).toContain('request.mode === "navigate"');
    expect(stageWorker).toContain('request.mode === "navigate"');
  });

  test("keeps application styles on shared design tokens", () => {
    for (const path of ["apps/console/src/console.css", "apps/stage/src/stage.css"]) {
      const css = readFileSync(path, "utf8");
      expect(css).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(|oklch\(/i);
      expect(css).not.toMatch(/:\s*-?\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%)/i);
      expect(css).not.toContain("!important");
    }
  });

  test("provides a production bundle boundary validator", () => {
    expect(existsSync("scripts/verify-browser-boundaries.ts")).toBe(true);
  });
});
