/**
 * Bun-to-Python render subprocess adapter.
 *
 * Owns the single subprocess boundary between the private backend and the
 * ingestion CLI. Runs
 *
 *   uv run --project <ingestionProject> impromptu-ingestion render <source> --output-dir <dir>
 *
 * as an argv array (never a shell string), passes the caller's AbortSignal to
 * a killable Bun.spawn process, captures bounded stdout/stderr, requires exit
 * code 0, and parses <outputDir>/render.json with a closed schema. Every
 * failure is a typed RenderSubprocessResult; this adapter never throws.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import type {
  RenderSubprocessAdapter,
  RenderSubprocessRequest,
  RenderSubprocessResult,
} from "./deck-upload-worker.ts";

export const DEFAULT_RENDER_CAPTURE_BYTES = 64 * 1024;

export type RenderSubprocessFailureCode =
  | "spawn_failed"
  | "aborted"
  | "render_failed"
  | "render_output_missing"
  | "render_manifest_invalid";

/** The spawn seam, structurally compatible with Bun.spawn piped output. */
export interface RenderSpawnOptions {
  readonly cmd: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly stdin: "ignore";
  readonly stdout: "pipe";
  readonly stderr: "pipe";
  readonly signal: AbortSignal;
}

export interface RenderSpawnedProcess {
  readonly exited: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  kill(): void;
}

export type RenderSpawn = (options: RenderSpawnOptions) => RenderSpawnedProcess;

export interface DeckRenderSubprocessOptions {
  /** Path passed to `uv run --project` (the services/ingestion project). */
  readonly ingestionProject: string;
  /** Per-stream stdout/stderr capture bound in bytes (default 64 KiB). */
  readonly maxCapturedBytes?: number;
  /** Test seam; defaults to Bun.spawn. */
  readonly spawn?: RenderSpawn;
}

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const SlideKeySchema = z.string().regex(/^slide_[0-9a-f]{64}$/);
const DeckIdSchema = z.string().regex(/^deck_[0-9a-f]{64}$/);
const RelativePathSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/);
const ErrorCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{2,63}$/);
const SvgElementIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/);
const HexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

const RenderJsonRendererSchema = z
  .object({
    name: z.enum(["libreoffice", "pymupdf"]),
    version: z.string().min(1).max(64),
  })
  .strict();

const RenderJsonSlideSchema = z
  .object({
    slide_key: SlideKeySchema,
    source_index: z.number().int().positive(),
    relative_path: RelativePathSchema,
    content_sha256: Sha256Schema,
    width_points: z.number().positive(),
    height_points: z.number().positive(),
  })
  .strict();

const RenderJsonAssetSchema = z
  .object({
    relative_path: RelativePathSchema,
    media_type: z.string().regex(/^[a-z]+\/[a-z0-9.+-]+$/),
    content_sha256: Sha256Schema,
    byte_size: z.number().int().positive(),
  })
  .strict();

const RenderJsonFontSchema = z
  .object({
    family: z.string().min(1).max(128),
    relative_path: RelativePathSchema.nullable(),
    embedded: z.boolean(),
    format: z.enum(["woff2", "woff", "truetype", "opentype"]).nullable(),
  })
  .strict();

const RenderJsonBehaviorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("fade"),
      direction: z.enum(["in", "out"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("wipe"),
      direction: z.enum(["in", "out"]),
      edge: z.enum(["left", "right", "up", "down"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("motion"),
      path: z
        .string()
        .min(1)
        .max(4096)
        .regex(/^[MmLlCcQqAaHhVvZzEe0-9 ,.-]+$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("color"),
      from_color: HexColorSchema,
      to_color: HexColorSchema,
    })
    .strict(),
]);

const RenderJsonEffectSchema = z
  .object({
    trigger: z.enum(["on_click", "with_previous", "after_previous"]),
    effect_class: z.enum(["entrance", "emphasis", "exit", "motion"]),
    preset_id: z.number().int().min(0),
    preset_subtype: z.number().int().min(0).nullable(),
    duration_ms: z.number().int().min(0).max(600_000),
    delay_ms: z.number().int().min(0).max(600_000),
    target: z
      .object({
        shape_id: z.number().int().positive(),
        shape_name: z.string().min(1).max(128),
        svg_element_id: SvgElementIdSchema,
      })
      .strict(),
    behavior: RenderJsonBehaviorSchema,
  })
  .strict();

const RenderJsonTimelineSchema = z
  .object({
    slide_key: SlideKeySchema,
    click_groups: z.array(z.array(RenderJsonEffectSchema)),
    transition: z
      .object({
        kind: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
        advance_on_click: z.boolean(),
      })
      .strict()
      .nullable(),
    unsupported: z.array(
      z
        .object({
          reason_code: ErrorCodeSchema,
          preset_id: z.number().int().min(0).nullable(),
          detail: z.string().min(1).max(512),
        })
        .strict(),
    ),
  })
  .strict();

const RenderJsonMappingIssueSchema = z
  .object({
    code: ErrorCodeSchema,
    slide_index: z.number().int().positive(),
    path: z.string().min(1).max(128),
    detail: z.string().min(1).max(512),
  })
  .strict();

/**
 * Closed schema for the ingestion CLI's render.json output
 * (impromptu_ingestion.render.contracts.RenderedDeck).
 */
export const RenderJsonSchema = z
  .object({
    deck_id: DeckIdSchema,
    renderer: RenderJsonRendererSchema,
    slides: z.array(RenderJsonSlideSchema).min(1),
    assets: z.array(RenderJsonAssetSchema),
    fonts: z.array(RenderJsonFontSchema),
    timelines: z.array(RenderJsonTimelineSchema),
    mapping_issues: z.array(RenderJsonMappingIssueSchema),
    animation_eligible: z.boolean(),
    ineligible_reason: z.string().min(1).max(512).nullable(),
  })
  .strict();

export type RenderJson = z.infer<typeof RenderJsonSchema>;

function defaultSpawn(options: RenderSpawnOptions): RenderSpawnedProcess {
  const process = Bun.spawn<"ignore", "pipe", "pipe">({
    cmd: [...options.cmd],
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    signal: options.signal,
  });
  return {
    exited: process.exited,
    stdout: process.stdout,
    stderr: process.stderr,
    kill: () => {
      process.kill();
    },
  };
}

interface CapturedOutput {
  readonly text: string;
  readonly truncated: boolean;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** Drain one stream while retaining at most `limit` bytes of decoded text. */
async function captureBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<CapturedOutput> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let captured = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      if (captured >= limit) {
        truncated = true;
        continue;
      }
      const take = Math.min(value.byteLength, limit - captured);
      if (take < value.byteLength) truncated = true;
      chunks.push(value.subarray(0, take));
      captured += take;
    }
  } finally {
    reader.releaseLock();
  }
  return { text: new TextDecoder().decode(concatBytes(chunks)), truncated };
}

