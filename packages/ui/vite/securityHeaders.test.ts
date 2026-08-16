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
  "base-uri 'none'",
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

  test("emits the same CSP as a deployment response-header artifact", () => {
    for (const surface of ["console", "stage"] as const) {
      const policy = createContentSecurityPolicy(surface);
      expect(createDeploymentHeaders(surface)).toBe(`/*\n  Content-Security-Policy: ${policy}\n`);
    }
  });

  test("keeps the shipped policy script-src exact and confines the dev allowance to the dev server", () => {
    for (const surface of ["console", "stage"] as const) {
      const shipped = createContentSecurityPolicy(surface);
      const development = createDevelopmentContentSecurityPolicy(surface);

      // The shipped artifact must never gain an inline-script allowance.
      expect(shipped).toContain("script-src 'self'");
      expect(shipped).not.toContain("unsafe-inline");
      expect(createDeploymentHeaders(surface)).not.toContain("unsafe-inline");

      // Vite's dev HMR preamble is an inline script, so the dev server alone relaxes script-src.
      expect(development).toContain("script-src 'self' 'unsafe-inline'");
      expect(development).toContain("style-src 'self' 'unsafe-inline'");

      // Nothing else may differ between the two policies.
      const normalise = (policy: string) =>
        policy
          .split("; ")
          .map((directive) => directive.replace(" 'unsafe-inline'", ""))
          .join("; ");
      expect(normalise(development)).toBe(normalise(shipped));
    }
  });

  test("builds the production index meta from the shipped policy", () => {
    const shipped =
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'";
    expect(createContentSecurityPolicyMeta("console")).toEqual({
      tag: "meta",
      attrs: {
        "http-equiv": "Content-Security-Policy",
        content: shipped,
      },
      injectTo: "head-prepend",
    });
    expect(shipped).not.toContain("unsafe-inline");
  });
});
