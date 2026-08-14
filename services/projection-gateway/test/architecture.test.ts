import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type ArchitectureViolationCode,
  scanPackageManifest,
  scanProjectionArchitecture,
  scanSourceText,
} from "./support/architecture-scanner.ts";

const serviceRoot = resolve(import.meta.dir, "..");
const sourceRoot = resolve(serviceRoot, "src");
const fixtureRoot = resolve(import.meta.dir, "fixtures/architecture");

function fixture(name: string): string {
  return readFileSync(resolve(fixtureRoot, `${name}.fixture`), "utf8");
}

function violationCodes(name: string): readonly ArchitectureViolationCode[] {
  return scanSourceText(resolve(sourceRoot, `${name}.ts`), fixture(name), {
    sourceRoot,
    aliases: [],
  }).map((violation) => violation.code);
}

describe("projection gateway architecture", () => {
  test("production sources and manifests stay inside the public service boundary", () => {
    expect(scanProjectionArchitecture(serviceRoot)).toEqual([]);
  });

  test("publishes one root entrypoint and no private subpath", () => {
    const manifest = JSON.parse(readFileSync(resolve(serviceRoot, "package.json"), "utf8")) as {
      exports?: unknown;
    };

    expect(manifest.exports).toEqual({ ".": "./src/index.ts" });
  });

  test("fails closed on non-literal dynamic imports", () => {
    expect(violationCodes("non-literal-dynamic-import")).toContain("NON_LITERAL_DYNAMIC_IMPORT");
  });

  test("fails closed on type-asserted dynamic imports", () => {
    expect(violationCodes("type-asserted-dynamic-import")).toContain("NON_LITERAL_DYNAMIC_IMPORT");
  });

  test("rejects CommonJS require", () => {
    expect(violationCodes("commonjs-require")).toContain("COMMONJS_REQUIRE");
  });

  test("rejects TypeScript import-equals", () => {
    expect(violationCodes("typescript-import-equals")).toContain("IMPORT_EQUALS");
  });

  test("rejects relative path escapes", () => {
    expect(violationCodes("path-escape")).toContain("BOUNDARY_ESCAPE");
  });

  test("resolves configured aliases before checking the boundary", () => {
    const violations = scanSourceText(
      resolve(sourceRoot, "alias-escape.ts"),
      fixture("alias-escape"),
      {
        sourceRoot,
        aliases: [
          {
            pattern: "@private/*",
            targets: [resolve(sourceRoot, "../../private-backend/src/*")],
          },
        ],
      },
    );

    expect(violations.map((violation) => violation.code)).toContain("ALIAS_ESCAPE");
  });

  test("rejects private backend references in every dependency group", () => {
    const objectGroups = [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
      "trustedDependencies",
    ] as const;
    const arrayGroups = ["bundleDependencies", "bundledDependencies"] as const;

    for (const group of objectGroups) {
      const violations = scanPackageManifest(
        "package.json",
        JSON.stringify({ [group]: { "@impromptu/private-backend": "workspace:*" } }),
      );

      expect(violations.map((violation) => [violation.code, violation.group])).toContainEqual([
        "FORBIDDEN_PRIVATE_DEPENDENCY",
        group,
      ]);
    }

    for (const group of arrayGroups) {
      const violations = scanPackageManifest(
        "package.json",
        JSON.stringify({ [group]: ["@impromptu/private-backend"] }),
      );

      expect(violations.map((violation) => [violation.code, violation.group])).toContainEqual([
        "FORBIDDEN_PRIVATE_DEPENDENCY",
        group,
      ]);
    }
  });

  test("rejects aliased private backend dependency values", () => {
    const violations = scanPackageManifest(
      "package.json",
      JSON.stringify({
        dependencies: { "public-looking-name": "npm:@impromptu/private-backend@0.0.0" },
      }),
    );

    expect(violations.map((violation) => violation.code)).toContain("FORBIDDEN_PRIVATE_DEPENDENCY");
  });
});
