import { describe, expect, test } from "bun:test";

import { createContentSecurityPolicy, createDeploymentHeaders } from "./securityHeaders";

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
});