function describeCapture(capture: CapturedOutput, limit: number): string {
  if (!capture.truncated) return capture.text;
  return `${capture.text}… (truncated at ${limit} bytes)`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function zodSummary(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

/**
 * Create the render subprocess adapter. The child is killed when `signal`
 * aborts; the returned promise settles with a typed failure and never throws.
 */
export function createDeckRenderSubprocess(
  options: DeckRenderSubprocessOptions,
): RenderSubprocessAdapter {
  const spawn = options.spawn ?? defaultSpawn;
  const limit = Math.max(0, options.maxCapturedBytes ?? DEFAULT_RENDER_CAPTURE_BYTES);

  async function run(
    request: RenderSubprocessRequest,
    signal: AbortSignal,
  ): Promise<RenderSubprocessResult> {
    if (signal.aborted) {
      return { ok: false, code: "aborted", message: "render subprocess was already aborted" };
    }

    const cmd = [
      "uv",
      "run",
      "--project",
      options.ingestionProject,
      "impromptu-ingestion",
      "render",
      request.sourcePath,
      "--output-dir",
      request.outputDir,
    ];

    let process: RenderSpawnedProcess;
    try {
      process = spawn({
        cmd,
        env: Bun.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        signal,
      });
    } catch (error) {
      return {
        ok: false,
        code: "spawn_failed",
        message: `render subprocess could not start: ${errorMessage(error)}`,
      };
    }

    let signalAborted!: () => void;
    const aborted = new Promise<void>((resolve) => {
      signalAborted = resolve;
    });
    signal.addEventListener("abort", () => signalAborted(), { once: true });

    const [stdout, stderr] = await Promise.all([
      captureBounded(process.stdout, limit),
      captureBounded(process.stderr, limit),
    ]);

    const outcome = await Promise.race([
      process.exited.then(
        (code) => ({ kind: "exited" as const, code }),
        () => ({ kind: "exited" as const, code: -1 }),
      ),
      aborted.then(() => ({ kind: "aborted" as const })),
    ]);

    if (outcome.kind === "aborted") {
      process.kill();
      await process.exited.catch(() => 0);
      return {
        ok: false,
        code: "aborted",
        message: "render subprocess was aborted before completion",
      };
    }

    if (outcome.code !== 0) {
      const stderrText = describeCapture(stderr, limit);
      const stdoutText = describeCapture(stdout, limit);
      return {
        ok: false,
        code: "render_failed",
        message:
          stderrText.length > 0
            ? `renderer exited with code ${outcome.code}; stderr: ${stderrText}`
            : `renderer exited with code ${outcome.code}; stdout: ${stdoutText}`,
      };
    }

    const manifestPath = join(request.outputDir, "render.json");
    let payload: string;
    try {
      payload = await readFile(manifestPath, "utf8");
    } catch (error) {
      return {
        ok: false,
        code: "render_output_missing",
        message: `renderer exited 0 but ${manifestPath} could not be read: ${errorMessage(error)}`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch (error) {
      return {
        ok: false,
        code: "render_manifest_invalid",
        message: `render.json is not valid JSON: ${errorMessage(error)}`,
      };
    }

    const validated = RenderJsonSchema.safeParse(parsed);
    if (!validated.success) {
      return {
        ok: false,
        code: "render_manifest_invalid",
        message: `render.json is not a valid render manifest: ${zodSummary(validated.error)}`,
      };
    }

    return { ok: true, renderManifest: validated.data };
  }

  return { run };
}
