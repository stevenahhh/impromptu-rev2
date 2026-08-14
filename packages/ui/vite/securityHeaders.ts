import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Plugin, ResolvedConfig } from "vite";

type BrowserSurface = "console" | "stage";

const sharedDirectives = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
] as const;

export function createContentSecurityPolicy(surface: BrowserSurface) {
  const formAction = surface === "console" ? "form-action 'self'" : "form-action 'none'";
  return [...sharedDirectives, formAction].join("; ");
}

export function createDeploymentHeaders(surface: BrowserSurface) {
  return `/*\n  Content-Security-Policy: ${createContentSecurityPolicy(surface)}\n`;
}

export function responseSecurityHeaders(surface: BrowserSurface): Plugin {
  let resolvedConfig: ResolvedConfig;
  const headers = {
    "Content-Security-Policy": createContentSecurityPolicy(surface),
  };

  return {
    name: `impromptu-${surface}-response-security`,
    config() {
      return {
        preview: { headers },
        server: { headers },
      };
    },
    configResolved(config) {
      resolvedConfig = config;
    },
    closeBundle() {
      const outputDirectory = resolve(resolvedConfig.root, resolvedConfig.build.outDir);
      writeFileSync(join(outputDirectory, "_headers"), createDeploymentHeaders(surface));
    },
  };
}
