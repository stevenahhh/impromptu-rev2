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

  test("limits framework tooling allowances to development", () => {
    const development = consoleContentSecurityPolicy("nonce-value", true);
    const production = consoleContentSecurityPolicy("nonce-value", false);
    const styleSrc = (policy: string): string =>
      policy.split("; ").find((directive) => directive.startsWith("style-src ")) ?? "";

    expect(development).toContain("'unsafe-eval'");
    expect(production).not.toContain("'unsafe-eval'");

    // Production gates inline styles on the nonce Next stamps onto the style and link tags it
    // renders. It must never carry a blanket inline allowance.
    expect(styleSrc(production)).toBe("style-src 'self' 'nonce-nonce-value'");

    // The dev server injects overlay and Fast Refresh styles it cannot nonce. The allowance and
    // the nonce are mutually exclusive: a directive carrying a nonce makes browsers ignore
    // 'unsafe-inline', so the development policy must not carry both.
    expect(styleSrc(development)).toBe("style-src 'self' 'unsafe-inline'");
    expect(styleSrc(development)).not.toContain("nonce-");

    // Scripts never take a blanket inline allowance, in either environment.
    expect(development.split("; ")).toContain(
      "script-src 'self' 'nonce-nonce-value' 'strict-dynamic' 'unsafe-eval'",
    );
    expect(production.split("; ")).toContain(
      "script-src 'self' 'nonce-nonce-value' 'strict-dynamic'",
    );
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
