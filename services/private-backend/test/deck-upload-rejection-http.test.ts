import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreparedEvidenceProjectionGateway } from "@impromptu/projection-gateway";
import { parsePrivateBackendConfig } from "../src/config.ts";
import { createDeckUploadService } from "../src/deck-upload-service.ts";
import {
  createDeckUploadWorker,
  type DeckUploadRejectionCode,
  MAX_DECK_UPLOAD_BYTES,
  type RenderSubprocessAdapter,
} from "../src/deck-upload-worker.ts";
import {
  createPrivateBackendHandler,
  type DeckUploadRejectedResponse,
  type PrivateBackendHandler,
} from "../src/http.ts";
import {
  createPreparedEvidenceStore,
  PreparedEvidenceCoordinator,
} from "../src/prepared-evidence.ts";

const CONSOLE_ORIGIN = "https://console.example.test";
const PRIVATE_ORIGIN = "https://private.example.test";
const PPTX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const PDF_CONTENT_TYPE = "application/pdf";
const PPTX_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14]);

interface Fixture {
  readonly handler: PrivateBackendHandler;
  readonly stagingRoot: string;
  readonly artifactRoot: string;
  readonly store: ReturnType<typeof createPreparedEvidenceStore>;
  readonly renderCalls: string[];
  readonly outsideSentinel: string;
}

const roots: string[] = [];

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "deck-upload-rejection-http-"));
  roots.push(root);
  const stagingRoot = join(root, "staging");
  const artifactRoot = join(root, "artifacts");
  mkdirSync(stagingRoot);
  mkdirSync(artifactRoot);
  writeFileSync(join(stagingRoot, ".keep"), "");
  writeFileSync(join(artifactRoot, ".keep"), "");
  const outsideSentinel = join(root, "outside-sentinel");
  writeFileSync(outsideSentinel, "untouched");
  const renderCalls: string[] = [];
  const subprocess: RenderSubprocessAdapter = {
    async run(request) {
      renderCalls.push(request.sourcePath);
      throw new Error("pre-validation rejection reached the renderer");
    },
  };
  const store = createPreparedEvidenceStore();
  const coordinator = new PreparedEvidenceCoordinator(
    new PreparedEvidenceProjectionGateway(),
    store,
  );
  const uploads = createDeckUploadService({
    projectionGatewayOrigin: "https://stage.example.test",
    worker: createDeckUploadWorker({ subprocess, stagingRoot, artifactRoot }),
  });
  return {
    handler: createPrivateBackendHandler(parsePrivateBackendConfig({ CONSOLE_ORIGIN }), {
      coordinator,
      identityVerifier: {
        async verifyCredentials() {
          return { accountId: "account_upload_boundary", actorId: "actor_upload_boundary" };
        },
      },
      internalAuthToken: "deck-upload-boundary-token",
      now: () => 1_000,
      uploads,
    }),
    stagingRoot,
    artifactRoot,
    store,
    renderCalls,
    outsideSentinel,
  };
}

function browserHeaders(csrfToken?: string, cookie?: string): HeadersInit {
  return {
    Origin: CONSOLE_ORIGIN,
    Referer: `${CONSOLE_ORIGIN}/decks`,
    ...(csrfToken === undefined ? {} : { "X-CSRF-Token": csrfToken }),
    ...(cookie === undefined ? {} : { Cookie: cookie }),
  };
}

async function signIn(handler: PrivateBackendHandler) {
  const response = await handler(
    new Request(`${PRIVATE_ORIGIN}/v1/account-sessions`, {
      method: "POST",
      headers: browserHeaders(),
      body: JSON.stringify({
        username: "upload-boundary@example.test",
        password: "upload-boundary-password",
      }),
    }),
  );
  expect(response.status).toBe(201);
  const session = await response.json();
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined || typeof session.csrfToken !== "string") {
    throw new Error("sign-in fixture failed");
  }
  return { cookie, csrfToken: session.csrfToken as string };
}

async function rejectMultipartBody(
  input: Fixture,
  auth: Awaited<ReturnType<typeof signIn>>,
  body: BodyInit,
  contentType?: string,
  contentLength?: number,
): Promise<{ readonly status: number; readonly payload: DeckUploadRejectedResponse }> {
  const response = await input.handler(
    new Request(`${PRIVATE_ORIGIN}/v1/deck-uploads`, {
      method: "POST",
      headers: {
        ...browserHeaders(auth.csrfToken, auth.cookie),
        ...(contentType === undefined ? {} : { "Content-Type": contentType }),
        ...(contentLength === undefined ? {} : { "Content-Length": String(contentLength) }),
      },
      body,
    }),
  );
  return {
    status: response.status,
    payload: (await response.json()) as DeckUploadRejectedResponse,
  };
}

