/**
 * Renderer-output promotion: content-addressed artifact identity, durability
 * helpers, safe tree copying, and atomicity support for promoting a rendered
 * output tree to the immutable artifactRoot/<artifactId>.
 *
 * Symlinks and paths escaping the output tree are rejected; every copied file
 * is fsynced before the directory is renamed into place.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import { DeckUploadWorkerError } from "./deck-upload-contract.ts";

export function stableArtifactId(renderManifest: unknown, ingestionManifest: unknown): string {
  // Both validated manifests define the immutable artifact identity. This prevents a
  // render from coalescing with a structurally different extraction.
  return createHash("sha256")
    .update(
      `deck-artifact:${JSON.stringify(renderManifest)}:${JSON.stringify(ingestionManifest)}`,
      "utf8",
    )
    .digest("hex");
}

/** Directory fsync is best-effort: some platforms refuse it. */
export function fsyncDirectory(dirPath: string): void {
  try {
    const fd = openSync(dirPath, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Durability of the directory entry cannot be forced everywhere; files
    // themselves are fsynced before promotion.
  }
}

function rejectUnsafeRelativePath(relPath: string): void {
  if (
    relPath === "" ||
    relPath.startsWith(`..${sep}`) ||
    relPath === ".." ||
    relPath.includes(`${sep}..${sep}`) ||
    relPath.endsWith(`${sep}..`) ||
    relPath.startsWith(sep) ||
    relPath.includes(`:${sep}`) // drive-absolute on Windows-style renderer output
  ) {
    throw new DeckUploadWorkerError(
      "artifact_path_rejected",
      `renderer output escapes the artifact tree: ${relPath}`,
    );
  }
}

/** Copy one renderer output tree into the artifact staging directory. */
export function copyOutputTree(sourceDir: string, destDir: string): void {
  const entries = readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const relPath = entry.name;
    rejectUnsafeRelativePath(relPath);
    const sourcePath = join(sourceDir, entry.name);
    const destPath = join(destDir, relPath);

    if (entry.isSymbolicLink()) {
      throw new DeckUploadWorkerError(
        "artifact_path_rejected",
        `renderer output contains a symlink: ${relPath}`,
      );
    }
    if (entry.isDirectory()) {
      mkdirSync(destPath, { recursive: false });
      copyOutputTree(sourcePath, destPath);
      continue;
    }
    if (entry.isFile()) {
      copyFileSync(sourcePath, destPath);
      const fd = openSync(destPath, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      continue;
    }
    throw new DeckUploadWorkerError(
      "artifact_path_rejected",
      `renderer output contains an unsupported entry: ${relPath}`,
    );
  }
}

export function treesIdentical(left: string, right: string): boolean {
  const leftEntries = new Map(
    readdirSync(left, { withFileTypes: true }).map((entry) => [entry.name, entry]),
  );
  const rightEntries = new Map(
    readdirSync(right, { withFileTypes: true }).map((entry) => [entry.name, entry]),
  );
  const leftNames = [...leftEntries.keys()].sort();
  const rightNames = [...rightEntries.keys()].sort();
  if (leftNames.length !== rightNames.length) return false;
  for (const name of leftNames) {
    if (!rightEntries.has(name)) return false;
    const leftEntry = leftEntries.get(name);
    const rightEntry = rightEntries.get(name);
    if (leftEntry === undefined || rightEntry === undefined) return false;
    if (leftEntry.isDirectory() !== rightEntry.isDirectory()) return false;
    if (leftEntry.isSymbolicLink() || rightEntry.isSymbolicLink()) return false;
    if (leftEntry.isDirectory()) {
      if (!treesIdentical(join(left, name), join(right, name))) return false;
    } else if (leftEntry.isFile()) {
      const leftStats = lstatSync(join(left, name));
      const rightStats = lstatSync(join(right, name));
      if (leftStats.size !== rightStats.size) return false;
      if (!leftStats.size) continue; // both are empty files
      const leftBytes = readFileSync(join(left, name));
      const rightBytes = readFileSync(join(right, name));
      if (!leftBytes.equals(rightBytes)) return false;
    } else {
      return false;
    }
  }
  return true;
}
