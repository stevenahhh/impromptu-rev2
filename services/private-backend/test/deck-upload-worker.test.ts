/**
 * Failing-first contract for the deck upload worker.
 *
 * Intended module: services/private-backend/src/deck-upload-worker.ts.
 *
 * Contract (this file is the spec):
 *
 *   export const MAX_DECK_UPLOAD_BYTES = 100 * 1024 * 1024;
 *
 *   export type DeckUploadRejectionCode =
 *     | "empty_input" | "unsupported_extension" | "malformed_input"
 *     | "input_too_large" | "unsafe_filename" | "size_mismatch";
 *
 *   export interface DeckUploadInput {
 *     readonly fileName: string;
 *     readonly byteLength: number; // declared by the client; verified against the stream
 *     readonly content: ReadableStream<Uint8Array>;
 *   }
 *
 *   export type DeckUploadOutcome =
 *     | { readonly outcome: "RENDERED"; readonly artifactId: string; readonly manifest: unknown }
 *     | { readonly outcome: "REJECTED"; readonly code: DeckUploadRejectionCode; readonly message: string };
 *
 *   export interface RenderSubprocessRequest {
 *     readonly sourcePath: string; // staged upload file the renderer reads
 *     readonly outputDir: string;  // renderer writes its output here
 *   }
 *   export type RenderSubprocessResult =
 *     | { readonly ok: true; readonly renderManifest: unknown; readonly ingestionManifest: unknown }
 *     | { readonly ok: false; readonly code: string; readonly message: string };
 *
 *   export interface RenderSubprocessAdapter {
 *     run(request: RenderSubprocessRequest, signal: AbortSignal): Promise<RenderSubprocessResult>;
 *   }
 *
 *   export interface DeckUploadWorkerOptions {
 *     readonly subprocess: RenderSubprocessAdapter;
 *     readonly stagingRoot: string;  // worker owns every file it creates under this directory
 *     readonly artifactRoot: string; // promoted artifacts live at artifactRoot/<artifactId>
 *     readonly deadlineMs?: number;  // default 60_000; aborting the adapter signal enforces it
 *   }
 *
 *   export class DeckUploadWorkerError extends Error {
 *     readonly code: "render_failed" | "deadline_exceeded" | "artifact_collision" | "artifact_path_rejected";
 *   }
 *
 *   export interface DeckUploadWorker {
 *     processUpload(input: DeckUploadInput): Promise<DeckUploadOutcome>;
 *   }
 *   export function createDeckUploadWorker(options: DeckUploadWorkerOptions): DeckUploadWorker;
 *
 * The body is consumed strictly as a stream: chunks are written to a staging upload.part as they
 * arrive (hashing and counting as they go), so the worker never buffers the whole body and never
 * calls arrayBuffer() on it. Filename/extension/declared-size checks run before the first read.
 * Signature validation uses only a bounded prefix. Actual/declaration mismatch, empty bodies, and
 * over-limit bodies reject without invoking the renderer. On renderer success the output is copied
 * through an artifactRoot-local "<artifactId>.part" directory, fsynced, and atomically renamed to
 * the immutable artifactRoot/<artifactId>. Symlinks and paths escaping the output tree are
 * rejected. Every terminal path (rejection, renderer failure, deadline, promotion failure) leaves
 * neither staging nor artifact ".part" residue, while a promoted artifact directory is retained.
 * Re-uploading identical content is idempotent: the same artifact id is returned and the existing
 * artifact is kept.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDeckUploadWorker,
  type DeckUploadInput,
  type DeckUploadOutcome,
  type DeckUploadRejectionCode,
  type DeckUploadWorker,
  DeckUploadWorkerError,
  MAX_DECK_UPLOAD_BYTES,
  type RenderSubprocessAdapter,
  type RenderSubprocessRequest,
} from "../src/deck-upload-worker.ts";

const PPTX_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);
const PDF_MAGIC = new TextEncoder().encode("%PDF-1.7\nfixture");

const SLIDE_SVG = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>");
const RENDER_JSON = new TextEncoder().encode(JSON.stringify({ closed: true, slide_count: 1 }));

type RendererBehavior =
  | {
      readonly kind: "succeed";
      readonly manifest: unknown;
      readonly write?: (outputDir: string) => void;
    }
  | { readonly kind: "fail"; readonly code: string; readonly message: string }
  | { readonly kind: "hang" };

function recordingRenderer(behavior: RendererBehavior) {
  const calls: RenderSubprocessRequest[] = [];
  const sourceExistedAtCall: boolean[] = [];
  const stagedBytesAtCall: Uint8Array[] = [];
  const adapter: RenderSubprocessAdapter = {
    async run(request, signal) {
      calls.push(request);
      sourceExistedAtCall.push(existsSync(request.sourcePath));
      stagedBytesAtCall.push(new Uint8Array(readFileSync(request.sourcePath)));
      mkdirSync(request.outputDir, { recursive: true });
      if (behavior.kind === "succeed") {
        if (behavior.write !== undefined) {
          behavior.write(request.outputDir);
        } else {
          writeFileSync(join(request.outputDir, "render.json"), RENDER_JSON);
          writeFileSync(join(request.outputDir, "ingestion.json"), RENDER_JSON);
          writeFileSync(join(request.outputDir, "slide-1.svg"), SLIDE_SVG);
        }
        return {
          ok: true,
          renderManifest: behavior.manifest,
          ingestionManifest: { structural: behavior.manifest },
        };
      }
      if (behavior.kind === "fail") {
        return { ok: false, code: behavior.code, message: behavior.message };
      }
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("renderer aborted on deadline")), {
          once: true,
        });
      });
      throw new Error("unreachable: hang behavior only settles via abort");
    },
  };
  return { adapter, calls, sourceExistedAtCall, stagedBytesAtCall };
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** A stream that hands chunks to the worker one at a time, only as pulled. */
function manualStream() {
  const queue: Array<Uint8Array | null> = [];
  const waiters: Array<() => void> = [];
  let pulls = 0;
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      const deliver = (): boolean => {
        const item = queue.shift();
        if (item === undefined) return false;
        if (item === null) controller.close();
        else controller.enqueue(item);
        return true;
      };
      if (deliver()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push(() => {
          deliver();
          resolve();
        });
      });
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    stream,
    get pulls() {
      return pulls;
    },
    get canceled() {
      return canceled;
    },
    push(chunk: Uint8Array) {
      queue.push(chunk);
      waiters.shift()?.();
    },
    finish() {
      queue.push(null);
      waiters.shift()?.();
    },
  };
}

function chunkedStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk === undefined) {
        controller.close();
        return Promise.resolve();
      }
      controller.enqueue(chunk);
      index += 1;
      return Promise.resolve();
    },
  });
}

function validInput(overrides: Partial<DeckUploadInput> = {}): DeckUploadInput {
  return {
    fileName: "deck.pptx",
    byteLength: PPTX_MAGIC.byteLength,
    content: chunkedStream([PPTX_MAGIC]),
    ...overrides,
  };
}

async function rejection(
  worker: DeckUploadWorker,
  input: DeckUploadInput,
): Promise<DeckUploadRejectionCode> {
  const outcome = await worker.processUpload(input);
  expect(outcome.outcome).toBe("REJECTED");
  if (outcome.outcome === "REJECTED") return outcome.code;
  throw new Error("unreachable");
}

function assertNoResidue(
  stagingRoot: string,
  artifactRoot: string,
  calls: RenderSubprocessRequest[],
): void {
  expect(readdirSync(stagingRoot)).toEqual([]);
  expect(readdirSync(artifactRoot).filter((entry) => entry.endsWith(".part"))).toEqual([]);
  for (const call of calls) {
    expect(existsSync(call.sourcePath)).toBe(false);
    expect(existsSync(call.outputDir)).toBe(false);
  }
}

function artifactDirs(artifactRoot: string): string[] {
  return readdirSync(artifactRoot).filter((entry) => !entry.endsWith(".part"));
}

