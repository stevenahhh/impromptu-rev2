/**
 * Contract for the authenticated deck upload service.
 *
 * Intended module: services/private-backend/src/deck-upload-service.ts.
 *
 * The service is the only production path between the private HTTP boundary
 * and the real upload worker / render subprocess chain:
 *
 *   acceptRawDeck(input) consumes input.upload.body strictly as a stream via
 *   createDeckUploadWorker.processUpload (never buffering or arrayBuffer-ing
 *   it), runs the render through createDeckRenderSubprocess, builds
 *   publicBaseUrl = `${projectionGatewayOrigin}/v1/deck-assets/<artifactId>`
 *   from the worker's RENDERED artifactId, and calls renderedDeckArtifacts
 *   with the strict render manifest and a title derived from the file name.
 *   The returned receipt is structurally the DeckUploadReceipt consumed by
 *   http.ts: { privateDeck, publicDeck, sourceHash }.
 *
 * A REJECTED worker outcome (empty/malformed/unsafe/oversized upload) throws a
 * typed DeckUploadRejectedError without ever invoking the renderer.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateDeckContextSchema } from "@impromptu/contracts/private";
import { PublishedDeckArtifactSchema } from "@impromptu/contracts/public";
import {
  createDeckAssetReader,
  createProjectionGatewayHandler,
  PreparedEvidenceProjectionGateway,
  parseProjectionGatewayConfig,
} from "@impromptu/projection-gateway";
import {
  createDeckRenderSubprocess,
  type RenderSpawn,
  type RenderSpawnedProcess,
  type RenderSpawnOptions,
} from "../src/deck-render-subprocess.ts";
import { createDeckUploadService, DeckUploadRejectedError } from "../src/deck-upload-service.ts";
import { createDeckUploadWorker } from "../src/deck-upload-worker.ts";
import type { DeckUploadReceipt, DeckUploadService, RawDeckUpload } from "../src/http.ts";

const PROJECTION_GATEWAY_ORIGIN = "https://projection.example.test";
const ACCOUNT_ID = "account_deck_service";
const ACTOR_ID = "actor_deck_service";
const INGESTION_PROJECT = "/repo/services/ingestion";

const PPTX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const PPTX_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);

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
  fonts: [],
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
        elements: [],
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

const SLIDE_SVG = "<svg xmlns='http://www.w3.org/2000/svg'/>";

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

/** The real subprocess adapter with an injectable spawn; writes a valid render.json. */
function realSubprocess(
  renderJson: unknown = VALID_RENDER_JSON,
  ingestionJson: unknown = VALID_INGESTION_JSON,
) {
  const spawnCalls: RenderSpawnOptions[] = [];
  const spawn: RenderSpawn = (options) => {
    spawnCalls.push(options);
    if (options.cmd.includes("render")) {
      const outputDirIndex = options.cmd.indexOf("--output-dir");
      const outputDir = options.cmd[outputDirIndex + 1];
      if (outputDirIndex !== -1 && outputDir !== undefined) {
        mkdirSync(outputDir, { recursive: true });
        mkdirSync(join(outputDir, "slides"), { recursive: true });
        writeFileSync(join(outputDir, "render.json"), `${JSON.stringify(renderJson)}\n`);
        writeFileSync(join(outputDir, "slides", "slide-1.svg"), SLIDE_SVG);
      }
    } else {
      const outputIndex = options.cmd.indexOf("--output");
      const output = options.cmd[outputIndex + 1];
      if (outputIndex !== -1 && output !== undefined) {
        writeFileSync(output, `${JSON.stringify(ingestionJson)}\n`);
      }
    }
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const process: RenderSpawnedProcess = {
      exited,
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      kill() {
        resolveExit(143);
      },
    };
    queueMicrotask(() => resolveExit(0));
    return process;
  };
  return {
    adapter: createDeckRenderSubprocess({ ingestionProject: INGESTION_PROJECT, spawn }),
    spawnCalls,
  };
}

function streamedUpload(filename: string, body: Uint8Array): RawDeckUpload {
  return {
    filename,
    contentType: PPTX_CONTENT_TYPE,
    byteLength: body.byteLength,
    body: chunkedStream([body]),
  };
}

