/**
 * Presenter-uploaded reference documents ("a project folder's worth of files")
 * for one presentation session.
 *
 * Contract: test/reference-document-library.test.ts and
 * test/reference-documents-http.test.ts.
 *
 * Uploads are validated fail-closed against an allow-list of text formats
 * (.md/.txt) and structural ingestion formats (.pdf/.pptx), extracted, chunked,
 * and embedded into private_app.deck_retrieval_chunks with corpus kind
 * REFERENCE_DOCUMENT so the internal retrieval path used by the recommendation
 * pipeline finds them alongside deck slides. Document metadata is kept in
 * private_app.reference_documents for listings.
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ReferenceDocumentStatus,
  ReferenceDocumentSummary,
} from "@impromptu/contracts/private";
import { IngestionJsonSchema } from "./deck-render-subprocess.ts";
import type { RetrievalPrincipal } from "./retrieval/internal-retrieval.ts";
import {
  chunkText,
  extractStructuralText,
  insertChunkRow,
  REFERENCE_DOCUMENT_CORPUS_KIND,
} from "./retrieval/postgres-deck-retrieval.ts";
import type { TenantScopedPostgresRepository } from "./retrieval/tenant-scoped-postgres-repository.ts";

export const MAX_REFERENCE_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const MAX_REFERENCE_DOCUMENTS_PER_UPLOAD = 10;
export const MAX_REFERENCE_UPLOAD_TOTAL_BYTES = 20 * 1024 * 1024;
const INGESTION_DEADLINE_MS = 60_000;

export type SupportedReferenceExtension = "md" | "txt" | "pdf" | "pptx";

const INGESTION_CONTENT_TYPES: Readonly<Record<"pdf" | "pptx", string>> = {
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const TEXT_CONTENT_TYPES: Readonly<Record<"md" | "txt", string>> = {
  md: "text/markdown",
  txt: "text/plain",
};

function mediaTypeOf(contentType: string): string {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function extensionOf(filename: string): string | null {
  const index = filename.lastIndexOf(".");
  return index <= 0 ? null : filename.slice(index + 1).toLowerCase();
}

/** Fail-closed format gate. Unknown or binary-generic types are cleanly rejected upstream. */
export function supportedReferenceExtension(
  filename: string,
  contentType: string,
): SupportedReferenceExtension | null {
  const extension = extensionOf(filename);
  if (extension !== "md" && extension !== "txt" && extension !== "pdf" && extension !== "pptx") {
    return null;
  }
  if (extension === "pdf" || extension === "pptx") {
    return INGESTION_CONTENT_TYPES[extension] === mediaTypeOf(contentType) ? extension : null;
  }
  // Text formats accept any declared text/* type; binary-generic declarations are refused so
  // unknown binary uploads never reach extraction.
  const mediaType = mediaTypeOf(contentType);
  return mediaType === "" || mediaType.startsWith("text/") ? extension : null;
}

export function unsafeReferenceFilename(filename: string): boolean {
  return (
    filename.length === 0 ||
    filename === "." ||
    filename === ".." ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("\0") ||
    new TextEncoder().encode(filename).byteLength > 255
  );
}

