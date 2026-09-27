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
    if (query.startsWith("SELECT pg_advisory_xact_lock")) {
      // Serializes concurrent preparers of the same deck scope; the fake has one connection.
      return Promise.resolve([]);
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

describe("concurrent deck corpus preparation", () => {
  function fakeSqlWithTimeline(
    database: ReturnType<typeof fakeSql>,
    timeline: string[],
  ): ReturnType<typeof fakeSql>["sql"] {
    const inner = database.sql as unknown as (first: unknown, ...values: unknown[]) => unknown;
    const wrapper = ((first: unknown, ...values: unknown[]) => {
      if (Array.isArray(first) && Object.hasOwn(first, "raw")) {
        const query = (first as unknown as TemplateStringsArray)
          .join("?")
          .replace(/\s+/g, " ")
          .trim();
        if (query.startsWith("SELECT pg_advisory_xact_lock")) timeline.push("advisory-lock");
        if (query.startsWith("INSERT INTO private_app.deck_retrieval_chunks")) {
          timeline.push(`insert:${String(values[9]).slice(0, 12)}`);
        }
      }
      return inner(first, ...values);
    }) as unknown as ReturnType<typeof fakeSql>["sql"];
    Object.assign(wrapper, { array: (value: unknown) => value });
    return wrapper;
  }

  // Minimal render+ingestion fixture: one artifact, one text element per slide.
  function writeArtifact(root: string, deckHash: string, slideTexts: readonly string[]): string {
    const artifact = join(root, `artifact-${deckHash.slice(0, 8)}`);
    mkdirSync(join(artifact, "slides"), { recursive: true });
    const slides = slideTexts.map((text, index) => ({
      slide_key: `slide_${createHash("sha256").update(`${deckHash}:${index}`).digest("hex")}`,
      source_index: index + 1,
      relative_path: `slides/slide-${index + 1}.png`,
      content_sha256: createHash("sha256").update(text).digest("hex"),
      width_points: 960,
      height_points: 540,
    }));
    writeFileSync(
      join(artifact, "render.json"),
      JSON.stringify({
        deck_id: `deck_${deckHash}`,
        renderer: { name: "libreoffice", version: "7.6" },
        slides,
        assets: [],
        fonts: [],
        timelines: [],
        mapping_issues: [],
        animation_eligible: true,
        ineligible_reason: null,
      }),
    );
    writeFileSync(
      join(artifact, "ingestion.json"),
      JSON.stringify({
        status: "completed",
        job_id: "production_ingest",
        manifest_hash: "d".repeat(64),
        manifest: {
          schema_version: "1",
          deck_id: `deck_${deckHash}`,
          source_sha256: deckHash,
          source_kind: "pdf",
          adapter_version: "pymupdf-structural-v2",
          slides: slides.map((slide, index) => ({
            slide_key: slide.slide_key,
            source_index: slide.source_index,
            source_id: `page:${index + 1}`,
            width_points: 960,
            height_points: 540,
            elements: [
              {
                kind: "text",
                element_id: `text:${index + 1}:1:1`,
                x: 0,
                y: 0,
                width: 100,
                height: 20,
                text: slideTexts[index],
              },
            ],
            warnings: [],
          })),
          render_boundary: {
            status: "not_performed",
            renderer: null,
            fidelity_verified: false,
            reason: "Structural extraction only",
          },
        },
      }),
    );
    return createHash("sha256")
      .update(`render-manifest:deck_${deckHash}:${slides.map((s) => s.content_sha256).join(":")}`)
      .digest("hex");
  }

  function principalFor(tenantId: string) {
    return { tenantId, principalId: "principal-1", groupIds: [], attributes: {} };
  }

  test("embedding happens inside the advisory-locked critical section", async () => {
    // Every slide of a freshly uploaded deck asks for a recommendation at once. Embedding
    // used to run BEFORE the advisory lock, so every concurrent racer duplicated the whole
    // provider embedding run while waiting for the winner, burning every request deadline on
    // redundant work. The recorded operation order below pins the contract: the lock is
    // taken first, embedding follows inside it, and only then are rows written.
    const root = mkdtempSync(join(tmpdir(), "deck-corpus-race-"));
    roots.push(root);
    const deckHash = "1".repeat(64);
    const manifestHash = writeArtifact(root, deckHash, ["스마트 캠퍼스 개요 슬라이드"]);
    const database = fakeSql();

    const timeline: string[] = [];
    const instrumented = fakeSqlWithTimeline(database, timeline);

    const embedded: string[] = [];
    const events: unknown[] = [];
    const store = new PostgresDeckRetrievalStore({
      sql: instrumented as unknown as Sql,
      artifactRoot: root,
      access: {
        async authorize() {
          return true;
        },
      },
      embedding: {
        async embed(text) {
          timeline.push("embed:start");
          embedded.push(text);
          timeline.push("embed:end");
          return [1, 0];
        },
      },
      logger: {
        log(event) {
          events.push(event);
        },
      },
    });

    const request = RetrievalRequestSchema.parse({
      query: "개요",
      deckVersion: `deck_${deckHash}`,
      manifestHash,
      maxResults: 3,
    });

    await store.prepare(principalFor("tenant-race"), request);

    const lockAt = timeline.indexOf("advisory-lock");
    const embedAt = timeline.indexOf("embed:start");
    const insertAt = timeline.findIndex((entry) => entry.startsWith("insert:"));
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(embedAt).toBeGreaterThan(lockAt);
    expect(insertAt).toBeGreaterThan(embedAt);
    expect(embedded).toEqual(["스마트 캠퍼스 개요 슬라이드"]);
    expect(events).toEqual([
      expect.objectContaining({ outcome: "INDEXED", reason: "COMPLETED", indexedChunkCount: 1 }),
    ]);
  });

  test("keeps committed waves after a mid-run embedding failure and resumes only the missing chunks", async () => {
    // A cancelled or timed-out embedding call used to roll back the entire preparation
    // transaction, so the next recommendation re-embedded the whole deck from zero. On a
    // serial provider the duplicate bursts queued every later call past its own deadline,
    // which is exactly the churn the live baseline recorded as `Deck embedding failed:
    // cancelled` after every upload. Waves now commit independently, so a run that dies
    // mid-corpus leaves its finished rows durable and the next run embeds only what is
    // still missing.
    const root = mkdtempSync(join(tmpdir(), "deck-corpus-resume-"));
    roots.push(root);
    const texts = [
      "첫 번째 슬라이드 본문입니다.",
      "두 번째 슬라이드 본문입니다.",
      "세 번째 슬라이드 본문입니다.",
      "네 번째 슬라이드 본문입니다.",
      "다섯 번째 슬라이드 본문입니다.",
    ];
    const deckHash = "3".repeat(64);
    const manifestHash = writeArtifact(root, deckHash, texts);
    const database = fakeSql();

    const embedded: string[] = [];
    const events: Record<string, unknown>[] = [];
    let failRemaining = true;
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
          if (failRemaining && embedded.length === texts.length) {
            throw new Error("Deck embedding failed: cancelled");
          }
          return [1, 0];
        },
      },
      logger: {
        log(event) {
          events.push(event);
        },
      },
    });

    const principal = principalFor("tenant-resume");
    const request = RetrievalRequestSchema.parse({
      query: "본문",
      deckVersion: `deck_${deckHash}`,
      manifestHash,
      maxResults: 3,
    });

    await expect(store.prepare(principal, request)).rejects.toThrow("cancelled");
    const durableAfterFailure = database.rows.length;
    expect(durableAfterFailure).toBeGreaterThan(0);
    expect(durableAfterFailure).toBeLessThan(texts.length);

    failRemaining = false;
    embedded.length = 0;
    await store.prepare(principal, request);

    expect(embedded).toHaveLength(texts.length - durableAfterFailure);
    expect(database.rows).toHaveLength(texts.length);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({ outcome: "INDEXED", reason: "COMPLETED" }),
    );
  });

  test("embeds a multi-chunk corpus concurrently and keeps row association", async () => {
    // Serial embedding of 44 chunks took ~13.5 seconds on the dev stack - far beyond a single
    // recommendation budget - and stretched the critical section every concurrent recommender
    // waits on. Overlapping provider calls shortens it, and rows must stay tied to their own
    // chunks regardless of embedding completion order.
    const root = mkdtempSync(join(tmpdir(), "deck-corpus-parallel-"));
    roots.push(root);
    const texts = [
      "첫 번째 슬라이드 본문입니다.",
      "두 번째 슬라이드 본문입니다.",
      "세 번째 슬라이드 본문입니다.",
    ];
    const deckHash = "2".repeat(64);
    const manifestHash = writeArtifact(root, deckHash, texts);
    const database = fakeSql();

    let active = 0;
    let maxActive = 0;
    const store = new PostgresDeckRetrievalStore({
      sql: database.sql,
      artifactRoot: root,
      access: {
        async authorize() {
          return true;
        },
      },
      embedding: {
        async embed() {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await Bun.sleep(0);
          active -= 1;
          return [1, 0];
        },
      },
    });

    const request = RetrievalRequestSchema.parse({
      query: "본문",
      deckVersion: `deck_${deckHash}`,
      manifestHash,
      maxResults: 3,
    });
    await store.prepare(principalFor("tenant-parallel"), request);

    expect(maxActive).toBe(texts.length);
    const contents = database.rows.map((row) => row.content);
    expect([...contents].sort()).toEqual([...texts].sort());
    expect(database.rows.every((row) => Array.isArray(row.embedding))).toBe(true);
  });
});
