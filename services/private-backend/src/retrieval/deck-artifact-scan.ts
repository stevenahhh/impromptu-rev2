import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type IngestionJson,
  IngestionJsonSchema,
  RenderJsonSchema,
} from "../deck-render-subprocess.ts";
import {
  AUTHORIZATION_VERSION,
  type RetrievalRowWithoutEmbedding,
} from "./deck-retrieval-model.ts";
import { chunkText, extractStructuralText } from "./deck-slide-text.ts";

export type DeckArtifactScan = Readonly<{
  pendingRows: ReadonlyMap<string, RetrievalRowWithoutEmbedding>;
  matchingArtifactCount: number;
  skippedArtifactCount: number;
  skippedSlideCount: number;
  extractableChunkCount: number;
}>;

export async function scanDeckArtifacts(
  options: {
    readonly artifactRoot: string;
    readonly tenantId: string;
    readonly deckVersion: string;
    readonly manifestHash: string;
  },
  artifactIds: readonly string[],
): Promise<DeckArtifactScan> {
  const pendingRows = new Map<string, RetrievalRowWithoutEmbedding>();
  let matchingArtifactCount = 0;
  let skippedArtifactCount = 0;
  let skippedSlideCount = 0;
  let extractableChunkCount = 0;
  for (const artifactId of artifactIds) {
    if (artifactId.endsWith(".part")) {
      skippedArtifactCount += 1;
      continue;
    }
    const artifactDir = join(options.artifactRoot, artifactId);
    let renderManifest: ReturnType<typeof RenderJsonSchema.parse>;
    let ingestion: IngestionJson;
    try {
      renderManifest = RenderJsonSchema.parse(
        JSON.parse(await readFile(join(artifactDir, "render.json"), "utf8")),
      );
      ingestion = IngestionJsonSchema.parse(
        JSON.parse(await readFile(join(artifactDir, "ingestion.json"), "utf8")),
      );
    } catch {
      skippedArtifactCount += 1;
      continue;
    }
    const orderedRenderSlides = [...renderManifest.slides].sort(
      (left, right) => left.source_index - right.source_index,
    );
    const orderedStructuralSlides = [...ingestion.manifest.slides].sort(
      (left, right) => left.source_index - right.source_index,
    );
    const sourceDeckHash = renderManifest.deck_id.replace(/^deck_/, "");
    const deckVersion = `deck_${sourceDeckHash}`;
    const manifestHash = createHash("sha256")
      .update(
        `render-manifest:${renderManifest.deck_id}:${orderedRenderSlides.map((slide) => slide.content_sha256).join(":")}`,
        "utf8",
      )
      .digest("hex");
    if (
      deckVersion !== options.deckVersion ||
      manifestHash !== options.manifestHash ||
      renderManifest.deck_id !== ingestion.manifest.deck_id ||
      renderManifest.deck_id !== `deck_${ingestion.manifest.source_sha256}` ||
      orderedRenderSlides.length !== orderedStructuralSlides.length ||
      orderedRenderSlides.some(
        (slide, offset) => slide.source_index !== orderedStructuralSlides[offset]?.source_index,
      )
    ) {
      skippedArtifactCount += 1;
      continue;
    }
    matchingArtifactCount += 1;

    for (const slide of orderedStructuralSlides) {
      const chunks = chunkText(extractStructuralText(slide.elements));
      if (chunks.length === 0) skippedSlideCount += 1;
      extractableChunkCount += chunks.length;
      for (const [offset, content] of chunks.entries()) {
        const sourceHash = createHash("sha256").update(content, "utf8").digest("hex");
        const objectId = createHash("sha256")
          .update(`${options.tenantId}:${deckVersion}:${slide.slide_key}:${offset}:${sourceHash}`)
          .digest("hex");
        pendingRows.set(objectId, {
          tenant_id: options.tenantId,
          object_id: objectId,
          source_id: slide.source_id,
          source_revision: ingestion.manifest.source_sha256,
          source_hash: sourceHash,
          deck_version: deckVersion,
          manifest_hash: manifestHash,
          title: `Slide ${slide.source_index}`,
          anchor: `slide=${slide.source_index}&chunk=${offset + 1}`,
          content,
          authorization_version: AUTHORIZATION_VERSION,
        });
      }
    }
  }
  return {
    pendingRows,
    matchingArtifactCount,
    skippedArtifactCount,
    skippedSlideCount,
    extractableChunkCount,
  };
}
