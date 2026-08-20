import { describe, expect, test } from "bun:test";

import {
  createContentSecurityPolicy,
  createContentSecurityPolicyMeta,
  createDeploymentHeaders,
  createDevelopmentContentSecurityPolicy,
} from "./securityHeaders";

const preservedDirectives = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
] as const;

const requiredResponseHeaders = [
  "Content-Security-Policy:",
  "Strict-Transport-Security: max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options: nosniff",
  "Referrer-Policy: strict-origin-when-cross-origin",
  "Permissions-Policy:",
] as const;

describe("browser response security headers", () => {
  test("preserves each CSP directive and denies all frame ancestors", () => {
    for (const surface of ["console", "stage"] as const) {
      const policy = createContentSecurityPolicy(surface);
      for (const directive of preservedDirectives) {
        expect(policy).toContain(directive);
      }
      expect(policy).toContain("frame-ancestors 'none'");
      expect(policy).toContain(surface === "console" ? "form-action 'self'" : "form-action 'none'");
    }
  });

  test("emits the CSP and complete production response-header set", () => {
    for (const surface of ["console", "stage"] as const) {
      const deploymentHeaders = createDeploymentHeaders(surface);
      expect(deploymentHeaders).toContain(
        `Content-Security-Policy: ${createContentSecurityPolicy(surface)}`,
      );
      for (const header of requiredResponseHeaders) expect(deploymentHeaders).toContain(header);
    }
  });

  test("permits only explicitly configured API transports and images", () => {
    const policy = createContentSecurityPolicy("stage", {
      connectSources: ["https://gateway.example.test", "wss://gateway.example.test"],
      imageSources: ["https://gateway.example.test"],
    });
    expect(policy).toContain(
      "connect-src 'self' https://gateway.example.test wss://gateway.example.test",
    );
    expect(policy).toContain("img-src 'self' data: https://gateway.example.test");
  });

  test("keeps the shipped policy script-src exact and confines the dev allowance to the dev server", () => {
    for (const surface of ["console", "stage"] as const) {
      const shipped = createContentSecurityPolicy(surface);
      const development = createDevelopmentContentSecurityPolicy(surface);

      expect(shipped).toContain("script-src 'self'");
      expect(shipped).not.toContain("unsafe-inline");
      expect(createDeploymentHeaders(surface)).not.toContain("unsafe-inline");
      expect(development).toContain("script-src 'self' 'unsafe-inline'");
      expect(development).toContain("style-src 'self' 'unsafe-inline'");

      const normalise = (policy: string) =>
        policy
          .split("; ")
          .map((directive) => directive.replace(" 'unsafe-inline'", ""))
          .join("; ");
      expect(normalise(development)).toBe(normalise(shipped));
    }
  });

  test("builds the production index meta from the shipped policy", () => {
    const meta = createContentSecurityPolicyMeta("console");
    expect(meta).toEqual({
      tag: "meta",
      attrs: {
        "http-equiv": "Content-Security-Policy",
        content:
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'",
      },
      injectTo: "head-prepend",
    });
    expect(String(meta.attrs?.content)).not.toContain("unsafe-inline");
  });
});
