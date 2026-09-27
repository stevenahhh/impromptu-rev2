import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RetrievalRequestSchema } from "@impromptu/contracts/retrieval";
import type { Sql } from "postgres";
import {
  createReferenceTextExtractorStub,
  PostgresReferenceDocumentLibrary,
} from "../src/reference-documents.ts";
import type { RetrievalPrincipal } from "../src/retrieval/internal-retrieval.ts";
import { InternalRetrievalService } from "../src/retrieval/internal-retrieval.ts";
import { PostgresDeckRetrievalStore, RRF_K } from "../src/retrieval/postgres-deck-retrieval.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface ChunkRow extends Record<string, unknown> {
  corpus_kind?: string;
}

function fakeSql() {
  const chunkRows: ChunkRow[] = [];
  const documentRows: Record<string, unknown>[] = [];
  const queries: string[] = [];
  const sql = (first: unknown, ...values: unknown[]) => {
    if (!Array.isArray(first) || !Object.hasOwn(first, "raw")) return first;
    const query = (first as unknown as TemplateStringsArray).join("?").replace(/\s+/g, " ").trim();
    queries.push(query);
    if (query.startsWith("INSERT INTO private_app.deck_retrieval_chunks")) {
      const corpusKind = values[12] === "REFERENCE_DOCUMENT" ? "REFERENCE_DOCUMENT" : "DECK_SLIDE";
      chunkRows.push({
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
        corpus_kind: corpusKind,
      });
      return Promise.resolve([]);
    }
    if (query.startsWith("DELETE FROM private_app.deck_retrieval_chunks")) {
      const reference = query.includes("source_id = ?");
      const before = chunkRows.length;
      for (let index = chunkRows.length - 1; index >= 0; index -= 1) {
        const row = chunkRows[index];
        if (!row || row.tenant_id !== values[0]) continue;
        if (reference) {
          if (
            row.deck_version === values[1] &&
            row.manifest_hash === values[2] &&
            row.corpus_kind === "REFERENCE_DOCUMENT" &&
            row.source_id === values[4]
          ) {
            chunkRows.splice(index, 1);
          }
          continue;
        }
        if (row.deck_version === values[1] && row.corpus_kind !== "REFERENCE_DOCUMENT") {
          chunkRows.splice(index, 1);
        }
      }
      return Promise.resolve({ changes: before - chunkRows.length });
    }
    if (
      query.startsWith("SELECT object_id, source_revision") &&
      query.includes("corpus_kind = ?")
    ) {
      return Promise.resolve(
        chunkRows.filter(
          (row) =>
            row.tenant_id === values[0] &&
            row.deck_version === values[1] &&
            row.manifest_hash === values[2] &&
            row.authorization_version === values[3] &&
            row.corpus_kind !== "REFERENCE_DOCUMENT",
        ),
      );
    }
    if (query.startsWith("SELECT object_id")) {
      return Promise.resolve(
        chunkRows.filter(
          (row) =>
            row.tenant_id === values[0] &&
            row.deck_version === values[1] &&
            row.manifest_hash === values[2] &&
            row.authorization_version === values[3],
        ),
      );
    }
    if (query.startsWith("INSERT INTO private_app.reference_documents")) {
      const record = {
        tenant_id: values[0],
        document_id: values[1],
        presentation_session_id: values[2],
        filename: values[3],
        content_type: values[4],
        byte_length: values[5],
        source_revision: values[6],
        status: values[7],
        chunk_count: values[8],
      };
      const existing = documentRows.findIndex(
        (row) => row.tenant_id === record.tenant_id && row.document_id === record.document_id,
      );
      if (existing >= 0) documentRows.splice(existing, 1);
      documentRows.push(record);
      return Promise.resolve([]);
    }
    if (query.startsWith("SELECT document_id")) {
      return Promise.resolve(
        documentRows.filter(
          (row) => row.tenant_id === values[0] && row.presentation_session_id === values[1],
        ),
      );
    }
    if (query.startsWith("WITH lexical AS")) {
      const search = String(values[0]).toLocaleLowerCase();
      const ids = values[2] as readonly string[];
      return Promise.resolve(
        chunkRows
          .filter(
            (row) =>
              row.tenant_id === values[1] &&
              ids.includes(String(row.object_id)) &&
              String(row.content).toLocaleLowerCase().includes(search),
          )
          .map((row) => ({ ...row, lexical_score: 1 })),
      );
    }
    if (query.startsWith("SELECT *") && query.includes("object_id IN")) {
      const ids = values[1] as readonly string[];
      return Promise.resolve(
        chunkRows.filter(
          (row) => row.tenant_id === values[0] && ids.includes(String(row.object_id)),
        ),
      );
    }
    if (query.startsWith("SELECT *")) {
      return Promise.resolve(
        chunkRows.filter((row) => row.tenant_id === values[0] && row.object_id === values[1]),
      );
    }
    if (query.startsWith("SELECT pg_advisory_xact_lock")) {
      // Serializes concurrent preparers of the same deck scope; the fake has one connection.
      return Promise.resolve([]);
    }
    throw new Error(`Unexpected SQL: ${query}`);
  };
  Object.assign(sql, { array: (value: unknown) => value });
  return { sql: sql as unknown as Sql, chunkRows, documentRows, queries };
}

