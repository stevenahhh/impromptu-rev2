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

interface FakeRendererBehavior {
  readonly exitCode?: number; // undefined: keep running until killed
  readonly stdout?: string;
  readonly stderr?: string;
  readonly renderJson?: unknown; // written to <outputDir>/render.json at spawn time
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

  const spawn: RenderSpawn = (options) => {
    spawnCalls.push(options);
    if (behavior.spawnError !== undefined) throw behavior.spawnError;

    if (behavior.renderJson !== undefined) {
      const outputDirIndex = options.cmd.indexOf("--output-dir");
      const outputDir = options.cmd[outputDirIndex + 1];
      if (outputDirIndex !== -1 && outputDir !== undefined) {
        mkdirSync(outputDir, { recursive: true });
        writeFileSync(join(outputDir, "render.json"), `${JSON.stringify(behavior.renderJson)}\n`);
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
          resolveExit(behavior.exitCode ?? 143);
        },
      },
      killCalls: 0,
    };
    handles.push(handle);
    if (behavior.exitCode !== undefined) {
      queueMicrotask(() => resolveExit(behavior.exitCode as number));
    }
    return handle.process;
  };

  return { spawn, spawnCalls, handles };
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
    }
    expect(renderer.spawnCalls).toHaveLength(1);
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
    expect(renderer.spawnCalls[0]?.signal).toBe(controller.signal);
    expect(renderer.spawnCalls[0]?.stdin).toBe("ignore");
    expect(renderer.spawnCalls[0]?.stdout).toBe("pipe");
    expect(renderer.spawnCalls[0]?.stderr).toBe("pipe");
    expect(renderer.handles[0]?.killCalls).toBe(0);
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
