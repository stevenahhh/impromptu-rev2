/**
 * Indexes the freshly uploaded task-43 fixtures through the real
 * PostgresDeckRetrievalStore.prepare() path and records the indexed chunks.
 *
 * Evidence-only harness. Embeddings come from the same local embeddinggemma
 * endpoint the dev stack uses; writes go through the production tenant-scoped
 * repository (transaction-local set_config('app.tenant_id', ...)), and the
 * verification read re-opens a tenant RLS context explicitly.
 */
import { SQL } from "bun";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const EVIDENCE = import.meta.dir;

import { join, resolve } from "node:path";
import { PostgresDeckRetrievalStore } from "../../../services/private-backend/src/retrieval/postgres-deck-retrieval.ts";
import { createTenantScopedPostgresRepository } from "../../../services/private-backend/src/retrieval/tenant-scoped-postgres-repository.ts";
import type { RetrievalPrincipal } from "../../../services/private-backend/src/retrieval/internal-retrieval.ts";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const postgres = require("../../../services/private-backend/node_modules/postgres") as typeof import("postgres");

interface Receipt {
  readonly status: number;
  readonly response: {
    readonly deckVersion?: string;
    readonly privateDeck?: { readonly manifestHash?: string };
  };
}

const DATABASE_URL =
  "postgresql://impromptu_bootstrap@127.0.0.1:5432/impromptu_private";
const ARTIFACT_ROOT = "/tmp/task43-deck-artifacts";
const TENANT_ID = "account_local_demo";

function embedWithLocalModel(text: string): readonly number[] {
  const payload = JSON.stringify({ model: "embeddinggemma", input: text });
  const stdout = execFileSync(
    "curl",
    [
      "-sk",
      "--max-time",
      "30",
      "https://127.0.0.1:8443/v1/embeddings",
      "-H",
      "content-type: application/json",
      "-d",
      payload,
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout) as {
    data?: readonly { embedding?: readonly number[] }[];
  };
  const vector = parsed.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error("local embedding endpoint returned no vector");
  }
  return vector;
}

async function main(): Promise<number> {
  const receipts = JSON.parse(
    await readFile(join(EVIDENCE, "upload-receipts.json"), "utf8"),
  ) as Record<string, Receipt>;

  const sql = postgres(DATABASE_URL, { max: 2 });
  const repository = createTenantScopedPostgresRepository(sql);
  const store = new PostgresDeckRetrievalStore({
    repository,
    artifactRoot: ARTIFACT_ROOT,
    // The upload boundary already enforced ownership (ownerAccountId is part of
    // the accepted private deck); this harness indexes exactly those uploads.
    access: { authorize: async () => true },
    embedding: {
      async embed(text) {
        return embedWithLocalModel(text);
      },
    },
    logger: {
      log(event) {
        console.log(
          `[index] ${event.outcome}:${event.reason} chunks=${event.indexedChunkCount} slides=${event.extractableChunkCount}`,
        );
      },
    },
  });

  const principal: RetrievalPrincipal = {
    tenantId: TENANT_ID,
    principalId: `${TENANT_ID}-actor`,
    groupIds: [],
    attributes: { role: "controller" },
  };

  const results: Record<
    string,
    {
      readonly deckVersion: string;
      readonly manifestHash: string;
      readonly chunks: readonly {
        readonly anchor: string;
        readonly title: string;
        readonly length: number;
        readonly content: string;
      }[];
    }
  > = {};

  for (const filename of ["korean-text-layer.pdf", "korean-structural.pptx"]) {
    const receipt = receipts[filename].response;
    const deckVersion = receipt.deckVersion ?? "";
    const manifestHash = receipt.privateDeck?.manifestHash ?? "";
    if (deckVersion.length === 0 || manifestHash.length === 0) {
      throw new Error(`${filename}: receipt lacks deckVersion or manifestHash`);
    }
    await store.prepare(principal, {
      query: "2026년 매출 실적과 구독 사업 지표",
      deckVersion,
      manifestHash,
      maxResults: 3,
    });

    // Verification read under an explicit transaction-local tenant context.
    const chunks = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${TENANT_ID}, true)`;
      return tx`
        SELECT anchor, title, content
        FROM private_app.deck_retrieval_chunks
        WHERE tenant_id = ${TENANT_ID} AND deck_version = ${deckVersion}
        ORDER BY anchor
      `;
    });
    results[filename] = {
      deckVersion,
      manifestHash,
      chunks: chunks.map((row) => ({
        anchor: row.anchor,
        title: row.title,
        length: [...row.content].length,
        content: row.content,
      })),
    };
    console.log(`${filename}: ${chunks.length} chunks`);
  }

  // Also demonstrate that without a tenant context the RLS-scoped table hides rows.
  const anonymousCount = await sql`
    SELECT count(*)::int AS count FROM private_app.deck_retrieval_chunks
  `.then((rows) => rows[0]?.count);

  const pdfChunks = results["korean-text-layer.pdf"].chunks;
  const pptxChunks = results["korean-structural.pptx"].chunks;
  const identity = {
    sameChunkCount: pdfChunks.length === pptxChunks.length,
    identicalContents: pdfChunks
      .map((chunk) => chunk.content)
      .join("\u0000") === pptxChunks.map((chunk) => chunk.content).join("\u0000"),
  };

  await writeFile(
    join(EVIDENCE, "chunk-evidence.json"),
    `${JSON.stringify({ schemaVersion: 1, tenantId: TENANT_ID, anonymousRowCountWithoutTenantContext: anonymousCount, identity, results }, null, 2)}\n`,
  );

  const bootstrapProbe = new SQL(DATABASE_URL);
  try {
    const bypass = await bootstrapProbe`
      SELECT count(*)::int AS count FROM private_app.deck_retrieval_chunks
      WHERE deck_version IN (${results["korean-text-layer.pdf"].deckVersion}, ${results["korean-structural.pptx"].deckVersion})
    `;
    console.log(`bootstrap-role count for both decks: ${bypass[0]?.count}`);
  } finally {
    await bootstrapProbe.close({ timeout: 1 }).catch(() => undefined);
  }

  await sql.end({ timeout: 1 });
  console.log(JSON.stringify(identity));
  return 0;
}

process.exitCode = await main();