const principal: RetrievalPrincipal = {
  tenantId: "tenant-reference",
  principalId: "actor-reference",
  groupIds: [],
  attributes: {},
};

function libraryHarness(
  database: ReturnType<typeof fakeSql>,
  extracted?: Map<string, string>,
  scope = { deckVersion: `deck_${"a".repeat(64)}`, manifestHash: "b".repeat(64) },
  embed?: (text: string) => Promise<readonly number[]>,
) {
  const embedded: string[] = [];
  const extractor = createReferenceTextExtractorStub(extracted ?? new Map());
  const library = new PostgresReferenceDocumentLibrary({
    repository: { transaction: (_tenantId, operation) => operation(database.sql) },
    extractor,
    embedding: {
      async embed(text) {
        if (embed !== undefined) return embed(text);
        embedded.push(text);
        return [1, 0];
      },
    },
    presentations: {
      async resolveOwnedPresentation({ presentationSessionId }) {
        if (presentationSessionId !== "ps_reference") return null;
        return scope;
      },
    },
  });
  return { library, embedded };
}

function document(filename: string, bytes: string) {
  return {
    filename,
    contentType: filename.endsWith(".md")
      ? "text/markdown"
      : filename.endsWith(".txt")
        ? "text/plain"
        : "application/octet-stream",
    bytes: new TextEncoder().encode(bytes),
  };
}