export interface RawReferenceDocumentBody {
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export type ReferenceTextExtraction =
  | Readonly<{ outcome: "EXTRACTED"; text: string }>
  | Readonly<{ outcome: "FAILED"; errorType: string }>;

export interface ReferenceTextExtractor {
  extract(input: {
    readonly filename: string;
    readonly extension: SupportedReferenceExtension;
    readonly bytes: Uint8Array;
  }): Promise<ReferenceTextExtraction>;
}

/** Test seam for extraction-backed library tests. */
export function createReferenceTextExtractorStub(
  extracted: ReadonlyMap<string, string>,
): ReferenceTextExtractor {
  return {
    async extract({ filename, extension, bytes }) {
      try {
        return {
          outcome: "EXTRACTED",
          text: extracted.get(filename) ?? new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        };
      } catch (error) {
        return {
          outcome: "FAILED",
          errorType: error instanceof Error ? error.name : `UnknownError:${extension}`,
        };
      }
    },
  };
}

const REFERENCE_INGESTION_JOB_ID = "reference_document";

/**
 * Extraction boundary for uploaded reference documents. Plain .md/.txt bytes are decoded
 * directly; PDF/PPTX reuse the ingestion CLI's structural extractor through the same
 * subprocess pattern as deck rendering (`uv run --project <ingestion> impromptu-ingestion ingest`).
 */
export function createIngestionBackedReferenceTextExtractor(options: {
  readonly ingestionProject: string;
}): ReferenceTextExtractor {
  return {
    async extract({ extension, bytes }) {
      if (extension === "md" || extension === "txt") {
        try {
          return {
            outcome: "EXTRACTED",
            text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          };
        } catch (error) {
          return {
            outcome: "FAILED",
            errorType: error instanceof Error ? error.name : "UnknownError",
          };
        }
      }
      let directory: string | undefined;
      try {
        directory = await mkdtemp(join(tmpdir(), "reference-ingest-"));
        const source = join(directory, `source.${extension}`);
        const output = join(directory, "ingestion.json");
        await writeFile(source, bytes);
        const process = Bun.spawn(
          [
            "uv",
            "run",
            "--project",
            options.ingestionProject,
            "impromptu-ingestion",
            "ingest",
            source,
            `--job-id=${REFERENCE_INGESTION_JOB_ID}`,
            `--output=${output}`,
          ],
          {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            signal: AbortSignal.timeout(INGESTION_DEADLINE_MS),
          },
        );
        const exitCode = await process.exited;
        if (exitCode !== 0) return { outcome: "FAILED", errorType: "IngestionFailed" };
        const parsed = IngestionJsonSchema.safeParse(JSON.parse(await Bun.file(output).text()));
        if (!parsed.success) return { outcome: "FAILED", errorType: "IngestionManifestInvalid" };
        const text = [...parsed.data.manifest.slides]
          .sort((left, right) => left.source_index - right.source_index)
          .map((slide) => extractStructuralText(slide.elements))
          .join("\n");
        return { outcome: "EXTRACTED", text };
      } catch (error) {
        return {
          outcome: "FAILED",
          errorType: error instanceof Error ? error.name : "UnknownError",
        };
      } finally {
        if (directory !== undefined) await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

export interface ReferencePresentationAuthority {
  resolveOwnedPresentation(input: {
    readonly accountId: string;
    readonly presentationSessionId: string;
  }): Promise<Readonly<{ deckVersion: string; manifestHash: string }> | null>;
}

export type ReferenceUploadOutcome =
  | Readonly<{ outcome: "ACCEPTED"; documents: readonly ReferenceDocumentSummary[] }>
  | Readonly<{ outcome: "REJECTED"; reason: ReferenceRejectionReason }>;

type ReferenceRejectionReason =
  | "EMPTY_INPUT"
  | "UNSUPPORTED_TYPE"
  | "UNSAFE_FILENAME"
  | "TOO_LARGE"
  | "TOO_MANY_FILES"
  | "EXTRACTION_FAILED"
  | "PRESENTATION_UNKNOWN";

interface ReferenceDocumentRow {
  document_id: string;
  presentation_session_id: string;
  filename: string;
  content_type: string;
  byte_length: string | number;
  status: string;
  chunk_count: number;
}

interface PreparedReferenceDocument {
  readonly documentId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly byteLength: number;
  readonly sourceRevision: string;
  readonly chunks: readonly string[];
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Honest per-document terminal state: INDEXED only when searchable chunk rows were
 * actually written; STORED_INDEX_PENDING when text was extracted but indexing wrote
 * nothing (e.g. embedding provider unavailable); EMPTY when no text was extracted.
 */
function referenceDocumentStatus(
  extractedChunkCount: number,
  indexedChunkCount: number,
): ReferenceDocumentStatus {
  if (indexedChunkCount > 0) return "INDEXED";
  return extractedChunkCount > 0 ? "STORED_INDEX_PENDING" : "EMPTY";
}

export class PostgresReferenceDocumentLibrary {
  readonly #repository: TenantScopedPostgresRepository;
  readonly #extractor: ReferenceTextExtractor;
  readonly #embedding: (text: string, principal: RetrievalPrincipal) => Promise<readonly number[]>;
  readonly #presentations: ReferencePresentationAuthority;

  constructor(dependencies: {
    readonly repository: TenantScopedPostgresRepository;
    readonly extractor: ReferenceTextExtractor;
    /** The shared deck embedding port, so reference chunks live in the same vector space. */
    readonly embedding: {
      embed(text: string, principal: RetrievalPrincipal): Promise<readonly number[]>;
    };
    readonly presentations: ReferencePresentationAuthority;
  }) {
    this.#repository = dependencies.repository;
    this.#extractor = dependencies.extractor;
    this.#embedding = dependencies.embedding.embed.bind(dependencies.embedding);
    this.#presentations = dependencies.presentations;
  }

  async acceptReferenceDocuments(input: {
    readonly accountId: string;
    readonly actorId: string;
    readonly presentationSessionId: string;
    readonly documents: readonly RawReferenceDocumentBody[];
  }): Promise<ReferenceUploadOutcome> {
    const documents = input.documents;
    if (documents.length === 0) return { outcome: "REJECTED", reason: "EMPTY_INPUT" };
    if (documents.length > MAX_REFERENCE_DOCUMENTS_PER_UPLOAD) {
      return { outcome: "REJECTED", reason: "TOO_MANY_FILES" };
    }
    // Validate every document before touching storage so a rejected batch leaves no trace.
    let totalBytes = 0;
    for (const document of documents) {
      if (unsafeReferenceFilename(document.filename)) {
        return { outcome: "REJECTED", reason: "UNSAFE_FILENAME" };
      }
      if (
        supportedReferenceExtension(document.filename, document.contentType) === null ||
        document.contentType.length > 128
      ) {
        return { outcome: "REJECTED", reason: "UNSUPPORTED_TYPE" };
      }
      if (document.bytes.byteLength === 0) {
        return { outcome: "REJECTED", reason: "EMPTY_INPUT" };
      }
      totalBytes += document.bytes.byteLength;
      if (
        document.bytes.byteLength > MAX_REFERENCE_DOCUMENT_BYTES ||
        totalBytes > MAX_REFERENCE_UPLOAD_TOTAL_BYTES
      ) {
        return { outcome: "REJECTED", reason: "TOO_LARGE" };
      }
    }
    const scope = await this.#presentations.resolveOwnedPresentation({
      accountId: input.accountId,
      presentationSessionId: input.presentationSessionId,
    });
    if (scope === null) return { outcome: "REJECTED", reason: "PRESENTATION_UNKNOWN" };

    const prepared: PreparedReferenceDocument[] = [];
    for (const document of documents) {
      const extension = supportedReferenceExtension(document.filename, document.contentType);
      if (extension === null) return { outcome: "REJECTED", reason: "UNSUPPORTED_TYPE" };
      const extracted = await this.#extractor.extract({
        filename: document.filename,
        extension,
        bytes: document.bytes,
      });
      if (extracted.outcome === "FAILED") {
        return { outcome: "REJECTED", reason: "EXTRACTION_FAILED" };
      }
      const sourceRevision = createHash("sha256").update(document.bytes).digest("hex");
      const mediaType = mediaTypeOf(document.contentType);
      // Document identity is (tenant, session, filename): re-uploading a file replaces its
      // earlier chunks instead of accumulating stale versions.
      const documentId = sha256Hex(
        `${input.accountId}:${input.presentationSessionId}:${document.filename}`,
      );
      const normalizedContentType =
        mediaType.length > 0
          ? mediaType
          : extension === "pdf"
            ? INGESTION_CONTENT_TYPES.pdf
            : extension === "pptx"
              ? INGESTION_CONTENT_TYPES.pptx
              : TEXT_CONTENT_TYPES[extension];
      prepared.push({
        documentId,
        filename: document.filename,
        contentType: normalizedContentType ?? "application/octet-stream",
        byteLength: document.bytes.byteLength,
        sourceRevision,
        chunks: chunkText(extracted.text.trim().replace(/\r\n/g, "\n")),
      });
    }

    const principal: RetrievalPrincipal = {
      tenantId: input.accountId,
      principalId: input.actorId,
      groupIds: [],
      attributes: { role: "controller" },
    };

    const embeddedRows = new Map<
      string,
      {
        readonly document: PreparedReferenceDocument;
        readonly rows: {
          object_id: string;
          source_hash: string;
          anchor: string;
          content: string;
          embedding: readonly number[];
        }[];
      }
    >();
    for (const document of prepared) {
      const rows = [];
      for (const [offset, content] of document.chunks.entries()) {
        const sourceHash = sha256Hex(content);
        const objectId = createHash("sha256")
          .update(
            `${principal.tenantId}:${scope.deckVersion}:${scope.manifestHash}:reference:${document.documentId}:${offset}:${sourceHash}`,
          )
          .digest("hex");
        // Degrade, don't reject: with no embedding provider the reference still stores
        // its extracted text and lists under STORED_INDEX_PENDING so the presenter
        // keeps the file; only the vector-citation path is skipped.
        let embedding: readonly number[] = [];
        let embeddable = true;
        try {
          embedding = [...(await this.#embedding(content, principal))];
        } catch {
          embeddable = false;
        }
        if (
          embeddable &&
          (embedding.length === 0 || embedding.some((value) => !Number.isFinite(value)))
        ) {
          embeddable = false;
        }
        if (!embeddable) {
          rows.length = 0;
          break;
        }
        rows.push({
          object_id: objectId,
          source_hash: sourceHash,
          anchor: `chunk=${offset + 1}`,
          content,
          embedding,
        });
      }
      embeddedRows.set(document.documentId, { document, rows });
    }

    await this.#repository.transaction(principal.tenantId, async (sql) => {
      for (const { document, rows } of embeddedRows.values()) {
        // Re-uploads supersede exactly their own prior chunks and never touch other
        // rows. The delete is unconditional so a degraded re-upload (zero new rows)
        // still purges stale vectors/FTS rows in the same transaction.
        await sql`
          DELETE FROM private_app.deck_retrieval_chunks
          WHERE tenant_id = ${principal.tenantId}
            AND deck_version = ${scope.deckVersion}
            AND manifest_hash = ${scope.manifestHash}
            AND corpus_kind = ${REFERENCE_DOCUMENT_CORPUS_KIND}
            AND source_id = ${document.documentId}
        `;
        if (rows.length > 0) {
          for (const row of rows) {
            await insertChunkRow(sql, {
              tenant_id: principal.tenantId,
              object_id: row.object_id,
              source_id: document.documentId,
              source_revision: document.sourceRevision,
              source_hash: row.source_hash,
              deck_version: scope.deckVersion,
              manifest_hash: scope.manifestHash,
              title: document.filename,
              anchor: row.anchor,
              content: row.content,
              embedding: [...row.embedding],
              authorization_version: AUTHORIZATION_VERSION,
              corpus_kind: REFERENCE_DOCUMENT_CORPUS_KIND,
            });
          }
        }
        await sql`
          INSERT INTO private_app.reference_documents (
            tenant_id, document_id, presentation_session_id, filename, content_type,
            byte_length, source_revision, status, chunk_count
          ) VALUES (
            ${principal.tenantId}, ${document.documentId}, ${input.presentationSessionId},
            ${document.filename}, ${document.contentType}, ${document.byteLength},
            ${document.sourceRevision}, ${rows.length > 0 ? "INDEXED" : "EMPTY"},
            ${document.chunks.length}
          )
          ON CONFLICT (tenant_id, document_id) DO UPDATE SET
            content_type = EXCLUDED.content_type,
            byte_length = EXCLUDED.byte_length,
            status = EXCLUDED.status,
            chunk_count = EXCLUDED.chunk_count,
            source_revision = EXCLUDED.source_revision
        `;
      }
    });

    return {
      outcome: "ACCEPTED",
      documents: prepared.map((document) => {
        const rows = embeddedRows.get(document.documentId)?.rows ?? [];
        return {
          documentId: document.documentId,
          presentationSessionId: input.presentationSessionId,
          filename: document.filename,
          contentType: document.contentType,
          byteLength: document.byteLength,
          chunkCount: rows.length,
          status: referenceDocumentStatus(document.chunks.length, rows.length),
        };
      }),
    };
  }

  async listReferenceDocuments(input: {
    readonly accountId: string;
    readonly presentationSessionId: string;
  }): Promise<readonly ReferenceDocumentSummary[]> {
    const rows = await this.#repository.transaction(
      input.accountId,
      async (sql) =>
        sql<readonly ReferenceDocumentRow[]>`
        SELECT document_id, presentation_session_id, filename, content_type,
               byte_length, status, chunk_count
        FROM private_app.reference_documents
        WHERE tenant_id = ${input.accountId}
          AND presentation_session_id = ${input.presentationSessionId}
        ORDER BY created_at ASC, document_id ASC
      `,
    );
    return rows.flatMap((row) => {
      const byteLength = Number(row.byte_length);
      const chunkCount = Number(row.chunk_count);
      if (
        !Number.isSafeInteger(byteLength) ||
        byteLength <= 0 ||
        !Number.isSafeInteger(chunkCount)
      ) {
        return [];
      }
      return [
        {
          documentId: String(row.document_id),
          presentationSessionId: String(row.presentation_session_id),
          filename: String(row.filename),
          contentType: String(row.content_type),
          byteLength,
          // chunkCount reports searchable chunks; the persisted column counts extracted
          // chunks, which distinguishes "stored but unindexed" from "no text".
          chunkCount: row.status === "INDEXED" ? chunkCount : 0,
          status:
            row.status === "INDEXED"
              ? ("INDEXED" as const)
              : chunkCount > 0
                ? ("STORED_INDEX_PENDING" as const)
                : ("EMPTY" as const),
        },
      ];
    });
  }
}

const AUTHORIZATION_VERSION = "acl-1";