function rejectUpload(
  input: Fixture,
  auth: Awaited<ReturnType<typeof signIn>>,
  options: {
    readonly filename: string;
    readonly contentType: typeof PPTX_CONTENT_TYPE | typeof PDF_CONTENT_TYPE;
    readonly body: Uint8Array;
  },
): Promise<{ readonly status: number; readonly payload: DeckUploadRejectedResponse }> {
  const copy = new Uint8Array(options.body.byteLength);
  copy.set(options.body);
  const form = new FormData();
  form.append("file", new File([copy.buffer], options.filename, { type: options.contentType }));
  return rejectMultipartBody(input, auth, form);
}

function assertClean(input: Fixture): void {
  expect(input.store.presentations.size).toBe(0);
  expect(input.renderCalls).toEqual([]);
  expect(readdirSync(input.stagingRoot)).toEqual([".keep"]);
  expect(readdirSync(input.artifactRoot)).toEqual([".keep"]);
  expect(readdirSync(input.artifactRoot).filter((entry) => entry.endsWith(".part"))).toEqual([]);
  expect(existsSync(input.outsideSentinel)).toBe(true);
}

beforeEach(() => {
  roots.length = 0;
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("real deck upload handler rejection boundary", () => {
  test.each([
    {
      name: "empty file",
      filename: "empty.pptx",
      contentType: PPTX_CONTENT_TYPE,
      body: new Uint8Array(),
      code: "empty_input",
      status: 400,
    },
    {
      name: "wrong extension",
      filename: "deck.txt",
      contentType: PPTX_CONTENT_TYPE,
      body: PPTX_MAGIC,
      code: "unsupported_extension",
      status: 400,
    },
    {
      name: "malformed PPTX",
      filename: "broken.pptx",
      contentType: PPTX_CONTENT_TYPE,
      body: new TextEncoder().encode("not-a-pptx"),
      code: "malformed_input",
      status: 400,
    },
    {
      name: "malformed PDF",
      filename: "broken.pdf",
      contentType: PDF_CONTENT_TYPE,
      body: new TextEncoder().encode("not-a-pdf"),
      code: "malformed_input",
      status: 400,
    },
  ] satisfies readonly {
    readonly name: string;
    readonly filename: string;
    readonly contentType: typeof PPTX_CONTENT_TYPE | typeof PDF_CONTENT_TYPE;
    readonly body: Uint8Array;
    readonly code: DeckUploadRejectionCode;
    readonly status: 400 | 413;
  }[])("returns a closed typed response for $name", async (upload) => {
    const input = fixture();
    const auth = await signIn(input.handler);

    const result = await rejectUpload(input, auth, upload);

    expect(result.status).toBe(upload.status);
    expect(result.payload).toEqual({ error: "deck_upload_rejected", code: upload.code });
    expect(JSON.stringify(result.payload)).not.toContain(input.stagingRoot);
    expect(JSON.stringify(result.payload)).not.toContain(upload.filename);
    assertClean(input);
  });

  test("returns 413 for a declared over-limit multipart request without reading its file", async () => {
    const input = fixture();
    const auth = await signIn(input.handler);
    const boundary = "declared-over-limit-boundary";

    const result = await rejectMultipartBody(
      input,
      auth,
      PPTX_MAGIC,
      `multipart/form-data; boundary=${boundary}`,
      MAX_DECK_UPLOAD_BYTES + 1024 * 1024,
    );

    expect(result.status).toBe(413);
    expect(result.payload).toEqual({
      error: "deck_upload_rejected",
      code: "input_too_large",
    });
    assertClean(input);
  });

  test("rejects an actual over-limit stream, cancels it, and removes upload.part", async () => {
    const input = fixture();
    const auth = await signIn(input.handler);
    const boundary = "over-limit-deck-boundary";
    const chunk = new Uint8Array(4 * 1024 * 1024);
    chunk.set(PPTX_MAGIC);
    const preamble = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="actual-large.pptx"\r\nContent-Type: ${PPTX_CONTENT_TYPE}\r\n\r\n`,
    );
    let chunks = 0;
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks += 1;
        controller.enqueue(chunks === 1 ? preamble : chunk);
      },
      cancel() {
        canceled = true;
      },
    });

    const result = await rejectMultipartBody(
      input,
      auth,
      body,
      `multipart/form-data; boundary=${boundary}`,
    );

    expect(result.status).toBe(413);
    expect(result.payload).toEqual({
      error: "deck_upload_rejected",
      code: "input_too_large",
    });
    expect(chunks).toBeGreaterThan(25);
    expect((chunks - 1) * chunk.byteLength).toBeGreaterThan(MAX_DECK_UPLOAD_BYTES);
    expect(canceled).toBe(true);
    assertClean(input);
  }, 30_000);

  test("rejects a path escape with the same closed response and no filesystem escape", async () => {
    const input = fixture();
    const auth = await signIn(input.handler);

    const result = await rejectUpload(input, auth, {
      filename: "../escaped.pptx",
      contentType: PPTX_CONTENT_TYPE,
      body: PPTX_MAGIC,
    });

    expect(result.status).toBe(400);
    expect(result.payload).toEqual({
      error: "deck_upload_rejected",
      code: "unsafe_filename",
    });
    expect(existsSync(join(input.stagingRoot, "..", "escaped.pptx"))).toBe(false);
    assertClean(input);
  });
});