describe("reference document library", () => {
  test("extracts, chunks and indexes uploaded text documents into the retrieval store", async () => {
    const database = fakeSql();
    const { library, embedded } = libraryHarness(database);
    const outcome = await library.acceptReferenceDocuments({
      accountId: principal.tenantId,
      actorId: principal.principalId,
      presentationSessionId: "ps_reference",
      documents: [
        document("notes.md", "# Brief\nZephyr quartz onboarding budget is 41 percent."),
        document("agenda.txt", "Agenda: zephyr quartz pricing review."),
      ],
    });

    expect(outcome.outcome).toBe("ACCEPTED");
    if (outcome.outcome !== "ACCEPTED") return;
    expect(outcome.documents).toHaveLength(2);
    expect(outcome.documents.every((item) => item.status === "INDEXED")).toBe(true);
    expect(outcome.documents.every((item) => /^[0-9a-f]{64}$/.test(item.documentId))).toBe(true);
    expect(embedded.some((text) => text.includes("Zephyr quartz onboarding budget"))).toBe(true);
    expect(
      database.chunkRows.some(
        (row) =>
          row.corpus_kind === "REFERENCE_DOCUMENT" &&
          String(row.content).includes("Zephyr quartz onboarding budget"),
      ),
    ).toBe(true);
    expect(
      database.chunkRows.some((row) =>
        String(row.content).includes("zephyr quartz pricing review"),
      ),
    ).toBe(true);
    expect(database.documentRows).toHaveLength(2);
  });

  test("rejects unknown binary types without writing anything", async () => {
    const database = fakeSql();
    const { library } = libraryHarness(database);
    const outcome = await library.acceptReferenceDocuments({
      accountId: principal.tenantId,
      actorId: principal.principalId,
      presentationSessionId: "ps_reference",
      documents: [
        { filename: "photo.png", contentType: "image/png", bytes: new Uint8Array([1, 2, 3]) },
      ],
    });

    expect(outcome).toEqual({ outcome: "REJECTED", reason: "UNSUPPORTED_TYPE" });
    expect(database.chunkRows).toHaveLength(0);
    expect(database.documentRows).toHaveLength(0);
  });

  test("rejects uploads for presentations the account does not own", async () => {
    const database = fakeSql();
    const { library } = libraryHarness(database);
    const outcome = await library.acceptReferenceDocuments({
      accountId: principal.tenantId,
      actorId: principal.principalId,
      presentationSessionId: "ps_unknown",
      documents: [document("notes.md", "hello")],
    });

    expect(outcome).toEqual({ outcome: "REJECTED", reason: "PRESENTATION_UNKNOWN" });
    expect(database.chunkRows).toHaveLength(0);
  });

  test("rejects empty batches and oversized documents", async () => {
    const database = fakeSql();
    const { library } = libraryHarness(database);
    expect(
      await library.acceptReferenceDocuments({
        accountId: principal.tenantId,
        actorId: principal.principalId,
        presentationSessionId: "ps_reference",
        documents: [],
      }),
    ).toEqual({ outcome: "REJECTED", reason: "EMPTY_INPUT" });
    expect(
      await library.acceptReferenceDocuments({
        accountId: principal.tenantId,
        actorId: principal.principalId,
        presentationSessionId: "ps_reference",
        documents: [
          { filename: "big.txt", contentType: "text/plain", bytes: new Uint8Array(6_000_000) },
        ],
      }),
    ).toEqual({ outcome: "REJECTED", reason: "TOO_LARGE" });
  });

  test("re-uploading the same document replaces its earlier chunks", async () => {
    const database = fakeSql();
    const { library } = libraryHarness(database);
    const upload = (text: string) =>
      library.acceptReferenceDocuments({
        accountId: principal.tenantId,
        actorId: principal.principalId,
        presentationSessionId: "ps_reference",
        documents: [document("notes.md", text)],
      });
    await upload("first version of the notes");
    const second = await upload("second version of the notes");
    expect(second.outcome).toBe("ACCEPTED");

    const referenceRows = database.chunkRows.filter(
      (row) => row.corpus_kind === "REFERENCE_DOCUMENT",
    );
    expect(referenceRows.length).toBe(1);
    expect(String(referenceRows[0]?.content)).toContain("second version");
    expect(database.documentRows).toHaveLength(1);
  });

  test("stores documents unindexed when the embedding provider is unavailable", async () => {
    const database = fakeSql();
    const { library } = libraryHarness(database, undefined, undefined, async () => {
      throw new Error("embedding provider unavailable");
    });
    const outcome = await library.acceptReferenceDocuments({
      accountId: principal.tenantId,
      actorId: principal.principalId,
      presentationSessionId: "ps_reference",
      documents: [document("notes.md", "Zephyr quartz contingency reserve notes.")],
    });

    expect(outcome.outcome).toBe("ACCEPTED");
    if (outcome.outcome !== "ACCEPTED") return;
    expect(outcome.documents[0]?.status).toBe("STORED_INDEX_PENDING");
    expect(outcome.documents[0]?.chunkCount).toBe(0);
    expect(database.chunkRows).toHaveLength(0);

    const listed = await library.listReferenceDocuments({
      accountId: principal.tenantId,
      presentationSessionId: "ps_reference",
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ status: "STORED_INDEX_PENDING", chunkCount: 0 });
  });

  test("a degraded re-upload atomically removes the previously indexed chunks", async () => {
    const database = fakeSql();
    let providerDown = false;
    const { library } = libraryHarness(database, undefined, undefined, async () => {
      if (providerDown) throw new Error("embedding provider unavailable");
      return [1, 0];
    });
    const upload = (text: string) =>
      library.acceptReferenceDocuments({
        accountId: principal.tenantId,
        actorId: principal.principalId,
        presentationSessionId: "ps_reference",
        documents: [document("notes.md", text)],
      });

    const first = await upload("first version mentioning zephyr quartz");
    expect(first.outcome).toBe("ACCEPTED");
    expect(database.chunkRows.some((row) => row.corpus_kind === "REFERENCE_DOCUMENT")).toBe(true);

    providerDown = true;
    const second = await upload("second version mentioning zephyr quartz");
    expect(second.outcome).toBe("ACCEPTED");
    if (second.outcome !== "ACCEPTED") return;
    expect(second.documents[0]?.status).toBe("STORED_INDEX_PENDING");
    // No stale reference chunks may survive the supersession; otherwise retrieval
    // could still cite a document listed as not searchable.
    expect(database.chunkRows.some((row) => row.corpus_kind === "REFERENCE_DOCUMENT")).toBe(false);

    const listed = await library.listReferenceDocuments({
      accountId: principal.tenantId,
      presentationSessionId: "ps_reference",
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ status: "STORED_INDEX_PENDING", chunkCount: 0 });
  });

  test("records documents whose extracted text is empty as EMPTY without chunk rows", async () => {
    const database = fakeSql();
    const { library, embedded } = libraryHarness(database, new Map([["silent.txt", "   "]]));
    const outcome = await library.acceptReferenceDocuments({
      accountId: principal.tenantId,
      actorId: principal.principalId,
      presentationSessionId: "ps_reference",
      documents: [document("silent.txt", "anything at all")],
    });

    expect(outcome.outcome).toBe("ACCEPTED");
    if (outcome.outcome !== "ACCEPTED") return;
    expect(outcome.documents[0]?.status).toBe("EMPTY");
    expect(outcome.documents[0]?.chunkCount).toBe(0);
    expect(embedded).toHaveLength(0);
    expect(database.chunkRows).toHaveLength(0);
    expect(database.documentRows).toHaveLength(1);
  });

  test("lists previously uploaded documents for the session", async () => {
    const database = fakeSql();
    const { library } = libraryHarness(database);
    await library.acceptReferenceDocuments({
      accountId: principal.tenantId,
      actorId: principal.principalId,
      presentationSessionId: "ps_reference",
      documents: [document("notes.md", "# Brief\ntext body here")],
    });

    const listed = await library.listReferenceDocuments({
      accountId: principal.tenantId,
      presentationSessionId: "ps_reference",
    });

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      presentationSessionId: "ps_reference",
      filename: "notes.md",
      status: "INDEXED",
      chunkCount: 1,
    });
  });
});

