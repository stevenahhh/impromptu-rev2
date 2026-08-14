import { describe, expect, test } from "bun:test";
import {
  findForbiddenDependencyViolations,
  loadBrowserDependencyManifest,
  scanBrowserDependencies,
} from "./check-browser-dependencies.ts";

describe("browser forbidden dependency checker", () => {
  test("accepts the configured browser roots when no forbidden import exists", () => {
    const manifest = loadBrowserDependencyManifest();

    expect(scanBrowserDependencies(manifest)).toEqual([]);
  });

  test("rejects the checked-in negative fixture", () => {
    const manifest = loadBrowserDependencyManifest();
    const violations = scanBrowserDependencies(manifest, [
      "scripts/fixtures/browser-forbidden-import.ts.fixture",
    ]);

    expect(violations).toEqual([
      {
        file: "scripts/fixtures/browser-forbidden-import.ts.fixture",
        kind: "forbidden-import",
        specifier: "@impromptu/model-router",
        rule: "@impromptu/model-router",
      },
    ]);
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
