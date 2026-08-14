import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const forbiddenPublicExports = [
  "PrivateDeckContextSchema",
  "EvidenceCandidateSchema",
  "CausalEnvelopeSchema",
  "PublicationAuthoritySchema",
  "PlaybackControlLeaseSchema",
] as const;

describe("role-scoped contract exports", () => {
  test("publishes explicit public, control, private, retrieval, and shared subpaths", () => {
    const manifest = JSON.parse(readFileSync("packages/contracts/package.json", "utf8")) as {
      exports?: unknown;
    };
    expect(manifest.exports).toEqual({
      ".": "./src/public.ts",
      "./public": "./src/public.ts",
      "./control": "./src/control.ts",
      "./private": "./src/private.ts",
      "./retrieval": "./src/retrieval.ts",
      "./shared": "./src/shared.ts",
    });
  });

  test("keeps private and control contracts out of the root public barrel", async () => {
    const publicContracts: Record<string, unknown> = await import("@impromptu/contracts");
    for (const exportName of forbiddenPublicExports) {
      expect(exportName in publicContracts).toBe(false);
    }
    expect("PublishedDeckArtifactSchema" in publicContracts).toBe(true);
    expect("AudienceSnapshotSchema" in publicContracts).toBe(true);
  });

  test("blocks unexported implementation subpaths from TypeScript consumers", () => {
    const resolution = ts.resolveModuleName(
      "@impromptu/contracts/src/private-evidence.ts",
      "tests/contract/stage-consumer.ts",
      {
        module: ts.ModuleKind.Preserve,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        resolvePackageJsonExports: true,
      },
      ts.sys,
    );
    expect(resolution.resolvedModule).toBeUndefined();
  });
});
