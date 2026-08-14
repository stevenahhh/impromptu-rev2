import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import {
  type ArchitectureViolationCode,
  scanPackageEntrypoints,
  scanPackageManifest,
  scanProjectionArchitecture,
  scanSourceDirectory,
  scanSourceText,
} from "./support/architecture-scanner.ts";

const serviceRoot = resolve(import.meta.dir, "..");
const sourceRoot = resolve(serviceRoot, "src");
const fixtureRoot = resolve(import.meta.dir, "fixtures/architecture");
const sourceExtensionFixtureRoot = resolve(fixtureRoot, "source-extension-bypass");

function fixture(name: string): string {
  return readFileSync(resolve(fixtureRoot, `${name}.fixture`), "utf8");
}

function packageFixture(name: string): string {
  return readFileSync(resolve(fixtureRoot, `${name}.package.fixture`), "utf8");
}

function packageFixtureViolations(name: string) {
  return scanPackageManifest(`${name}.package.json`, packageFixture(name));
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

  test("normalizes canonical Bun patched dependency identities", () => {
    const violations = packageFixtureViolations("patched-private");

    expect(violations.map((violation) => [violation.code, violation.group])).toContainEqual([
      "FORBIDDEN_PRIVATE_DEPENDENCY",
      "patchedDependencies",
    ]);
  });

  test("rejects nested versioned override and resolution selectors", () => {
    for (const [fixtureName, group] of [
      ["overrides-private", "overrides"],
      ["resolutions-private", "resolutions"],
    ] as const) {
      const violations = packageFixtureViolations(fixtureName);

      expect(violations.map((violation) => [violation.code, violation.group])).toContainEqual([
        "FORBIDDEN_PRIVATE_DEPENDENCY",
        group,
      ]);
    }
  });

  test("accepts unrelated package controls", () => {
    expect(packageFixtureViolations("package-controls-safe")).toEqual([]);
  });

  test("scans every Bun and TypeScript executable source extension", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "projection-source-extensions-"));
    const extensions = [
      ".ts",
      ".tsx",
      ".mts",
      ".cts",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".d.ts",
      ".d.mts",
      ".d.cts",
    ] as const;

    try {
      const nestedDirectory = resolve(directory, "nested/loaders");
      mkdirSync(nestedDirectory, { recursive: true });
      for (const [index, extension] of extensions.entries()) {
        writeFileSync(
          resolve(
            index % 2 === 0 ? directory : nestedDirectory,
            `private-bridge-${index}${extension}`,
          ),
          `export { escaped } from "${index % 2 === 0 ? "../outside.js" : "../../../outside.js"}";\n`,
        );
      }

      const violations = scanSourceDirectory(directory, { sourceRoot: directory, aliases: [] });
      const rejectedFiles = new Set(
        violations
          .filter((violation) => violation.code === "BOUNDARY_ESCAPE")
          .map((violation) => basename(violation.file)),
      );

      for (const [index, extension] of extensions.entries()) {
        expect(rejectedFiles.has(`private-bridge-${index}${extension}`)).toBe(true);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("finds a runtime JavaScript bridge hidden by a declaration and re-export", async () => {
    const violations = scanSourceDirectory(sourceExtensionFixtureRoot, {
      sourceRoot: sourceExtensionFixtureRoot,
      aliases: [],
    });
    const entrypointViolations = scanPackageEntrypoints(
      resolve(sourceExtensionFixtureRoot, "package.json"),
      readFileSync(resolve(sourceExtensionFixtureRoot, "package.fixture"), "utf8"),
      sourceExtensionFixtureRoot,
    );
    const runtimeBridge = await import("./fixtures/architecture/source-extension-bypass/index.ts");

    expect(
      violations.some(
        (violation) =>
          violation.code === "BOUNDARY_ESCAPE" && violation.file.endsWith("private-bridge.js"),
      ),
    ).toBe(true);
    expect(entrypointViolations).toEqual([]);
    expect(runtimeBridge.loadPrivateConfig().port).toBe(4102);
  });

  test("rejects package entrypoints outside the source boundary", () => {
    const violations = scanPackageEntrypoints(
      resolve(serviceRoot, "package.json"),
      JSON.stringify({
        exports: {
          ".": {
            types: "./src/index.ts",
            import: "../private-backend/src/index.ts",
          },
        },
        main: "../private-backend/src/index.ts",
      }),
      sourceRoot,
    );

    expect(violations.map((violation) => violation.code)).toEqual([
      "PACKAGE_ENTRYPOINT_ESCAPE",
      "PACKAGE_ENTRYPOINT_ESCAPE",
    ]);
  });

  test("rejects symlinks before following source paths", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "projection-source-symlink-"));
    const source = resolve(directory, "src");
    const outside = resolve(directory, "outside");
    mkdirSync(source);
    mkdirSync(outside);
    writeFileSync(resolve(outside, "private-bridge.js"), "export const escaped = true;\n");

    try {
      symlinkSync(outside, resolve(source, "linked"), "junction");
      const violations = scanSourceDirectory(source, { sourceRoot: source, aliases: [] });

      expect(violations.map((violation) => violation.code)).toContain("SYMLINK_ESCAPE");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
