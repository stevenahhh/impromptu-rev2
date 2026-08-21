import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RetrievalRequestSchema } from "@impromptu/contracts/retrieval";
import type { Sql } from "postgres";
import { PostgresDeckRetrievalStore } from "../src/retrieval/postgres-deck-retrieval.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeSql() {
  const rows: Record<string, unknown>[] = [];
  const queries: string[] = [];
  let failFts = false;
  const sql = (first: unknown, ...values: unknown[]) => {
    if (!Array.isArray(first) || !Object.hasOwn(first, "raw")) return first;
    const query = (first as unknown as TemplateStringsArray).join("?").replace(/\s+/g, " ").trim();
    queries.push(query);
    if (query.startsWith("WITH lexical AS")) {
      if (failFts) throw new Error("injected FTS failure");
      const search = String(values[0]).toLocaleLowerCase();
      const tenantId = values[1];
      const ids = values[2] as readonly string[];
      return Promise.resolve(
        rows
          .filter(
            (row) =>
              row.tenant_id === tenantId &&
              ids.includes(String(row.object_id)) &&
              String(row.content).toLocaleLowerCase().includes(search),
          )
          .map((row) => ({ ...row, lexical_score: 1 })),
      );
    }
    if (query.startsWith("INSERT INTO private_app.deck_retrieval_chunks")) {
      rows.push({
        tenant_id: values[0],
        object_id: values[1],
        source_id: values[2],
        source_revision: values[3],
        source_hash: values[4],
        deck_version: values[5],
        manifest_hash: values[6],
        title: values[7],
        anchor: values[8],
        content: values[9],
        embedding: values[10],
        authorization_version: values[11],
      });
      return Promise.resolve([]);
    }
    if (query.startsWith("SELECT object_id") && query.includes("AND object_id =")) {
      return Promise.resolve(
        rows.filter((row) => row.tenant_id === values[0] && row.object_id === values[1]),
      );
    }
    if (query.startsWith("SELECT object_id")) {
      return Promise.resolve(
        rows.filter(
          (row) =>
            row.tenant_id === values[0] &&
            row.deck_version === values[1] &&
            row.manifest_hash === values[2] &&
            row.authorization_version === values[3],
        ),
      );
    }
    if (query.startsWith("SELECT *") && query.includes("object_id IN")) {
      const ids = values[1] as readonly string[];
      return Promise.resolve(
        rows.filter((row) => row.tenant_id === values[0] && ids.includes(String(row.object_id))),
      );
    }
    if (query.startsWith("SELECT *")) {
      return Promise.resolve(
        rows.filter((row) => row.tenant_id === values[0] && row.object_id === values[1]),
      );
    }
    throw new Error(`Unexpected SQL: ${query}`);
  };
  Object.assign(sql, { array: (value: unknown) => value });
  return {
    sql: sql as unknown as Sql,
    rows,
    queries,
    failFts: () => {
      failFts = true;
    },
    recoverFts: () => {
      failFts = false;
    },
  };
}

