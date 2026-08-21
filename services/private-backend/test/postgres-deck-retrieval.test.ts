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
  const sql = (first: unknown, ...values: unknown[]) => {
    if (!Array.isArray(first) || !Object.hasOwn(first, "raw")) return first;
    const query = (first as unknown as TemplateStringsArray).join("?").replace(/\s+/g, " ").trim();
    queries.push(query);
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
  return { sql: sql as unknown as Sql, rows, queries };
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
    expect(candidates[0]?.score).toBe(1);
    expect(metadata).toMatchObject({
      deckVersion: request.deckVersion,
      manifestHash,
      rights: "APPROVED",
      containsPii: false,
    });
    expect(content).toBe("Actual revenue & margin 올리고. 연결하고. PPTX/PDF");
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
