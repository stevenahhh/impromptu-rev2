import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withHarnessDeckWorkspace } from "./harness-deck-workspace.ts";

const fixtureRoots: string[] = [];
const originalTmpdir = process.env.TMPDIR;
const originalTemp = process.env.TEMP;

afterEach(() => {
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  if (originalTemp === undefined) delete process.env.TEMP;
  else process.env.TEMP = originalTemp;
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("E2E harness deck workspace", () => {
  test("uses TMPDIR and removes both deck roots when the harness fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-deck-workspace-test-"));
    fixtureRoots.push(root);
    const temporaryRoot = join(root, "os-temporary");
    process.env.TMPDIR = temporaryRoot;
    delete process.env.TEMP;
    let stagingRoot = "";
    let artifactRoot = "";

    await expect(
      withHarnessDeckWorkspace({ prefix: "prepared-evidence-test" }, async (workspace) => {
        stagingRoot = workspace.deckStagingRoot;
        artifactRoot = workspace.deckArtifactRoot;
        expect(workspace.temporaryRoot).toBe(temporaryRoot);
        writeFileSync(join(stagingRoot, "staged"), "fixture");
        writeFileSync(join(artifactRoot, "artifact"), "fixture");
        throw new Error("harness failed");
      }),
    ).rejects.toThrow("harness failed");

    expect(existsSync(stagingRoot)).toBe(false);
    expect(existsSync(artifactRoot)).toBe(false);
  });
});
