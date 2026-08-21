/**
 * Contract for the Bun-to-Python render subprocess adapter.
 *
 * Intended module: services/private-backend/src/deck-render-subprocess.ts.
 *
 * The adapter owns the single subprocess boundary between the private backend
 * and the ingestion CLI. It must:
 *
 *   - run `uv run --project <ingestionProject> impromptu-ingestion render
 *     <source> --output-dir <dir>` as an argv array (never a shell string),
 *   - pass the caller's AbortSignal to a killable Bun.spawn process and kill
 *     the child when the signal fires,
 *   - capture bounded stdout/stderr (default 64 KiB per stream),
 *   - require exit code 0,
 *   - parse <outputDir>/render.json with a closed schema,
 *   - return typed RenderSubprocessResult failures, never throw.
 *
 * The spawn function is injectable so tests drive every failure mode without a
 * real uv/LibreOffice stack.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDeckRenderSubprocess,
  DEFAULT_RENDER_CAPTURE_BYTES,
  type RenderSpawn,
  type RenderSpawnedProcess,
  type RenderSpawnOptions,
} from "../src/deck-render-subprocess.ts";
import type { RenderSubprocessRequest } from "../src/deck-upload-worker.ts";

const INGESTION_PROJECT = "/absolute/path/to/services/ingestion";

const VALID_RENDER_JSON = {
  deck_id: `deck_${"a".repeat(64)}`,
  renderer: { name: "libreoffice", version: "7.6.5.2" },
  slides: [
    {
      slide_key: `slide_${"b".repeat(64)}`,
      source_index: 1,
      relative_path: "slides/slide-1.svg",
      content_sha256: "c".repeat(64),
      width_points: 960,
      height_points: 540,
    },
  ],
  assets: [],
  fonts: [
    {
      family: "Pretendard",
      relative_path: "fonts/Pretendard.ttf",
      embedded: true,
      format: "truetype",
    },
  ],
  timelines: [],
  mapping_issues: [],
  animation_eligible: true,
  ineligible_reason: null,
} as const;

const VALID_INGESTION_JSON = {
  status: "completed",
  job_id: "production_ingest",
  manifest_hash: "d".repeat(64),
  manifest: {
    schema_version: "1",
    deck_id: VALID_RENDER_JSON.deck_id,
    source_sha256: "a".repeat(64),
    source_kind: "pptx",
    adapter_version: "python-pptx-structural-v1",
    slides: [
      {
        slide_key: `slide_${"e".repeat(64)}`,
        source_index: 1,
        source_id: "slide:256",
        width_points: 960,
        height_points: 540,
        elements: [
          {
            kind: "text",
            element_id: "shape:2",
            x: 72,
            y: 108,
            width: 576,
            height: 90,
            text: "형식 중립 근거 자료 2026",
          },
        ],
        warnings: [],
      },
    ],
    render_boundary: {
      status: "not_performed",
      renderer: null,
      fidelity_verified: false,
      reason: "Structural extraction only",
    },
  },
} as const;

interface FakeRendererBehavior {
  readonly exitCode?: number; // undefined: keep running until killed
  readonly stdout?: string;
  readonly stderr?: string;
  readonly renderJson?: unknown; // written to <outputDir>/render.json at render spawn time
  readonly ingestionJson?: unknown; // defaults to VALID_INGESTION_JSON
  readonly skipIngestionOutput?: boolean;
  readonly ingestionExitCode?: number | null; // null keeps the ingestion child running
  readonly spawnError?: Error; // spawn throws instead of starting
}

interface FakeHandle {
  readonly options: RenderSpawnOptions;
  readonly process: RenderSpawnedProcess;
  killCalls: number;
}

function fakeRenderer(behavior: FakeRendererBehavior) {
  const spawnCalls: RenderSpawnOptions[] = [];
  const handles: FakeHandle[] = [];
  let markIngestionStarted!: () => void;
  const ingestionStarted = new Promise<void>((resolve) => {
    markIngestionStarted = resolve;
  });

  const spawn: RenderSpawn = (options) => {
    spawnCalls.push(options);
    if (behavior.spawnError !== undefined) throw behavior.spawnError;

    const isIngestion = options.cmd.includes("ingest");
    if (isIngestion) markIngestionStarted();
    if (!isIngestion && behavior.renderJson !== undefined) {
      const outputDirIndex = options.cmd.indexOf("--output-dir");
      const outputDir = options.cmd[outputDirIndex + 1];
      if (outputDirIndex !== -1 && outputDir !== undefined) {
        mkdirSync(outputDir, { recursive: true });
        writeFileSync(join(outputDir, "render.json"), `${JSON.stringify(behavior.renderJson)}\n`);
      }
    }
    if (isIngestion && !behavior.skipIngestionOutput) {
      const outputIndex = options.cmd.indexOf("--output");
      const outputPath = options.cmd[outputIndex + 1];
      if (outputIndex !== -1 && outputPath !== undefined) {
        writeFileSync(
          outputPath,
          `${JSON.stringify(behavior.ingestionJson ?? VALID_INGESTION_JSON)}\n`,
        );
      }
    }

    const encoder = new TextEncoder();
    const stdoutBytes = encoder.encode(behavior.stdout ?? "");
    const stderrBytes = encoder.encode(behavior.stderr ?? "");
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const handle: FakeHandle = {
      options,
      process: {
        exited,
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            if (stdoutBytes.byteLength > 0) controller.enqueue(stdoutBytes);
            controller.close();
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start(controller) {
            if (stderrBytes.byteLength > 0) controller.enqueue(stderrBytes);
            controller.close();
          },
        }),
        kill() {
          handle.killCalls += 1;
          resolveExit((isIngestion ? behavior.ingestionExitCode : behavior.exitCode) ?? 143);
        },
      },
      killCalls: 0,
    };
    handles.push(handle);
    const configuredExitCode = isIngestion ? behavior.ingestionExitCode : behavior.exitCode;
    const exitCode = configuredExitCode === undefined ? behavior.exitCode : configuredExitCode;
    if (exitCode !== undefined && exitCode !== null) {
      queueMicrotask(() => resolveExit(exitCode));
    }
    return handle.process;
  };

  return { spawn, spawnCalls, handles, ingestionStarted };
}

async function bounded<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("adapter did not settle within the deadline")), timeoutMs);
    }),
  ]);
}

describe("deck render subprocess adapter", () => {
  let root: string;
  let controller: AbortController;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "deck-render-subprocess-"));
    controller = new AbortController();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function request(): RenderSubprocessRequest {
    return { sourcePath: join(root, "my deck.pptx"), outputDir: join(root, "render out") };
  }

  test("runs the exact uv argv and returns the closed render.json manifest", async () => {
    const renderer = fakeRenderer({ exitCode: 0, renderJson: VALID_RENDER_JSON });
    const adapter = createDeckRenderSubprocess({
      ingestionProject: INGESTION_PROJECT,
      spawn: renderer.spawn,
    });

    const result = await bounded(adapter.run(request(), controller.signal));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.renderManifest).toEqual(VALID_RENDER_JSON);
      expect(result.ingestionManifest).toEqual(VALID_INGESTION_JSON);
    }
    expect(renderer.spawnCalls).toHaveLength(2);
    expect(renderer.spawnCalls[0]?.cmd).toEqual([
      "uv",
      "run",
      "--project",
      INGESTION_PROJECT,
      "impromptu-ingestion",
      "render",
      join(root, "my deck.pptx"),
      "--output-dir",
      join(root, "render out"),
    ]);
    expect(renderer.spawnCalls[1]?.cmd).toEqual([
      "uv",
      "run",
      "--project",
      INGESTION_PROJECT,
      "impromptu-ingestion",
      "ingest",
      join(root, "my deck.pptx"),
      "--job-id",
      "production_ingest",
      "--output",
      join(root, "render out", "ingestion.json"),
    ]);
    expect(renderer.spawnCalls[0]?.signal).toBe(controller.signal);
    expect(renderer.spawnCalls[1]?.signal).toBe(controller.signal);
    expect(renderer.spawnCalls[0]?.stdin).toBe("ignore");
    expect(renderer.spawnCalls[0]?.stdout).toBe("pipe");
    expect(renderer.spawnCalls[0]?.stderr).toBe("pipe");
    expect(renderer.handles[0]?.killCalls).toBe(0);
    expect(renderer.handles[1]?.killCalls).toBe(0);
  });

  test("reports render_failed with the captured stderr on a nonzero exit", async () => {
    const renderer = fakeRenderer({
      exitCode: 2,
      stderr: "error[renderer_not_configured]: LibreOffice was not found\n",
    });
    const adapter = createDeckRenderSubprocess({
      ingestionProject: INGESTION_PROJECT,
      spawn: renderer.spawn,
    });

    const result = await bounded(adapter.run(request(), controller.signal));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("render_failed");
      expect(result.message).toContain("exited with code 2");
      expect(result.message).toContain("error[renderer_not_configured]");
    }
    expect(renderer.handles[0]?.killCalls).toBe(0);
  });

  test("kills a running child when the signal aborts and reports aborted", async () => {
    const renderer = fakeRenderer({ stderr: "still rendering" });
    const adapter = createDeckRenderSubprocess({
      ingestionProject: INGESTION_PROJECT,
      spawn: renderer.spawn,
    });

    const resultPromise = bounded(adapter.run(request(), controller.signal));
    controller.abort();
    const result = await resultPromise;

    expect(result).toEqual({ ok: false, code: "aborted", message: expect.any(String) });
    expect(renderer.spawnCalls).toHaveLength(1);
    expect(renderer.handles[0]?.killCalls).toBe(1);
  });

  test("reports aborted without spawning when the signal is already aborted", async () => {
    const renderer = fakeRenderer({ exitCode: 0, renderJson: VALID_RENDER_JSON });
    const adapter = createDeckRenderSubprocess({
      ingestionProject: INGESTION_PROJECT,
      spawn: renderer.spawn,
    });
    controller.abort();

    const result = await bounded(adapter.run(request(), controller.signal));

    expect(result).toEqual({ ok: false, code: "aborted", message: expect.any(String) });
    expect(renderer.spawnCalls).toHaveLength(0);
  });

  test("reports spawn_failed when the child cannot start", async () => {
    const renderer = fakeRenderer({ spawnError: new Error("uv: command not found") });
    const adapter = createDeckRenderSubprocess({
      ingestionProject: INGESTION_PROJECT,
      spawn: renderer.spawn,
    });

    const result = await bounded(adapter.run(request(), controller.signal));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("spawn_failed");
      expect(result.message).toContain("uv: command not found");
    }
  });

  test("reports render_output_missing when exit 0 publishes no render.json", async () => {
    const renderer = fakeRenderer({ exitCode: 0 });
    const adapter = createDeckRenderSubprocess({
      ingestionProject: INGESTION_PROJECT,
      spawn: renderer.spawn,
    });

    const result = await bounded(adapter.run(request(), controller.signal));

    expect(result).toEqual({
      ok: false,
      code: "render_output_missing",
      message: expect.stringContaining("render.json"),
    });
  });

  test("does not return success when structural ingestion fails or publishes invalid output", async () => {
    const failed = fakeRenderer({
      exitCode: 0,
      ingestionExitCode: 2,
      stderr: "error[invalid_document]: structural extraction failed",
      renderJson: VALID_RENDER_JSON,
    });
    const failedResult = await bounded(
      createDeckRenderSubprocess({
        ingestionProject: INGESTION_PROJECT,
        spawn: failed.spawn,
      }).run(request(), controller.signal),
    );
    expect(failedResult).toEqual({
      ok: false,
      code: "ingestion_failed",
      message: expect.stringContaining("structural extraction failed"),
    });
    rmSync(join(root, "render out"), { recursive: true, force: true });

    const missing = fakeRenderer({
      exitCode: 0,
      renderJson: VALID_RENDER_JSON,
      skipIngestionOutput: true,
    });
    const missingResult = await bounded(
      createDeckRenderSubprocess({
        ingestionProject: INGESTION_PROJECT,
        spawn: missing.spawn,
      }).run(request(), controller.signal),
    );
    expect(missingResult).toEqual({
      ok: false,
      code: "ingestion_output_missing",
      message: expect.stringContaining("ingestion.json"),
    });
    rmSync(join(root, "render out"), { recursive: true, force: true });

    const invalid = fakeRenderer({
      exitCode: 0,
      renderJson: VALID_RENDER_JSON,
      ingestionJson: { status: "completed", smuggled: true },
    });
    const invalidResult = await bounded(
      createDeckRenderSubprocess({
        ingestionProject: INGESTION_PROJECT,
        spawn: invalid.spawn,
      }).run(request(), controller.signal),
    );
    expect(invalidResult).toEqual({
      ok: false,
      code: "ingestion_manifest_invalid",
      message: expect.any(String),
    });
  });

  test.each([
    "Tesseract binary is missing",
    "Tesseract exited nonzero (2)",
    "Tesseract exceeded its operation deadline",
    "Tesseract returned empty TSV",
  ])("preserves OCR unavailability from ingestion: %s", async (detail) => {
    const renderer = fakeRenderer({
      exitCode: 0,
      ingestionExitCode: 2,
      stderr: `error[ocr_unavailable]: ocr_unavailable: scanned_page_requires_ocr: ${detail}`,
      renderJson: VALID_RENDER_JSON,
    });

    const result = await bounded(
      createDeckRenderSubprocess({
        ingestionProject: INGESTION_PROJECT,
        spawn: renderer.spawn,
      }).run(request(), controller.signal),
    );

    expect(result).toEqual({
      ok: false,
      code: "ocr_unavailable",
      message: expect.stringContaining("scanned_page_requires_ocr"),
    });
  });

  test("does not classify unrelated ingestion diagnostics mentioning OCR as unavailable", async () => {
    const renderer = fakeRenderer({
      exitCode: 0,
      ingestionExitCode: 2,
      stderr: "error[invalid_document]: notes mention error[ocr_unavailable] only in prose",
      renderJson: VALID_RENDER_JSON,
    });

    const result = await bounded(
      createDeckRenderSubprocess({
        ingestionProject: INGESTION_PROJECT,
        spawn: renderer.spawn,
      }).run(request(), controller.signal),
    );

    expect(result).toMatchObject({ ok: false, code: "ingestion_failed" });
  });

  test("aborts structural ingestion under the same upload signal", async () => {
    const renderer = fakeRenderer({
      exitCode: 0,
      ingestionExitCode: null,
      renderJson: VALID_RENDER_JSON,
    });
    const adapter = createDeckRenderSubprocess({
      ingestionProject: INGESTION_PROJECT,
      spawn: renderer.spawn,
    });

    const resultPromise = bounded(adapter.run(request(), controller.signal));
    await renderer.ingestionStarted;
    controller.abort();
    const result = await resultPromise;

    expect(result).toEqual({ ok: false, code: "aborted", message: expect.any(String) });
    expect(renderer.handles[1]?.killCalls).toBe(1);
  });

  test("rejects render and structural manifests for different source decks", async () => {
    const renderer = fakeRenderer({
      exitCode: 0,
      renderJson: VALID_RENDER_JSON,
      ingestionJson: {
        ...VALID_INGESTION_JSON,
        manifest: {
          ...VALID_INGESTION_JSON.manifest,
          deck_id: `deck_${"f".repeat(64)}`,
          source_sha256: "f".repeat(64),
        },
      },
    });
    const result = await bounded(
      createDeckRenderSubprocess({
        ingestionProject: INGESTION_PROJECT,
        spawn: renderer.spawn,
      }).run(request(), controller.signal),
    );

    expect(result).toEqual({
      ok: false,
      code: "manifest_mismatch",
      message: expect.any(String),
    });
  });

  test("reports render_manifest_invalid for a malformed render.json", async () => {
    const renderer = fakeRenderer({
      exitCode: 0,
      renderJson: { ...VALID_RENDER_JSON, deck_id: "not-a-deck-id" },
    });
    const adapter = createDeckRenderSubprocess({
      ingestionProject: INGESTION_PROJECT,
      spawn: renderer.spawn,
    });

    const result = await bounded(adapter.run(request(), controller.signal));

    expect(result).toEqual({
      ok: false,
      code: "render_manifest_invalid",
      message: expect.any(String),
    });
  });

  test("rejects unknown keys in render.json (closed schema)", async () => {
    const renderer = fakeRenderer({
      exitCode: 0,
      renderJson: { ...VALID_RENDER_JSON, smuggled: { evil: true } },
    });
    const adapter = createDeckRenderSubprocess({
      ingestionProject: INGESTION_PROJECT,
      spawn: renderer.spawn,
    });

    const result = await bounded(adapter.run(request(), controller.signal));

    expect(result).toEqual({
      ok: false,
      code: "render_manifest_invalid",
      message: expect.any(String),
    });
  });

  test("bounds captured stdout and stderr to maxCapturedBytes per stream", async () => {
    const loud = fakeRenderer({
      exitCode: 1,
      stdout: "y".repeat(200),
      stderr: "x".repeat(200),
      renderJson: VALID_RENDER_JSON,
    });
    const loudAdapter = createDeckRenderSubprocess({
      ingestionProject: INGESTION_PROJECT,
      spawn: loud.spawn,
      maxCapturedBytes: 32,
    });

    const failure = await bounded(loudAdapter.run(request(), controller.signal));
    expect(failure.ok).toBe(false);
    if (!failure.ok) {
      expect(failure.code).toBe("render_failed");
      expect(failure.message).toContain("truncated at 32 bytes");
      expect(failure.message.length).toBeLessThan(120);
    }

    const chatty = fakeRenderer({
      exitCode: 0,
      stdout: "y".repeat(200),
      stderr: "x".repeat(200),
      renderJson: VALID_RENDER_JSON,
    });
    const chattyAdapter = createDeckRenderSubprocess({
      ingestionProject: INGESTION_PROJECT,
      spawn: chatty.spawn,
      maxCapturedBytes: 32,
    });

    const success = await bounded(chattyAdapter.run(request(), controller.signal));
    expect(success.ok).toBe(true);
  });

  test("defaults the per-stream capture bound to 64 KiB", () => {
    expect(DEFAULT_RENDER_CAPTURE_BYTES).toBe(64 * 1024);
  });
});
