/**
 * Deck upload worker.
 *
 * Contract: test/deck-upload-worker.test.ts.
 *
 * Consumes the upload strictly as a stream: chunks are written to a staging
 * upload.part as they arrive (hashed and counted in the same pass), so the
 * whole body is never buffered. Filename, extension, empty, and declared-size
 * checks run before the first read; signature validation uses only a bounded
 * prefix. Actual/declaration mismatch, empty, and over-limit bodies reject
 * without invoking the renderer. After a successful renderer result the output
 * is copied through an artifactRoot-local "<artifactId>.part" directory, each
 * file is fsynced, and the directory is atomically renamed to the immutable
 * artifactRoot/<artifactId>. Symlinks and paths escaping the output tree are
 * rejected. Every terminal path (rejection, renderer failure, deadline,
 * promotion failure) removes staging and any artifact ".part" directory while
 * retaining a promoted artifact; an already-identical artifact is idempotent.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

export const MAX_DECK_UPLOAD_BYTES = 100 * 1024 * 1024;

const DEFAULT_RENDER_DEADLINE_MS = 60_000;

const ZIP_LOCAL_FILE_HEADER = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"
const PDF_HEADER = new TextEncoder().encode("%PDF-");

const SIGNATURES: ReadonlyArray<readonly [extension: string, signature: Uint8Array]> = [
  [".pptx", ZIP_LOCAL_FILE_HEADER],
  [".pdf", PDF_HEADER],
];

const MAX_SIGNATURE_PREFIX_BYTES = Math.max(
  ...SIGNATURES.map(([, signature]) => signature.byteLength),
);

export type DeckUploadRejectionCode =
  | "empty_input"
  | "unsupported_extension"
  | "malformed_input"
  | "input_too_large"
  | "unsafe_filename"
  | "size_mismatch";

export interface DeckUploadInput {
  readonly fileName: string;
  /** Optional for multipart file parts, which do not carry their own Content-Length. */
  readonly byteLength?: number;
  readonly content: ReadableStream<Uint8Array>;
}

export type DeckUploadOutcome =
  | { readonly outcome: "RENDERED"; readonly artifactId: string; readonly manifest: unknown }
  | {
      readonly outcome: "REJECTED";
      readonly code: DeckUploadRejectionCode;
      readonly message: string;
    };

export interface RenderSubprocessRequest {
  readonly sourcePath: string; // staged upload file the renderer reads
  readonly outputDir: string; // renderer writes its output here
}

