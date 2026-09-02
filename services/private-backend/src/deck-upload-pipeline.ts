/**
 * Deck upload orchestration: stages the streamed upload, runs the renderer
 * subprocess under a deadline, and promotes the output to an immutable
 * artifact.
 *
 * Every terminal path (rejection, renderer failure, deadline, promotion
 * failure) removes staging and any artifact ".part" directory while retaining
 * a promoted artifact; an already-identical artifact is idempotent.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import {
  copyOutputTree,
  fsyncDirectory,
  stableArtifactId,
  treesIdentical,
} from "./deck-artifact-promotion.ts";
import {
  type DeckUploadInput,
  type DeckUploadOutcome,
  type DeckUploadWorker,
  DeckUploadWorkerError,
  type DeckUploadWorkerOptions,
  type RenderSubprocessAdapter,
  type RenderSubprocessRequest,
  type RenderSubprocessResult,
} from "./deck-upload-contract.ts";
import { SIGNATURES, streamUploadToFile, validateDeclaration } from "./deck-upload-staging.ts";

/**
 * Covers rasterizing every page AND the structural ingest that follows it. A scanned deck has
 * no text layer, so each of its pages goes through local OCR, which is CPU-bound and competes
 * with everything else on the machine: a twenty-page scanned deck that ingests in about eleven
 * seconds on an idle host took past sixty on a busy one and the upload was rejected outright.
 * The ceiling still exists to stop a pathological deck running forever; it is now sized for the
 * slowest input the product accepts rather than for a deck that carries its own text.
 */
const DEFAULT_RENDER_DEADLINE_MS = 240_000;

async function runWithDeadline(
  subprocess: RenderSubprocessAdapter,
  request: RenderSubprocessRequest,
  deadlineMs: number,
): Promise<RenderSubprocessResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);

  try {
    return await Promise.race([
      subprocess.run(request, controller.signal),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () =>
            reject(
              new DeckUploadWorkerError(
                "deadline_exceeded",
                `Render deadline of ${deadlineMs}ms exceeded`,
              ),
            ),
          { once: true },
        );
      }),
    ]);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new DeckUploadWorkerError(
        "deadline_exceeded",
        `Render deadline of ${deadlineMs}ms exceeded`,
      );
    }
    throw new DeckUploadWorkerError(
      "render_failed",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    clearTimeout(timer);
  }
}

export function createDeckUploadWorker(options: DeckUploadWorkerOptions): DeckUploadWorker {
  const { subprocess, stagingRoot, artifactRoot } = options;
  const deadlineMs = options.deadlineMs ?? DEFAULT_RENDER_DEADLINE_MS;

  return {
    async processUpload(input: DeckUploadInput): Promise<DeckUploadOutcome> {
      const declaredRejection = validateDeclaration(input);
      if (declaredRejection !== null) {
        return { outcome: "REJECTED", ...declaredRejection };
      }

      // Preserve only the validated format suffix for renderer dispatch. The staged basename
      // remains server-generated; no user-controlled filename segment reaches the filesystem.
      const sourceExtension = SIGNATURES.find(([extension]) =>
        input.fileName.toLowerCase().endsWith(extension),
      )?.[0];
      if (sourceExtension === undefined) throw new Error("validated deck extension missing");
      const stagingDir = mkdtempSync(join(stagingRoot, "staging-"));
      let partFd: number | null = null;
      let artifactPartDir: string | null = null;
      try {
        const sourcePath = join(stagingDir, `upload${sourceExtension}`);
        const partPath = join(stagingDir, "upload.part");
        partFd = openSync(partPath, "wx");

        const streamRejection = await streamUploadToFile(input, partFd);
        if (streamRejection !== null) {
          return { outcome: "REJECTED", ...streamRejection };
        }

        fsyncSync(partFd);
        closeSync(partFd);
        partFd = null;
        renameSync(partPath, sourcePath); // atomic promotion: no partial file is ever visible at sourcePath
        fsyncDirectory(stagingDir);

        const outputDir = join(stagingDir, "output");
        const result = await runWithDeadline(subprocess, { sourcePath, outputDir }, deadlineMs);

        if (!result.ok) {
          throw new DeckUploadWorkerError(
            result.code === "ocr_unavailable" ? "ocr_unavailable" : "render_failed",
            `Renderer failed (${result.code}): ${result.message}`,
          );
        }

        const artifactId = stableArtifactId(result.renderManifest, result.ingestionManifest);
        const finalDir = join(artifactRoot, artifactId);

        // Stage the renderer output in an artifactRoot-local .part directory so
        // promotion is a single atomic rename and the artifact never appears half-written.
        const partDir = join(artifactRoot, `${artifactId}.part`);
        artifactPartDir = partDir; // tracked for the finally cleanup
        rmSync(partDir, { recursive: true, force: true }); // clear a stale crash remnant
        mkdirSync(partDir, { recursive: true });
        try {
          copyOutputTree(outputDir, partDir);
        } catch (error) {
          if (error instanceof DeckUploadWorkerError) throw error;
          throw new DeckUploadWorkerError(
            "artifact_path_rejected",
            `renderer output could not be staged: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        fsyncDirectory(partDir);

        if (existsSync(finalDir)) {
          if (!treesIdentical(finalDir, partDir)) {
            throw new DeckUploadWorkerError(
              "artifact_collision",
              `artifact ${artifactId} already exists with different content`,
            );
          }
          rmSync(partDir, { recursive: true, force: true });
          artifactPartDir = null;
          return { outcome: "RENDERED", artifactId, manifest: result.renderManifest };
        }

        try {
          renameSync(partDir, finalDir); // atomic promotion to an immutable artifact
          artifactPartDir = null;
        } catch (error) {
          // A concurrent identical upload may have won the rename; that is still success.
          if (existsSync(finalDir) && treesIdentical(finalDir, partDir)) {
            rmSync(partDir, { recursive: true, force: true });
            artifactPartDir = null;
          } else {
            throw new DeckUploadWorkerError(
              "artifact_collision",
              `artifact ${artifactId} could not be promoted: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        fsyncDirectory(artifactRoot);

        return { outcome: "RENDERED", artifactId, manifest: result.renderManifest };
      } finally {
        if (partFd !== null) {
          try {
            closeSync(partFd);
          } catch {
            // The file descriptor is gone with the staging directory anyway.
          }
        }
        rmSync(stagingDir, { recursive: true, force: true });
        if (artifactPartDir !== null) {
          rmSync(artifactPartDir, { recursive: true, force: true });
        }
      }
    },
  };
}
