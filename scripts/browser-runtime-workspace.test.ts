import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withBrowserRuntimeWorkspace } from "./browser-runtime-workspace.ts";

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "browser-runtime-workspace-test-"));
  fixtureRoots.push(root);
  return root;
}

describe("browser runtime workspace", () => {
  test("removes temporary runtime and screenshot evidence when verification fails", async () => {
    const root = fixtureRoot();
    const temporaryRoot = join(root, "temporary");
    let artifactPath = "";
    let runtimeRoot = "";

    await expect(
      withBrowserRuntimeWorkspace(
        async (workspace) => {
          artifactPath = workspace.artifactPath;
          runtimeRoot = workspace.runtimeRoot;
          writeFileSync(join(artifactPath, "evidence.png"), "screenshot");
          writeFileSync(join(runtimeRoot, "profile"), "runtime state");
          throw new Error("verification failed");
        },
        { temporaryRoot },
      ),
    ).rejects.toThrow("verification failed");

    expect(artifactPath.startsWith(temporaryRoot)).toBe(true);
    expect(existsSync(artifactPath)).toBe(false);
    expect(existsSync(runtimeRoot)).toBe(false);
  });

  test("retains explicitly requested evidence only under the artifact root", async () => {
    const root = fixtureRoot();
    const temporaryRoot = join(root, "temporary");
    const artifactRoot = join(root, "artifacts");

    const workspace = await withBrowserRuntimeWorkspace(
      async (current) => {
        writeFileSync(join(current.artifactPath, "evidence.png"), "screenshot");
        return current;
      },
      { artifactRoot, retainArtifacts: true, temporaryRoot },
    );

    expect(workspace.artifactPath.startsWith(artifactRoot)).toBe(true);
    expect(existsSync(join(workspace.artifactPath, "evidence.png"))).toBe(true);
    expect(existsSync(workspace.runtimeRoot)).toBe(false);
  });
});