export type RenderSubprocessResult =
  | { readonly ok: true; readonly renderManifest: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface RenderSubprocessAdapter {
  run(request: RenderSubprocessRequest, signal: AbortSignal): Promise<RenderSubprocessResult>;
}

export interface DeckUploadWorkerOptions {
  readonly subprocess: RenderSubprocessAdapter;
  readonly stagingRoot: string; // worker owns every file it creates under this directory
  readonly artifactRoot: string; // promoted artifacts live at artifactRoot/<artifactId>
  readonly deadlineMs?: number; // default 60_000; aborting the adapter signal enforces it
}

export class DeckUploadWorkerError extends Error {
  constructor(
    readonly code:
      | "render_failed"
      | "deadline_exceeded"
      | "artifact_collision"
      | "artifact_path_rejected",
    message: string,
  ) {
    super(message);
    this.name = "DeckUploadWorkerError";
  }
}

export interface DeckUploadWorker {
  processUpload(input: DeckUploadInput): Promise<DeckUploadOutcome>;
}

interface Rejection {
  readonly code: DeckUploadRejectionCode;
  readonly message: string;
}

function rejection(code: DeckUploadRejectionCode, message: string): Rejection {
  return { code, message };
}

function hasPrefix(content: Uint8Array, prefix: Uint8Array): boolean {
  if (content.byteLength < prefix.byteLength) return false;
  for (let i = 0; i < prefix.byteLength; i++) {
    if (content[i] !== prefix[i]) return false;
  }
  return true;
}

function isUnsafeFileName(fileName: string): boolean {
  return (
    fileName.length === 0 ||
    fileName === "." ||
    fileName === ".." ||
    fileName.includes("/") ||
    fileName.includes("\\")
  );
}

/** Checks that need no body bytes: declaration and file name only. */
function validateDeclaration(input: DeckUploadInput): Rejection | null {
  const { fileName, byteLength } = input;

  if (byteLength === 0) {
    return rejection("empty_input", "Upload is empty");
  }
  if (byteLength !== undefined && byteLength > MAX_DECK_UPLOAD_BYTES) {
    return rejection("input_too_large", `Upload exceeds the ${MAX_DECK_UPLOAD_BYTES}-byte limit`);
  }
  if (isUnsafeFileName(fileName)) {
    return rejection("unsafe_filename", `Unsafe file name: ${JSON.stringify(fileName)}`);
  }

  const lowerName = fileName.toLowerCase();
  if (!SIGNATURES.some(([extension]) => lowerName.endsWith(extension))) {
    return rejection(
      "unsupported_extension",
      `Unsupported file extension: ${JSON.stringify(fileName)}`,
    );
  }
  return null;
}

/** Signature check against the bounded prefix captured while streaming. */
function validateSignature(fileName: string, prefix: Uint8Array): Rejection | null {
  const lowerName = fileName.toLowerCase();
  for (const [extension, signature] of SIGNATURES) {
    if (lowerName.endsWith(extension)) {
      if (!hasPrefix(prefix, signature)) {
        return rejection("malformed_input", `Content does not match the ${extension} signature`);
      }
      return null;
    }
  }
  return rejection(
    "unsupported_extension",
    `Unsupported file extension: ${JSON.stringify(fileName)}`,
  );
}

/**
 * Stream the body to `fd` while hashing and counting it. Only the bounded
 * signature prefix is retained in memory; every chunk is written to disk as it
 * arrives. Returns a rejection when the body is malformed, exceeds the cap, or
 * disagrees with the declared byteLength.
 */
async function streamUploadToFile(input: DeckUploadInput, fd: number): Promise<Rejection | null> {
  const { fileName, byteLength: declared, content } = input;

  const reader = content.getReader();
  const hash = createHash("sha256"); // content hash computed while streaming
  const prefix = new Uint8Array(MAX_SIGNATURE_PREFIX_BYTES);
  let prefixBytes = 0;
  let counted = 0;
  let signatureChecked = false;

  const cancelSource = async (): Promise<void> => {
    try {
      await reader.cancel();
    } catch {
      // The source already failed or refuses cancellation; the upload is rejected regardless.
    }
  };

  try {
    while (true) {
      let chunk: Uint8Array;
      try {
        const read = await reader.read();
        if (read.done) break;
        chunk = read.value;
      } catch (error) {
        await cancelSource();
        return rejection(
          "malformed_input",
          `Upload body could not be read: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (chunk.byteLength === 0) continue;

      // Capture the bounded prefix before the chunk that completes it hits disk,
      // so a bad signature is rejected without writing body bytes.
      const take = Math.min(MAX_SIGNATURE_PREFIX_BYTES - prefixBytes, chunk.byteLength);
      prefix.set(chunk.subarray(0, take), prefixBytes);
      prefixBytes += take;
      if (!signatureChecked && prefixBytes >= MAX_SIGNATURE_PREFIX_BYTES) {
        signatureChecked = true;
        const signatureRejection = validateSignature(fileName, prefix);
        if (signatureRejection !== null) {
          await cancelSource();
          return signatureRejection;
        }
      }

      counted += chunk.byteLength;
      if (counted > MAX_DECK_UPLOAD_BYTES) {
        await cancelSource();
        return rejection(
          "input_too_large",
          `Upload exceeds the ${MAX_DECK_UPLOAD_BYTES}-byte limit`,
        );
      }

      writeSync(fd, chunk);
      hash.update(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  if (declared !== undefined && counted !== declared) {
    return rejection(
      "size_mismatch",
      `Upload declared ${declared} bytes but the body contained ${counted}`,
    );
  }
  if (counted === 0) {
    return rejection("empty_input", "Upload is empty");
  }
  // A body shorter than the signature never completed the prefix; validate the
  // short prefix directly so it rejects as malformed rather than passing.
  if (!signatureChecked) {
    return validateSignature(fileName, prefix.subarray(0, prefixBytes));
  }
  return null;
}

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

function stableArtifactId(manifest: unknown): string {
  // Canonical JSON of the closed manifest: identical renders coalesce onto the
  // same immutable artifact id; any change re-derives a different id.
  return createHash("sha256")
    .update(`deck-artifact:${JSON.stringify(manifest)}`, "utf8")
    .digest("hex");
}

/** Directory fsync is best-effort: some platforms refuse it. */
function fsyncDirectory(dirPath: string): void {
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
function copyOutputTree(sourceDir: string, destDir: string): void {
  const entries = readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const relPath = relative(sourceDir, join(sourceDir, entry.name));
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

function treesIdentical(left: string, right: string): boolean {
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
            "render_failed",
            `Renderer failed (${result.code}): ${result.message}`,
          );
        }

        const artifactId = stableArtifactId(result.renderManifest);
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
