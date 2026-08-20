import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { HtmlTagDescriptor, Plugin, ResolvedConfig } from "vite";

type BrowserSurface = "console" | "stage";

interface ContentSecurityPolicyOptions {
  readonly connectSources?: readonly string[];
  readonly imageSources?: readonly string[];
}

const STRICT_TRANSPORT_SECURITY = "max-age=63072000; includeSubDomains; preload";
const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=()",
  "camera=()",
  "display-capture=()",
  "encrypted-media=()",
  "fullscreen=(self)",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "payment=()",
  "picture-in-picture=()",
  "publickey-credentials-get=()",
  "usb=()",
].join(", ");

function productionSecurityHeaders(surface: BrowserSurface, options: ContentSecurityPolicyOptions) {
  return {
    "Content-Security-Policy": createContentSecurityPolicy(surface, options),
    "Permissions-Policy": PERMISSIONS_POLICY,
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Strict-Transport-Security": STRICT_TRANSPORT_SECURITY,
    "X-Content-Type-Options": "nosniff",
  } as const;
}

export function createContentSecurityPolicy(
  surface: BrowserSurface,
  options: ContentSecurityPolicyOptions = {},
) {
  const connectSources = ["'self'", ...(options.connectSources ?? [])].join(" ");
  const imageSources = ["'self'", "data:", ...(options.imageSources ?? [])].join(" ");
  const formAction = surface === "console" ? "form-action 'self'" : "form-action 'none'";
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    `img-src ${imageSources}`,
    `connect-src ${connectSources}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    formAction,
  ].join("; ");
}

/**
 * The dev server alone relaxes script-src/style-src.
 *
 * Vite injects its HMR preamble as an inline script and its plugins inject inline styles;
 * under the shipped `script-src 'self'` the preamble is blocked and React never boots, so
 * `vite dev` renders a blank page. This allowance exists only in the dev server response and
 * is never written to the deployment headers or the built artifact.
 */
export function createDevelopmentContentSecurityPolicy(
  surface: BrowserSurface,
  options: ContentSecurityPolicyOptions = {},
) {
  return createContentSecurityPolicy(surface, options)
    .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
    .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'");
}

export function createContentSecurityPolicyMeta(
  surface: BrowserSurface,
  options: ContentSecurityPolicyOptions = {},
): HtmlTagDescriptor {
  const policy = createContentSecurityPolicy(surface, options).replace(
    "; frame-ancestors 'none'",
    "",
  );
  return {
    tag: "meta",
    attrs: {
      "http-equiv": "Content-Security-Policy",
      content: policy,
    },
    injectTo: "head-prepend",
  };
}

export function createDeploymentHeaders(
  surface: BrowserSurface,
  options: ContentSecurityPolicyOptions = {},
) {
  const headers = productionSecurityHeaders(surface, options);
  return `/*\n${Object.entries(headers)
    .map(([key, value]) => `  ${key}: ${value}`)
    .join("\n")}\n`;
}

export function responseSecurityHeaders(
  surface: BrowserSurface,
  options: ContentSecurityPolicyOptions = {},
): Plugin {
  let resolvedConfig: ResolvedConfig;
  const headers = productionSecurityHeaders(surface, options);
  const developmentHeaders = {
    ...headers,
    "Content-Security-Policy": createDevelopmentContentSecurityPolicy(surface, options),
  };
  delete (developmentHeaders as Partial<typeof developmentHeaders>)["Strict-Transport-Security"];

  return {
    name: `impromptu-${surface}-response-security`,
    config() {
      return {
        preview: { headers },
        server: { headers: developmentHeaders },
      };
    },
    configResolved(config) {
      resolvedConfig = config;
    },
    transformIndexHtml(html) {
      if (resolvedConfig.command === "serve") return html;
      return { html, tags: [createContentSecurityPolicyMeta(surface, options)] };
    },
    closeBundle() {
      const outputDirectory = resolve(resolvedConfig.root, resolvedConfig.build.outDir);
      writeFileSync(join(outputDirectory, "_headers"), createDeploymentHeaders(surface, options));
    },
  };
}
