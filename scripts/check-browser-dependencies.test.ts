import { describe, expect, test } from "bun:test";
import {
  findForbiddenDependencyViolations,
  loadBrowserDependencyManifest,
  scanBrowserDependencies,
} from "./check-browser-dependencies.ts";

describe("browser forbidden dependency checker", () => {
  test("accepts a non-empty browser fixture with a provider-blocking CSP", () => {
    const manifest = loadBrowserDependencyManifest();

    expect(scanBrowserDependencies(manifest, ["scripts/fixtures/browser-boundary-clean"])).toEqual(
      [],
    );
  });

  test("fails closed when configured frontend roots are missing", () => {
    const manifest = loadBrowserDependencyManifest();
    const violations = scanBrowserDependencies(manifest, [
      "scripts/fixtures/does-not-exist",
    ]);

    expect(violations).toEqual([
      {
        file: "scripts/fixtures/does-not-exist",
        kind: "missing-root",
        specifier: "scripts/fixtures/does-not-exist",
        rule: "browser root must exist",
      },
    ]);
  });

  test("fails closed when a browser root has no scannable files", () => {
    const manifest = loadBrowserDependencyManifest();

    expect(scanBrowserDependencies(manifest, ["scripts/fixtures/browser-boundary-empty"])).toEqual([
      {
        file: "scripts/fixtures/browser-boundary-empty",
        kind: "empty-root",
        specifier: "scripts/fixtures/browser-boundary-empty",
        rule: "browser root must contain scannable files",
      },
    ]);
  });

  test("scans manifests, imports, bundles, source maps, artifacts, signatures, and CSP", () => {
    const manifest = loadBrowserDependencyManifest();
    const violations = scanBrowserDependencies(manifest, [
      "scripts/fixtures/browser-boundary-negative",
    ]);

    expect(violations.map(({ kind }) => kind).sort()).toEqual([
      "forbidden-artifact",
      "forbidden-content-signature",
      "forbidden-content-signature",
      "forbidden-content-signature",
      "forbidden-csp-origin",
      "forbidden-import",
      "forbidden-manifest-dependency",
    ]);
    expect(violations.map(({ file }) => file)).toContain(
      "scripts/fixtures/browser-boundary-negative/app.js.map",
    );
  });

  test("matches only exact packages or package subpaths", () => {
    const manifest = loadBrowserDependencyManifest();

    expect(
      findForbiddenDependencyViolations(manifest, "virtual.ts", [
        "openai",
        "openai/helpers/zod",
        "openai-compatible-client",
      ]).map(({ specifier }) => specifier),
    ).toEqual(["openai", "openai/helpers/zod"]);
  });
});
