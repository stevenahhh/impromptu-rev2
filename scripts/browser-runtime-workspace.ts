import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface BrowserRuntimeWorkspace {
  readonly artifactPath: string;
  readonly retainArtifacts: boolean;
  readonly runtimeRoot: string;
}

interface BrowserRuntimeWorkspaceOptions {
  readonly artifactRoot?: string;
  readonly retainArtifacts?: boolean;
  readonly temporaryRoot?: string;
}

export async function withBrowserRuntimeWorkspace<T>(
  run: (workspace: BrowserRuntimeWorkspace) => Promise<T>,
  options: BrowserRuntimeWorkspaceOptions = {},
): Promise<T> {
  const temporaryRoot = options.temporaryRoot ?? tmpdir();
  const retainArtifacts = options.retainArtifacts ?? false;
  const artifactRoot = retainArtifacts
    ? resolve(options.artifactRoot ?? "artifacts")
    : temporaryRoot;

  mkdirSync(temporaryRoot, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });

  const runtimeRoot = mkdtempSync(join(temporaryRoot, "impromptu-r2-browser-runtime-"));
  let artifactPath: string | undefined;

  try {
    artifactPath = mkdtempSync(join(artifactRoot, "browser-runtime-"));
    return await run({ artifactPath, retainArtifacts, runtimeRoot });
  } finally {
    if (!retainArtifacts && artifactPath !== undefined) {
      rmSync(artifactPath, { force: true, recursive: true });
    }
    rmSync(runtimeRoot, { force: true, recursive: true });
  }
}
