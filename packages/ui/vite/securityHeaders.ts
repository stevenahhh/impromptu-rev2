import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { HtmlTagDescriptor, Plugin, ResolvedConfig } from "vite";

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

/**
 * The dev server alone relaxes script-src/style-src.
 *
 * Vite injects its HMR preamble as an inline script and its plugins inject inline styles;
 * under the shipped `script-src 'self'` the preamble is blocked and React never boots, so
 * `vite dev` renders a blank page. This allowance exists only in the dev server response and
 * is never written to the deployment headers or the built artifact.
 */
export function createDevelopmentContentSecurityPolicy(surface: BrowserSurface) {
  return createContentSecurityPolicy(surface)
    .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
    .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'");
}

export function createContentSecurityPolicyMeta(surface: BrowserSurface): HtmlTagDescriptor {
  const policy = createContentSecurityPolicy(surface).replace("; frame-ancestors 'none'", "");
  return {
    tag: "meta",
    attrs: {
      "http-equiv": "Content-Security-Policy",
      content: policy,
    },
    injectTo: "head-prepend",
  };
}

export function createDeploymentHeaders(surface: BrowserSurface) {
  return `/*\n  Content-Security-Policy: ${createContentSecurityPolicy(surface)}\n`;
}

export function responseSecurityHeaders(surface: BrowserSurface): Plugin {
  let resolvedConfig: ResolvedConfig;
  const headers = {
    "Content-Security-Policy": createContentSecurityPolicy(surface),
  };
  const developmentHeaders = {
    "Content-Security-Policy": createDevelopmentContentSecurityPolicy(surface),
  };

  return {
    name: `impromptu-${surface}-response-security`,
    config(_userConfig, environment) {
      return {
        preview: { headers },
        server: { headers: environment.command === "serve" ? developmentHeaders : headers },
      };
    },
    configResolved(config) {
      resolvedConfig = config;
    },
    transformIndexHtml(html) {
      if (resolvedConfig.command === "serve") return html;
      return { html, tags: [createContentSecurityPolicyMeta(surface)] };
    },
    closeBundle() {
      const outputDirectory = resolve(resolvedConfig.root, resolvedConfig.build.outDir);
      writeFileSync(join(outputDirectory, "_headers"), createDeploymentHeaders(surface));
    },
  };
}
