import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface HarnessDeckWorkspace {
  readonly temporaryRoot: string;
  readonly deckStagingRoot: string;
  readonly deckArtifactRoot: string;
}

interface HarnessDeckWorkspaceOptions {
  readonly prefix: string;
  readonly suffix?: string;
}

export async function withHarnessDeckWorkspace<T>(
  options: HarnessDeckWorkspaceOptions,
  run: (workspace: HarnessDeckWorkspace) => Promise<T>,
): Promise<T> {
  const temporaryRoot = tmpdir();
  const suffix = options.suffix ?? "";
  const deckStagingRoot = join(temporaryRoot, `${options.prefix}-deck-staging${suffix}`);
  const deckArtifactRoot = join(temporaryRoot, `${options.prefix}-deck-artifacts${suffix}`);
  mkdirSync(deckStagingRoot, { recursive: true });
  mkdirSync(deckArtifactRoot, { recursive: true });

  try {
    return await run({ temporaryRoot, deckStagingRoot, deckArtifactRoot });
  } finally {
    rmSync(deckStagingRoot, { force: true, recursive: true });
    rmSync(deckArtifactRoot, { force: true, recursive: true });
  }
}
