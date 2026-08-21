/**
 * Bun-to-Python render subprocess adapter.
 *
 * Owns the single subprocess boundary between the private backend and the
 * ingestion CLI. Runs
 *
 *   uv run --project <ingestionProject> impromptu-ingestion render <source> --output-dir <dir>
 *   uv run --project <ingestionProject> impromptu-ingestion ingest <source> --output <dir>/ingestion.json
 *
 * as argv arrays (never shell strings), under one caller-owned AbortSignal. It
 * validates both manifests before returning so the upload worker can promote
 * the render and structural output as one immutable artifact.
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
  | "render_manifest_invalid"
  | "ingestion_failed"
  | "ocr_unavailable"
  | "ingestion_output_missing"
  | "ingestion_manifest_invalid"
  | "manifest_mismatch";

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

const PositionedElementShape = {
  element_id: z.string().min(1).max(128),
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
};

const StructuralElementSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...PositionedElementShape,
      kind: z.literal("text"),
      text: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...PositionedElementShape,
      kind: z.literal("table"),
      rows: z.array(z.array(z.string())),
    })
    .strict(),
  z
    .object({
      ...PositionedElementShape,
      kind: z.literal("image"),
      content_sha256: Sha256Schema,
      media_type: z.string().regex(/^image\/[a-z0-9.+-]+$/),
      pixel_width: z.number().int().positive().nullable(),
      pixel_height: z.number().int().positive().nullable(),
    })
    .strict(),
  z
    .object({
      ...PositionedElementShape,
      kind: z.literal("chart"),
      chart_type: z.string(),
      categories: z.array(z.string()),
      series: z.array(
        z
          .object({
            name: z.string(),
            values: z.array(z.string()),
          })
          .strict(),
      ),
    })
    .strict(),
]);

const StructuralSlideSchema = z
  .object({
    slide_key: SlideKeySchema,
    source_index: z.number().int().positive(),
    source_id: z.string().min(1).max(128),
    width_points: z.number().positive(),
    height_points: z.number().positive(),
    elements: z.array(StructuralElementSchema),
    warnings: z.array(
      z
        .object({
          code: ErrorCodeSchema,
          message: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export const IngestionJsonSchema = z
  .object({
    status: z.literal("completed"),
    job_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/),
    manifest_hash: Sha256Schema,
    manifest: z
      .object({
        schema_version: z.literal("1"),
        deck_id: DeckIdSchema,
        source_sha256: Sha256Schema,
        source_kind: z.enum(["pptx", "pdf"]),
        adapter_version: z.string().min(1).max(64),
        slides: z.array(StructuralSlideSchema).min(1),
        render_boundary: z
          .object({
            status: z.literal("not_performed"),
            renderer: z.null(),
            fidelity_verified: z.literal(false),
            reason: z.string(),
          })
          .strict(),
      })
      .strict()
      .superRefine((manifest, context) => {
        for (const [offset, slide] of manifest.slides.entries()) {
          if (slide.source_index !== offset + 1) {
            context.addIssue({
              code: "custom",
              path: ["slides", offset, "source_index"],
              message: "slides must have contiguous one-based source indices",
            });
          }
        }
        if (
          new Set(manifest.slides.map((slide) => slide.slide_key)).size !== manifest.slides.length
        ) {
          context.addIssue({
            code: "custom",
            path: ["slides"],
            message: "slide keys must be unique",
          });
        }
      }),
  })
  .strict();

export type IngestionJson = z.infer<typeof IngestionJsonSchema>;

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

  async function execute(
    cmd: readonly string[],
    signal: AbortSignal,
    operation: "render" | "ingestion",
  ): Promise<
    | { readonly ok: true; readonly stdout: CapturedOutput; readonly stderr: CapturedOutput }
    | { readonly ok: false; readonly result: RenderSubprocessResult }
  > {
    if (signal.aborted) {
      return {
        ok: false,
        result: { ok: false, code: "aborted", message: `${operation} subprocess was aborted` },
      };
    }

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
        result: {
          ok: false,
          code: "spawn_failed",
          message: `${operation} subprocess could not start: ${errorMessage(error)}`,
        },
      };
    }

    let resolveAbort!: () => void;
    const aborted = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    const onAbort = () => resolveAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    const captures = Promise.all([
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
    signal.removeEventListener("abort", onAbort);

    if (outcome.kind === "aborted") {
      process.kill();
      await process.exited.catch(() => 0);
      await captures;
      return {
        ok: false,
        result: {
          ok: false,
          code: "aborted",
          message: `${operation} subprocess was aborted before completion`,
        },
      };
    }

    const [stdout, stderr] = await captures;
    if (outcome.code !== 0) {
      const stderrText = describeCapture(stderr, limit);
      const stdoutText = describeCapture(stdout, limit);
      const ingestionFailureCode = /^error\[ocr_unavailable\]:/m.test(stderr.text)
        ? "ocr_unavailable"
        : "ingestion_failed";
      return {
        ok: false,
        result: {
          ok: false,
          code: operation === "render" ? "render_failed" : ingestionFailureCode,
          message:
            stderrText.length > 0
              ? `${operation} exited with code ${outcome.code}; stderr: ${stderrText}`
              : `${operation} exited with code ${outcome.code}; stdout: ${stdoutText}`,
        },
      };
    }
    return { ok: true, stdout, stderr };
  }

  async function readJson(
    path: string,
    missingCode: "render_output_missing" | "ingestion_output_missing",
    invalidCode: "render_manifest_invalid" | "ingestion_manifest_invalid",
    label: string,
  ): Promise<
    | { readonly ok: true; readonly value: unknown }
    | {
        readonly ok: false;
        readonly result: Extract<RenderSubprocessResult, { readonly ok: false }>;
      }
  > {
    let payload: string;
    try {
      payload = await readFile(path, "utf8");
    } catch (error) {
      return {
        ok: false,
        result: {
          ok: false,
          code: missingCode,
          message: `${label} subprocess exited 0 but ${path} could not be read: ${errorMessage(error)}`,
        },
      };
    }
    try {
      return { ok: true, value: JSON.parse(payload) };
    } catch (error) {
      return {
        ok: false,
        result: {
          ok: false,
          code: invalidCode,
          message: `${label} output is not valid JSON: ${errorMessage(error)}`,
        },
      };
    }
  }

  async function run(
    request: RenderSubprocessRequest,
    signal: AbortSignal,
  ): Promise<RenderSubprocessResult> {
    const render = await execute(
      [
        "uv",
        "run",
        "--project",
        options.ingestionProject,
        "impromptu-ingestion",
        "render",
        request.sourcePath,
        "--output-dir",
        request.outputDir,
      ],
      signal,
      "render",
    );
    if (!render.ok) return render.result;

    const renderPayload = await readJson(
      join(request.outputDir, "render.json"),
      "render_output_missing",
      "render_manifest_invalid",
      "render",
    );
    if (!renderPayload.ok) return renderPayload.result;
    const validatedRender = RenderJsonSchema.safeParse(renderPayload.value);
    if (!validatedRender.success) {
      return {
        ok: false,
        code: "render_manifest_invalid",
        message: `render.json is not a valid render manifest: ${zodSummary(validatedRender.error)}`,
      };
    }

    const ingestionPath = join(request.outputDir, "ingestion.json");
    const ingestion = await execute(
      [
        "uv",
        "run",
        "--project",
        options.ingestionProject,
        "impromptu-ingestion",
        "ingest",
        request.sourcePath,
        "--job-id",
        "production_ingest",
        "--output",
        ingestionPath,
      ],
      signal,
      "ingestion",
    );
    if (!ingestion.ok) return ingestion.result;

    const ingestionPayload = await readJson(
      ingestionPath,
      "ingestion_output_missing",
      "ingestion_manifest_invalid",
      "ingestion",
    );
    if (!ingestionPayload.ok) return ingestionPayload.result;
    const validatedIngestion = IngestionJsonSchema.safeParse(ingestionPayload.value);
    if (!validatedIngestion.success) {
      return {
        ok: false,
        code: "ingestion_manifest_invalid",
        message: `ingestion.json is not a valid structural manifest: ${zodSummary(validatedIngestion.error)}`,
      };
    }

    const renderManifest = validatedRender.data;
    const ingestionManifest = validatedIngestion.data;
    const renderIndices = renderManifest.slides.map((slide) => slide.source_index);
    const structuralIndices = ingestionManifest.manifest.slides.map((slide) => slide.source_index);
    if (
      renderManifest.deck_id !== ingestionManifest.manifest.deck_id ||
      renderManifest.deck_id !== `deck_${ingestionManifest.manifest.source_sha256}` ||
      renderIndices.length !== structuralIndices.length ||
      renderIndices.some((sourceIndex, offset) => sourceIndex !== structuralIndices[offset])
    ) {
      return {
        ok: false,
        code: "manifest_mismatch",
        message: "render.json and ingestion.json do not describe the same ordered source deck",
      };
    }

    return {
      ok: true,
      renderManifest,
      ingestionManifest,
    };
  }

  return { run };
}