describe("deck upload worker", () => {
  let stagingRoot: string;
  let artifactRoot: string;
  let fixtureRoot: string;
  let renderer: ReturnType<typeof recordingRenderer>;

  beforeEach(() => {
    stagingRoot = mkdtempSync(join(tmpdir(), "deck-upload-worker-staging-"));
    artifactRoot = mkdtempSync(join(tmpdir(), "deck-upload-worker-artifacts-"));
    fixtureRoot = mkdtempSync(join(tmpdir(), "deck-upload-worker-fixtures-"));
    renderer = recordingRenderer({ kind: "succeed", manifest: {} });
  });

  afterEach(() => {
    rmSync(stagingRoot, { recursive: true, force: true });
    rmSync(artifactRoot, { recursive: true, force: true });
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function worker(): DeckUploadWorker {
    return createDeckUploadWorker({ subprocess: renderer.adapter, stagingRoot, artifactRoot });
  }

  test("pins the upload cap to 100 MiB", () => {
    expect(MAX_DECK_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
  });

  test("rejects an empty declared upload before reading the body or invoking the renderer", async () => {
    const manual = manualStream();
    const code = await rejection(worker(), validInput({ byteLength: 0, content: manual.stream }));
    expect(code).toBe("empty_input");
    expect(manual.pulls).toBe(1); // only the construction pull; the body is never read
    expect(renderer.calls).toHaveLength(0);
    assertNoResidue(stagingRoot, artifactRoot, renderer.calls);
  });

  test("rejects a wrong extension before reading the body or invoking the renderer", async () => {
    for (const fileName of ["deck.txt", "deck", "deck.pptx.exe"]) {
      const manual = manualStream();
      const code = await rejection(worker(), validInput({ fileName, content: manual.stream }));
      expect(code).toBe("unsupported_extension");
      expect(manual.pulls).toBe(1);
    }
    expect(renderer.calls).toHaveLength(0);
    assertNoResidue(stagingRoot, artifactRoot, renderer.calls);
  });

  test("rejects a path-like filename before reading the body or invoking the renderer", async () => {
    for (const fileName of ["../deck.pptx", "sub/dir.pptx", "..\\deck.pptx", "\\deck.pptx"]) {
      const manual = manualStream();
      const code = await rejection(worker(), validInput({ fileName, content: manual.stream }));
      expect(code).toBe("unsafe_filename");
      expect(manual.pulls).toBe(1);
    }
    expect(renderer.calls).toHaveLength(0);
    assertNoResidue(stagingRoot, artifactRoot, renderer.calls);
  });

  test("routes validated PPTX and PDF uploads with generated suffix-preserving staged paths", async () => {
    const routes: string[] = [];
    const stagedNames: string[] = [];
    const routingRenderer: RenderSubprocessAdapter = {
      async run(request) {
        const stagedName = request.sourcePath.split(/[/\\]/).at(-1) ?? "";
        stagedNames.push(stagedName);
        const route = stagedName.endsWith(".pdf")
          ? "pdf"
          : stagedName.endsWith(".pptx")
            ? "pptx"
            : "unknown";
        routes.push(route);
        mkdirSync(request.outputDir, { recursive: true });
        writeFileSync(join(request.outputDir, "render.json"), RENDER_JSON);
        writeFileSync(join(request.outputDir, "ingestion.json"), RENDER_JSON);
        writeFileSync(
          join(request.outputDir, `slide-1.${route === "pdf" ? "png" : "svg"}`),
          SLIDE_SVG,
        );
        return {
          ok: true,
          renderManifest: { route },
          ingestionManifest: { structuralRoute: route },
        };
      },
    };
    const instance = createDeckUploadWorker({
      subprocess: routingRenderer,
      stagingRoot,
      artifactRoot,
    });

    expect((await instance.processUpload(validInput())).outcome).toBe("RENDERED");
    expect(
      (
        await instance.processUpload(
          validInput({
            fileName: "BOARD-HANDOUT.PDF",
            byteLength: PDF_MAGIC.byteLength,
            content: chunkedStream([PDF_MAGIC]),
          }),
        )
      ).outcome,
    ).toBe("RENDERED");

    expect(routes).toEqual(["pptx", "pdf"]);
    expect(stagedNames).toEqual(["upload.pptx", "upload.pdf"]);
    expect(readdirSync(stagingRoot)).toEqual([]);
    expect(readdirSync(artifactRoot).filter((entry) => entry.endsWith(".part"))).toEqual([]);
  });

  test("rejects a declared over-limit upload from the declaration alone", async () => {
    const manual = manualStream();
    const code = await rejection(
      worker(),
      validInput({ byteLength: MAX_DECK_UPLOAD_BYTES + 1, content: manual.stream }),
    );
    expect(code).toBe("input_too_large");
    expect(manual.pulls).toBe(1); // only the construction pull; the body is never read
    expect(renderer.calls).toHaveLength(0);
    assertNoResidue(stagingRoot, artifactRoot, renderer.calls);
  });

  test("rejects malformed content from the bounded stream prefix", async () => {
    const pptx = new TextEncoder().encode("this is not a zip container");
    expect(
      await rejection(
        worker(),
        validInput({ content: chunkedStream([pptx]), byteLength: pptx.byteLength }),
      ),
    ).toBe("malformed_input");
    const pdf = new TextEncoder().encode("not a pdf at all");
    expect(
      await rejection(
        worker(),
        validInput({
          fileName: "deck.pdf",
          content: chunkedStream([pdf]),
          byteLength: pdf.byteLength,
        }),
      ),
    ).toBe("malformed_input");
    const shortPdf = new TextEncoder().encode("%PDF");
    expect(
      await rejection(
        worker(),
        validInput({
          fileName: "deck.pdf",
          content: chunkedStream([shortPdf]),
          byteLength: shortPdf.byteLength,
        }),
      ),
    ).toBe("malformed_input");
    expect(renderer.calls).toHaveLength(0);
    assertNoResidue(stagingRoot, artifactRoot, renderer.calls);
  });

  test("rejects actual/declared size mismatches in both directions", async () => {
    const body = new TextEncoder().encode("PK\x03\x04actual body bytes");
    // Declared larger than actual.
    expect(
      await rejection(
        worker(),
        validInput({ content: chunkedStream([body]), byteLength: body.byteLength + 10 }),
      ),
    ).toBe("size_mismatch");
    // Declared smaller than actual.
    expect(
      await rejection(
        worker(),
        validInput({ content: chunkedStream([body]), byteLength: body.byteLength - 10 }),
      ),
    ).toBe("size_mismatch");
    // Declared non-empty but the body never arrives.
    expect(
      await rejection(worker(), validInput({ content: chunkedStream([]), byteLength: 5 })),
    ).toBe("size_mismatch");
    expect(renderer.calls).toHaveLength(0);
    assertNoResidue(stagingRoot, artifactRoot, renderer.calls);
  });

  test("rejects an actual over-limit body mid-stream, canceling the source", async () => {
    const chunk = new Uint8Array(4 * 1024 * 1024);
    chunk.set([0x50, 0x4b, 0x03, 0x04]); // valid zip prefix; the cap, not the signature, rejects this body
    let canceled = false;
    let enqueued = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (enqueued >= 27) {
          controller.close();
          return Promise.resolve();
        }
        enqueued += 1;
        controller.enqueue(chunk);
        return Promise.resolve();
      },
      cancel() {
        canceled = true;
      },
    });
    // Declared exactly at the cap (allowed); the actual stream exceeds it.
    const code = await rejection(
      worker(),
      validInput({ byteLength: MAX_DECK_UPLOAD_BYTES, content: stream }),
    );
    expect(code).toBe("input_too_large");
    expect(canceled).toBe(true);
    expect(renderer.calls).toHaveLength(0);
    assertNoResidue(stagingRoot, artifactRoot, renderer.calls);
  }, 30_000);

  test("consumes a multi-chunk body incrementally without whole-body buffering", async () => {
    const chunks: [Uint8Array, Uint8Array, Uint8Array, Uint8Array] = [
      new TextEncoder().encode("PK\x03\x04chunk-one"),
      new TextEncoder().encode("chunk-two-longer"),
      new TextEncoder().encode(""),
      new TextEncoder().encode("chunk-three"),
    ];
    const full = concatBytes(chunks);
    const manual = manualStream();
    const outcomePromise = worker().processUpload(
      validInput({ byteLength: full.byteLength, content: manual.stream }),
    );

    // Only the first chunk is handed to the stream; while the stream is still
    // open (the worker has come back for more), the worker must already have
    // written that chunk to upload.part: the body is streamed to disk, never
    // buffered as a whole.
    manual.push(chunks[0]);
    await eventually(() => {
      const stagingDir = readdirSync(stagingRoot)[0];
      expect(stagingDir).toBeDefined();
      const partBytes: Uint8Array<ArrayBufferLike> = new Uint8Array(
        readFileSync(join(stagingRoot, String(stagingDir), "upload.part")),
      );
      expect(partBytes).toEqual(chunks[0]);
    });
    expect(manual.pulls).toBeGreaterThanOrEqual(2); // the worker came back for more

    manual.push(chunks[1]);
    manual.push(chunks[2]);
    manual.push(chunks[3]);
    manual.finish();

    const outcome: DeckUploadOutcome = await outcomePromise;
    expect(outcome.outcome).toBe("RENDERED");
    expect(renderer.calls).toHaveLength(1);
    expect(renderer.stagedBytesAtCall[0]).toEqual(full);
  });

  test("surfaces renderer failure as a worker error and leaves no residue", async () => {
    renderer = recordingRenderer({
      kind: "fail",
      code: "renderer_crashed",
      message: "soffice exited with code 1",
    });

    const outcome = await worker()
      .processUpload(validInput())
      .then(
        (value) => ({ kind: "resolved" as const, value }),
        (error) => ({ kind: "rejected" as const, error }),
      );
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.error).toBeInstanceOf(DeckUploadWorkerError);
      if (outcome.error instanceof DeckUploadWorkerError) {
        expect(outcome.error.code).toBe("render_failed");
        expect(outcome.error.message).toContain("soffice exited with code 1");
      }
    }
    expect(renderer.calls).toHaveLength(1);
    expect(renderer.sourceExistedAtCall).toEqual([true]);
    assertNoResidue(stagingRoot, artifactRoot, renderer.calls);
  });

  test("aborts a hung renderer at the deadline and leaves no residue", async () => {
    renderer = recordingRenderer({ kind: "hang" });
    const deadlineWorker = createDeckUploadWorker({
      subprocess: renderer.adapter,
      stagingRoot,
      artifactRoot,
      deadlineMs: 25,
    });

    const outcome = await Promise.race([
      deadlineWorker.processUpload(validInput()).then(
        (value) => ({ kind: "resolved" as const, value }),
        (error) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("worker did not enforce its render deadline")), 2_000);
      }),
    ]);
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.error).toBeInstanceOf(DeckUploadWorkerError);
      if (outcome.error instanceof DeckUploadWorkerError) {
        expect(outcome.error.code).toBe("deadline_exceeded");
      }
    }
    expect(renderer.calls).toHaveLength(1);
    expect(renderer.sourceExistedAtCall).toEqual([true]);
    assertNoResidue(stagingRoot, artifactRoot, renderer.calls);
  });

  test("promotes renderer output to an immutable artifact and retains it", async () => {
    const manifest = { deck_id: `deck_${"a".repeat(64)}`, slides: [{ source_index: 1 }] };
    renderer = recordingRenderer({ kind: "succeed", manifest });
    const outcome: DeckUploadOutcome = await worker().processUpload(validInput());
    expect(outcome.outcome).toBe("RENDERED");
    if (outcome.outcome !== "RENDERED") throw new Error("unreachable");
    expect(outcome.manifest).toEqual(manifest);
    expect(outcome.artifactId).toMatch(/^[0-9a-f]{64}$/);

    // The artifact is retained under artifactRoot/<artifactId>; staging is empty.
    const artifactIds = artifactDirs(artifactRoot);
    expect(artifactIds).toEqual([outcome.artifactId]);
    expect(readdirSync(stagingRoot)).toEqual([]);

    // Exact bytes survive promotion, including the render manifest file.
    const artifactDir = join(artifactRoot, outcome.artifactId);
    const slideBytes = new Uint8Array(readFileSync(join(artifactDir, "slide-1.svg")));
    const jsonBytes = new Uint8Array(readFileSync(join(artifactDir, "render.json")));
    const ingestionBytes = new Uint8Array(readFileSync(join(artifactDir, "ingestion.json")));
    expect(slideBytes).toEqual(SLIDE_SVG);
    expect(jsonBytes).toEqual(RENDER_JSON);
    expect(ingestionBytes).toEqual(RENDER_JSON);
    expect(createHash("sha256").update(slideBytes).digest("hex")).toBe(
      createHash("sha256").update(SLIDE_SVG).digest("hex"),
    );
    // No staging or artifact .part residue remains.
    expect(readdirSync(artifactRoot).filter((entry) => entry.endsWith(".part"))).toEqual([]);
    expect(renderer.calls).toHaveLength(1);
  });

  test("is idempotent when an identical artifact already exists", async () => {
    const manifest = { deck_id: `deck_${"b".repeat(64)}`, slides: [{ source_index: 1 }] };
    renderer = recordingRenderer({ kind: "succeed", manifest });
    const instance = worker();

    const first = await instance.processUpload(validInput());
    expect(first.outcome).toBe("RENDERED");
    if (first.outcome !== "RENDERED") throw new Error("unreachable");
    const artifactDir = join(artifactRoot, first.artifactId);
    const firstSlide = new Uint8Array(readFileSync(join(artifactDir, "slide-1.svg")));

    const second = await instance.processUpload(validInput());
    expect(second.outcome).toBe("RENDERED");
    if (second.outcome !== "RENDERED") throw new Error("unreachable");
    expect(second.artifactId).toBe(first.artifactId);

    // Exactly one immutable artifact remains, byte-identical, with no .part residue.
    expect(artifactDirs(artifactRoot)).toEqual([first.artifactId]);
    expect(new Uint8Array(readFileSync(join(artifactDir, "slide-1.svg")))).toEqual(firstSlide);
    expect(readdirSync(artifactRoot).filter((entry) => entry.endsWith(".part"))).toEqual([]);
    expect(readdirSync(stagingRoot)).toEqual([]);
  });

  test("rejects a symlink in renderer output, cleans up, and a retry succeeds", async () => {
    const secret = join(fixtureRoot, "secret.txt");
    writeFileSync(secret, "do not copy");
    renderer = recordingRenderer({
      kind: "succeed",
      manifest: { deck_id: `deck_${"c".repeat(64)}` },
      write(outputDir) {
        writeFileSync(join(outputDir, "slide-1.svg"), SLIDE_SVG);
        symlinkSync(secret, join(outputDir, "evil-link"));
      },
    });

    const failed = await worker()
      .processUpload(validInput())
      .then(
        (value) => ({ kind: "resolved" as const, value }),
        (error) => ({ kind: "rejected" as const, error }),
      );
    expect(failed.kind).toBe("rejected");
    if (failed.kind === "rejected") {
      expect(failed.error).toBeInstanceOf(DeckUploadWorkerError);
      if (failed.error instanceof DeckUploadWorkerError) {
        expect(failed.error.code).toBe("artifact_path_rejected");
      }
    }
    assertNoResidue(stagingRoot, artifactRoot, renderer.calls);

    // A retry with a well-behaved renderer fully succeeds: no .part from the
    // failed attempt survives, and the artifact is promoted and retained.
    renderer = recordingRenderer({
      kind: "succeed",
      manifest: { deck_id: `deck_${"d".repeat(64)}` },
    });
    const retry: DeckUploadOutcome = await worker().processUpload(validInput());
    expect(retry.outcome).toBe("RENDERED");
    if (retry.outcome !== "RENDERED") throw new Error("unreachable");
    expect(artifactDirs(artifactRoot)).toEqual([retry.artifactId]);
    expect(readdirSync(artifactRoot).filter((entry) => entry.endsWith(".part"))).toEqual([]);
    expect(readdirSync(stagingRoot)).toEqual([]);
    const promoted = new Uint8Array(
      readFileSync(join(artifactRoot, retry.artifactId, "slide-1.svg")),
    );
    expect(promoted).toEqual(SLIDE_SVG);
  });

  test("rejects a renderer output path that escapes the artifact tree", async () => {
    renderer = recordingRenderer({
      kind: "succeed",
      manifest: { deck_id: `deck_${"e".repeat(64)}` },
      write(outputDir) {
        // A symlinked directory is the escape vector: following it would place
        // files outside the artifact tree.
        const outside = mkdtempSync(join(fixtureRoot, "outside-"));
        writeFileSync(join(outside, "escape.txt"), "escaped");
        symlinkSync(outside, join(outputDir, "linked-dir"));
      },
    });

    const outcome = await worker()
      .processUpload(validInput())
      .then(
        (value) => ({ kind: "resolved" as const, value }),
        (error) => ({ kind: "rejected" as const, error }),
      );
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.error).toBeInstanceOf(DeckUploadWorkerError);
      if (outcome.error instanceof DeckUploadWorkerError) {
        expect(outcome.error.code).toBe("artifact_path_rejected");
      }
    }
    expect(artifactDirs(artifactRoot)).toEqual([]);
    assertNoResidue(stagingRoot, artifactRoot, renderer.calls);
  });
});

async function eventually(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = new Error("condition never became true");
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw lastError instanceof Error ? lastError : new Error("condition never became true");
}