describe("reference chunks in internal retrieval", () => {
  test("survives deck corpus preparation, passes authorization and materializes as evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "reference-corpus-"));
    roots.push(root);
    const artifact = join(root, "artifact-1");
    mkdirSync(artifact, { recursive: true });
    const deckHash = "a".repeat(64);
    const slideHash = "b".repeat(64);
    const slideKey = `slide_${"c".repeat(64)}`;
    const renderManifest = {
      deck_id: `deck_${deckHash}`,
      renderer: { name: "pymupdf", version: "1.26" },
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
    writeFileSync(join(artifact, "render.json"), JSON.stringify(renderManifest));
    writeFileSync(
      join(artifact, "ingestion.json"),
      JSON.stringify({
        status: "completed",
        job_id: "production_ingest",
        manifest_hash: "d".repeat(64),
        manifest: {
          schema_version: "1",
          deck_id: renderManifest.deck_id,
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
                  element_id: "t1",
                  x: 0,
                  y: 0,
                  width: 10,
                  height: 10,
                  text: "Slide body about revenue.",
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
      .update(`render-manifest:${renderManifest.deck_id}:${slideHash}`)
      .digest("hex");

    const database = fakeSql();
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
          return [1, 0];
        },
      },
    });
    const request = RetrievalRequestSchema.parse({
      query: "zephyr quartz",
      deckVersion: `deck_${deckHash}`,
      manifestHash,
      maxResults: 3,
    });

    await store.prepare(principal, request);

    const { library } = libraryHarness(database, undefined, {
      deckVersion: request.deckVersion,
      manifestHash,
    });
    const accepted = await library.acceptReferenceDocuments({
      accountId: principal.tenantId,
      actorId: principal.principalId,
      presentationSessionId: "ps_reference",
      documents: [
        document("notes.md", "Zephyr quartz contingency reserve is 41 percent of hardware spend."),
      ],
    });
    expect(accepted.outcome).toBe("ACCEPTED");

    // Re-preparing the deck corpus must not wipe indexed reference chunks.
    await store.prepare(principal, request);
    expect(
      database.chunkRows.some(
        (row) =>
          row.corpus_kind === "REFERENCE_DOCUMENT" &&
          String(row.content).includes("Zephyr quartz contingency reserve"),
      ),
    ).toBe(true);

    const authorization = await store.prefilter(principal, request);
    expect(authorization.current).toBe(true);
    expect(authorization.authorizedObjectIds.length).toBe(2);

    const candidates = await store.search({
      tenantId: principal.tenantId,
      query: request.query,
      queryVector: [],
      authorizedObjectIds: authorization.authorizedObjectIds,
      limit: 3,
    });
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const top = await store.readMetadata(principal.tenantId, candidates[0]?.objectId ?? "");
    expect(top?.title).toBe("notes.md");
    // The reference chunk is the only lexical match, so it takes rank one under RRF.
    expect(candidates[0]?.score).toBeCloseTo(1 / (RRF_K + 1));

    const internal = new InternalRetrievalService({
      principals: {
        async resolve() {
          return principal;
        },
      },
      policy: store,
      ann: store,
      objects: store,
      corpus: store,
    });
    const references = await internal.retrieve("account-session-1", request, []);
    expect(references.length).toBeGreaterThanOrEqual(1);
    const first = references[0];
    if (first === undefined) throw new Error("retrieval returned no reference chunk");
    const materialized = await internal.materialize(first);
    expect(materialized.outcome).toBe("MATERIALIZED");
    if (materialized.outcome !== "MATERIALIZED") return;
    expect(materialized.evidence.content).toContain("Zephyr quartz contingency reserve");
    expect(materialized.evidence.title).toBe("notes.md");
  });
});