describe("deck upload service", () => {
  let stagingRoot: string;
  let artifactRoot: string;
  let subprocess: ReturnType<typeof realSubprocess>;

  beforeEach(() => {
    stagingRoot = mkdtempSync(join(tmpdir(), "deck-upload-service-staging-"));
    artifactRoot = mkdtempSync(join(tmpdir(), "deck-upload-service-artifacts-"));
    subprocess = realSubprocess();
  });

  afterEach(() => {
    rmSync(stagingRoot, { recursive: true, force: true });
    rmSync(artifactRoot, { recursive: true, force: true });
  });

  function service(): DeckUploadService {
    return createDeckUploadService({
      projectionGatewayOrigin: PROJECTION_GATEWAY_ORIGIN,
      worker: createDeckUploadWorker({
        subprocess: subprocess.adapter,
        stagingRoot,
        artifactRoot,
        deadlineMs: 5_000,
      }),
    });
  }

  test("renders a streamed upload into matching private/public decks and the http.ts receipt", async () => {
    const receipt: DeckUploadReceipt = await service().acceptRawDeck({
      accountId: ACCOUNT_ID,
      actorId: ACTOR_ID,
      upload: streamedUpload("quarterly-review.pptx", PPTX_MAGIC),
    });

    // The receipt is exactly what /v1/deck-uploads consumes.
    expect(receipt.privateDeck).toBeDefined();
    expect(receipt.publicDeck).toBeDefined();
    expect(receipt.sourceHash).toBe("a".repeat(64));

    const privateDeck = PrivateDeckContextSchema.parse(receipt.privateDeck);
    const publicDeck = PublishedDeckArtifactSchema.parse(receipt.publicDeck);
    expect(String(privateDeck.ownerAccountId)).toBe(ACCOUNT_ID);
    expect(privateDeck.deckVersion).toBe(publicDeck.deckVersion);
    expect(privateDeck.manifestHash).toBe(publicDeck.manifestHash);
    expect(privateDeck.title).toBe("Quarterly review");
    expect(publicDeck.title).toBe("Quarterly review");
    expect(publicDeck.slides).toHaveLength(1);

    // The artifact the worker promoted is the one the public deck points at.
    const artifactIds = readdirSync(artifactRoot).filter((entry) => !entry.endsWith(".part"));
    expect(artifactIds).toHaveLength(1);
    const artifactId = artifactIds[0];
    if (artifactId === undefined) throw new Error("expected exactly one promoted artifact");
    expect(artifactId).toMatch(/^[0-9a-f]{64}$/);
    expect(publicDeck.slides[0]?.image.url).toBe(
      `${PROJECTION_GATEWAY_ORIGIN}/v1/deck-assets/${artifactId}/slides/slide-1.svg`,
    );
    expect(publicDeck.slides[0]?.image.contentHash).toBe("c".repeat(64));
    expect(readFileSync(join(artifactRoot, artifactId, "render.json"), "utf8")).toBe(
      `${JSON.stringify(VALID_RENDER_JSON)}\n`,
    );
    expect(readFileSync(join(artifactRoot, artifactId, "slides", "slide-1.svg"), "utf8")).toBe(
      SLIDE_SVG,
    );
    expect(
      JSON.parse(readFileSync(join(artifactRoot, artifactId, "ingestion.json"), "utf8")),
    ).toEqual(VALID_INGESTION_JSON);

    const publicAssetHandler = createProjectionGatewayHandler(
      parseProjectionGatewayConfig({ STAGE_ORIGIN: "https://stage.example.test" }),
      {
        gateway: new PreparedEvidenceProjectionGateway(),
        internalAuthToken: "internal-test-token-alpha",
        now: () => 1_000,
        stageReceiptWriter: {
          async recordApplied() {
            return null;
          },
        },
        deckAssets: createDeckAssetReader(artifactRoot),
      },
    );
    const emittedAsset = await publicAssetHandler(
      new Request(publicDeck.slides[0]?.image.url ?? ""),
    );
    expect(emittedAsset.status).toBe(200);
    expect(emittedAsset.headers.get("content-type")).toBe("image/svg+xml");
    expect(await emittedAsset.text()).toBe(SLIDE_SVG);
    expect(readdirSync(stagingRoot)).toEqual([]);

    // The render went through the real subprocess adapter argv contract.
    expect(subprocess.spawnCalls).toHaveLength(2);
    expect(subprocess.spawnCalls[0]?.cmd).toEqual([
      "uv",
      "run",
      "--project",
      INGESTION_PROJECT,
      "impromptu-ingestion",
      "render",
      expect.stringContaining("upload"),
      "--output-dir",
      expect.any(String),
    ]);
    expect(subprocess.spawnCalls[1]?.cmd).toEqual([
      "uv",
      "run",
      "--project",
      INGESTION_PROJECT,
      "impromptu-ingestion",
      "ingest",
      expect.stringContaining("upload"),
      "--job-id",
      "production_ingest",
      "--output",
      expect.stringContaining("ingestion.json"),
    ]);
  });

  test("derives the deck title from the uploaded file name", async () => {
    const PDF_MAGIC = new TextEncoder().encode("%PDF-1.7\n");
    for (const [filename, expectedTitle] of [
      ["quarterly-review.pptx", "Quarterly review"],
      ["handout.pdf", "Handout"],
      ["deck_v2.PDF", "Deck v2"],
      ["Q3 board deck.pptx", "Q3 board deck"],
      ["presentation..pptx", "Presentation."],
    ] as const) {
      const body = filename.toLowerCase().endsWith(".pdf") ? PDF_MAGIC : PPTX_MAGIC;
      const receipt = await service().acceptRawDeck({
        accountId: ACCOUNT_ID,
        actorId: ACTOR_ID,
        upload: streamedUpload(filename, body),
      });
      expect(receipt.privateDeck.title).toBe(expectedTitle);
    }
  });

  test("throws a typed error on a rejected body without invoking the renderer", async () => {
    const badBody = new TextEncoder().encode("this is not a zip container");
    await expect(
      service().acceptRawDeck({
        accountId: ACCOUNT_ID,
        actorId: ACTOR_ID,
        upload: streamedUpload("broken.pptx", badBody),
      }),
    ).rejects.toBeInstanceOf(DeckUploadRejectedError);
    await expect(
      service().acceptRawDeck({
        accountId: ACCOUNT_ID,
        actorId: ACTOR_ID,
        upload: streamedUpload("broken.pptx", badBody),
      }),
    ).rejects.toMatchObject({ code: "malformed_input" });
    expect(subprocess.spawnCalls).toHaveLength(0);
    expect(readdirSync(stagingRoot)).toEqual([]);
    expect(readdirSync(artifactRoot).filter((entry) => !entry.endsWith(".part"))).toEqual([]);
  });

  test("throws a typed error when the declared length disagrees with the streamed body", async () => {
    await expect(
      service().acceptRawDeck({
        accountId: ACCOUNT_ID,
        actorId: ACTOR_ID,
        upload: {
          filename: "sized.pptx",
          contentType: PPTX_CONTENT_TYPE,
          byteLength: PPTX_MAGIC.byteLength + 10,
          body: chunkedStream([PPTX_MAGIC]),
        },
      }),
    ).rejects.toMatchObject({ code: "size_mismatch" });
    expect(subprocess.spawnCalls).toHaveLength(0);
  });

  test("propagates render or structural failure with no partial artifact residue", async () => {
    subprocess = realSubprocess({ not: "a valid render manifest" });
    await expect(
      service().acceptRawDeck({
        accountId: ACCOUNT_ID,
        actorId: ACTOR_ID,
        upload: streamedUpload("quarterly-review.pptx", PPTX_MAGIC),
      }),
    ).rejects.toThrow();
    expect(readdirSync(artifactRoot).filter((entry) => !entry.endsWith(".part"))).toEqual([]);
    expect(readdirSync(stagingRoot)).toEqual([]);

    subprocess = realSubprocess(VALID_RENDER_JSON, { not: "a valid structural manifest" });
    await expect(
      service().acceptRawDeck({
        accountId: ACCOUNT_ID,
        actorId: ACTOR_ID,
        upload: streamedUpload("quarterly-review.pptx", PPTX_MAGIC),
      }),
    ).rejects.toThrow();
    expect(readdirSync(artifactRoot)).toEqual([]);
    expect(readdirSync(stagingRoot)).toEqual([]);
  });
});
