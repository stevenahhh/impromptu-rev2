import { describe, expect, test } from "bun:test";

import {
  consoleContentSecurityPolicy,
  consoleResponseSecurityHeaders,
  PERMISSIONS_POLICY,
  STRICT_TRANSPORT_SECURITY,
} from "./security-policy";

describe("Console response security policy", () => {
  test("uses a nonce without production inline or eval allowances", () => {
    const policy = consoleContentSecurityPolicy("nonce-value");

    expect(policy).toContain("script-src 'self' 'nonce-nonce-value' 'strict-dynamic'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("'unsafe-inline'");
    expect(policy).not.toContain("'unsafe-eval'");
  });

  test("limits unsafe-eval to development framework tooling", () => {
    expect(consoleContentSecurityPolicy("nonce-value", true)).toContain("'unsafe-eval'");
    expect(consoleContentSecurityPolicy("nonce-value", true)).not.toContain("'unsafe-inline'");
  });

  test("emits the complete production response header set", () => {
    expect(consoleResponseSecurityHeaders(true)).toEqual([
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
      { key: "Strict-Transport-Security", value: STRICT_TRANSPORT_SECURITY },
    ]);
    expect(consoleResponseSecurityHeaders(false).map(({ key }) => key)).not.toContain(
      "Strict-Transport-Security",
    );
  });
});