describe("PostgreSQL deck corpus retrieval", () => {
  test("indexes structural manifest text for a PNG-rendered PDF and ranks only the requested deck", async () => {
    const root = mkdtempSync(join(tmpdir(), "deck-corpus-"));
    roots.push(root);
    const artifact = join(root, "artifact-1");
    mkdirSync(join(artifact, "slides"), { recursive: true });
    const deckHash = "a".repeat(64);
    const slideHash = "b".repeat(64);
    const slideKey = `slide_${"c".repeat(64)}`;
    const manifest = {
      deck_id: `deck_${deckHash}`,
      renderer: { name: "libreoffice", version: "7.6" },
      slides: [
        {
          slide_key: slideKey,
          source_index: 1,
          relative_path: "slides/slide-1.png",
          content_sha256: slideHash,
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
    };
    writeFileSync(join(artifact, "render.json"), JSON.stringify(manifest));
    writeFileSync(
      join(artifact, "ingestion.json"),
      JSON.stringify({
        status: "completed",
        job_id: "production_ingest",
        manifest_hash: "d".repeat(64),
        manifest: {
          schema_version: "1",
          deck_id: manifest.deck_id,
          source_sha256: deckHash,
          source_kind: "pdf",
          adapter_version: "pymupdf-structural-v2",
          slides: [
            {
              slide_key: slideKey,
              source_index: 1,
              source_id: "page:1",
              width_points: 960,
              height_points: 540,
              elements: [
                {
                  kind: "text",
                  element_id: "text:1:1:1",
                  x: 0,
                  y: 0,
                  width: 100,
                  height: 20,
                  text: "<date/time> Actual revenue & margin 올리고 . 연결하고 . PPTX / PDF <footer> <number>",
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
      }),
    );
    const manifestHash = createHash("sha256")
      .update(`render-manifest:${manifest.deck_id}:${slideHash}`)
      .digest("hex");
    const database = fakeSql();
    const embedded: string[] = [];
    const indexEvents: Record<string, unknown>[] = [];
    const store = new PostgresDeckRetrievalStore({
      sql: database.sql,
      artifactRoot: root,
      access: {
        async authorize() {
          return true;
        },
      },
      embedding: {
        async embed(text) {
          embedded.push(text);
          return [1, 0];
        },
      },
      logger: {
        log(event) {
          indexEvents.push(event);
        },
      },
    });
    const principal = {
      tenantId: "tenant-1",
      principalId: "principal-1",
      groupIds: [],
      attributes: {},
    };
    const request = RetrievalRequestSchema.parse({
      query: "revenue",
      deckVersion: `deck_${deckHash}`,
      manifestHash,
      maxResults: 3,
    });

    await store.prepare(principal, request);
    await store.prepare(principal, request);
    const authorization = await store.prefilter(principal, request);
    const candidates = await store.search({
      tenantId: principal.tenantId,
      query: request.query,
      queryVector: [1, 0],
      authorizedObjectIds: authorization.authorizedObjectIds,
      limit: 3,
    });
    const metadata = await store.readMetadata(
      principal.tenantId,
      authorization.authorizedObjectIds[0] ?? "missing",
    );
    const content = await store.readContent(
      principal.tenantId,
      authorization.authorizedObjectIds[0] ?? "missing",
    );

    expect(embedded).toEqual(["Actual revenue & margin 올리고. 연결하고. PPTX/PDF"]);
    expect(database.rows).toHaveLength(1);
    expect(database.rows[0]?.source_revision).toBe(deckHash);
    expect(database.queries).toContainEqual(expect.stringContaining("?::double precision[]"));
    expect(indexEvents).toEqual([
      expect.objectContaining({ outcome: "INDEXED", reason: "COMPLETED", indexedChunkCount: 1 }),
      expect.objectContaining({
        outcome: "SKIPPED",
        reason: "ALREADY_INDEXED",
        indexedChunkCount: 0,
      }),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.score).toBeCloseTo(2 / 61);
    expect(metadata).toMatchObject({
      deckVersion: request.deckVersion,
      manifestHash,
      rights: "APPROVED",
      containsPii: false,
    });
    expect(content).toBe("Actual revenue & margin 올리고. 연결하고. PPTX/PDF");
  });

  test("fuses deterministic Korean lexical and semantic candidates and degrades one side", async () => {
    const database = fakeSql();
    const diagnostics: Record<string, unknown>[] = [];
    const common = {
      tenant_id: "tenant-hybrid",
      source_revision: "f".repeat(64),
      deck_version: `deck_${"f".repeat(64)}`,
      manifest_hash: "e".repeat(64),
      authorization_version: "acl-1",
      title: "Hybrid fixture",
    };
    const exact = {
      ...common,
      object_id: "object-exact",
      source_id: "slide-exact",
      source_hash: "a".repeat(64),
      anchor: "slide=1&chunk=1",
      content: "정확용어 영업이익률",
      embedding: [0, 1],
    };
    const duplicateExact = {
      ...exact,
      object_id: "object-exact-copy",
      source_hash: "c".repeat(64),
    };
    const semantic = {
      ...common,
      object_id: "object-semantic",
      source_id: "slide-semantic",
      source_hash: "b".repeat(64),
      anchor: "slide=2&chunk=1",
      content: "매출에서 비용을 제외한 비율",
      embedding: [1, 0],
    };
    database.rows.push(semantic, duplicateExact, exact);
    const store = new PostgresDeckRetrievalStore({
      sql: database.sql,
      artifactRoot: "/unused",
      access: {
        async authorize() {
          return true;
        },
      },
      embedding: {
        async embed() {
          return [1, 0];
        },
      },
      retrievalDiagnostics: {
        observe(diagnostic) {
          diagnostics.push(diagnostic);
        },
      },
    });
    const search = (queryVector: readonly number[]) =>
      store.search({
        tenantId: common.tenant_id,
        query: "영업이익률",
        queryVector,
        authorizedObjectIds: [exact.object_id, semantic.object_id, duplicateExact.object_id],
        limit: 20,
      });

    const first = await search([1, 0]);
    database.rows.reverse();
    const reordered = await search([1, 0]);
    expect(reordered).toEqual(first);
    expect(new Set(first.map((candidate) => candidate.objectId))).toEqual(
      new Set(["object-exact", "object-semantic"]),
    );

    database.failFts();
    const denseOnly = await search([1, 0]);
    expect(denseOnly.map((candidate) => candidate.objectId)).toEqual([
      "object-semantic",
      "object-exact",
    ]);
    database.recoverFts();
    const lexicalOnly = await search([]);
    expect(lexicalOnly.map((candidate) => candidate.objectId)).toEqual(["object-exact"]);
    expect(diagnostics).toEqual([
      { retriever: "LEXICAL", failure: "FTS_EXECUTION_FAILED", errorType: "Error" },
      { retriever: "DENSE", failure: "EMBEDDING_FAILED", errorType: "InvalidQueryEmbedding" },
    ]);
  });

  test("does not scan or expose a deck that the current tenant does not own", async () => {
    const root = mkdtempSync(join(tmpdir(), "deck-corpus-denied-"));
    roots.push(root);
    const database = fakeSql();
    let embedded = false;
    const indexEvents: Record<string, unknown>[] = [];
    const store = new PostgresDeckRetrievalStore({
      sql: database.sql,
      artifactRoot: root,
      access: {
        async authorize() {
          return false;
        },
      },
      embedding: {
        async embed() {
          embedded = true;
          return [1];
        },
      },
      logger: {
        log(event) {
          indexEvents.push(event);
        },
      },
    });
    const principal = {
      tenantId: "tenant-2",
      principalId: "principal-2",
      groupIds: [],
      attributes: {},
    };
    const request = RetrievalRequestSchema.parse({
      query: "other tenant deck",
      deckVersion: `deck_${"d".repeat(64)}`,
      manifestHash: "e".repeat(64),
      maxResults: 3,
    });

    await store.prepare(principal, request);
    const authorization = await store.prefilter(principal, request);

    expect(embedded).toBe(false);
    expect(database.rows).toEqual([]);
    expect(authorization.authorizedObjectIds).toEqual([]);
    expect(indexEvents).toEqual([
      expect.objectContaining({ outcome: "SKIPPED", reason: "ACCESS_DENIED" }),
    ]);
  });
});
