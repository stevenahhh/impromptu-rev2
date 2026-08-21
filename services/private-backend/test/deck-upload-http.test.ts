import { describe, expect, test } from "bun:test";
import { PrivateDeckContextSchema } from "@impromptu/contracts/private";
import { PublishedDeckArtifactSchema } from "@impromptu/contracts/public";
import { PreparedEvidenceProjectionGateway } from "@impromptu/projection-gateway";
import type { z } from "zod";
import { parsePrivateBackendConfig } from "../src/config.ts";
import { DeckUploadWorkerError } from "../src/deck-upload-worker.ts";
import {
  createPrivateBackendHandler,
  type PrivateBackendHandler,
  type PrivateBackendHttpDependencies,
} from "../src/http.ts";
import { PreparedEvidenceCoordinator } from "../src/prepared-evidence.ts";

const origin = "https://console.example.test";
const config = parsePrivateBackendConfig({ CONSOLE_ORIGIN: origin });

const PPTX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const PDF_CONTENT_TYPE = "application/pdf";
const UPLOAD_CONTENT_TYPES = [PPTX_CONTENT_TYPE, PDF_CONTENT_TYPE] as const;
type DeckContentType = (typeof UPLOAD_CONTENT_TYPES)[number];

interface RawDeckUpload {
  readonly filename: string;
  readonly contentType: DeckContentType;
  readonly byteLength?: number;
  readonly body: ReadableStream<Uint8Array>;
}

interface DeckUploadReceipt {
  readonly privateDeck: z.infer<typeof PrivateDeckContextSchema>;
  readonly publicDeck: z.infer<typeof PublishedDeckArtifactSchema>;
  readonly sourceHash: string;
}

interface DeckUploadService {
  acceptRawDeck(input: {
    readonly accountId: string;
    readonly actorId: string;
    readonly upload: RawDeckUpload;
  }): Promise<DeckUploadReceipt>;
}

function request(path: string, init: RequestInit = {}) {
  return new Request(`https://private.example.test${path}`, {
    ...init,
    headers: {
      Origin: origin,
      Referer: `${origin}/decks`,
      ...init.headers,
    },
  });
}

function uploadForm(filename: string, contentType: DeckContentType, bytes: Uint8Array): FormData {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const form = new FormData();
  form.append("file", new File([copy.buffer], filename, { type: contentType }));
  return form;
}

function multipartPreamble(
  boundary: string,
  filename: string,
  contentType: DeckContentType,
  fieldName = "file",
): Uint8Array {
  return new TextEncoder().encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
}

function multipartClosing(boundary: string): Uint8Array {
  return new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
}

function uploadHarness(onFileChunk?: () => void, uploadFailure?: Error) {
  let lastInput: Parameters<DeckUploadService["acceptRawDeck"]>[0] | null = null;
  let received: Uint8Array | null = null;
  const sourceHash = "e".repeat(64);
  const receipt: DeckUploadReceipt = {
    privateDeck: PrivateDeckContextSchema.parse({
      deckId: `private_deck_${"a".repeat(64)}`,
      deckVersion: `deck_${"b".repeat(64)}`,
      manifestHash: sourceHash,
      title: "Quarterly review",
      ownerAccountId: "account_alpha",
      aclPolicyVersion: "acl-1",
      privateObjectPrefix: "private-decks/account_alpha/quarterly-review",
      slides: [
        {
          privateSlideId: `private_slide_${"c".repeat(64)}`,
          publicSlideKey: `slide_${"d".repeat(64)}`,
          ordinal: 1,
          speakerNotes: "",
          extractedText: "Revenue grew 42%.",
          sourceAssetIds: [`asset_${"d".repeat(64)}`],
        },
      ],
    }),
    publicDeck: PublishedDeckArtifactSchema.parse({
      deckVersion: `deck_${"b".repeat(64)}`,
      manifestHash: sourceHash,
      title: "Quarterly review",
      slides: [
        {
          publicSlideKey: `slide_${"d".repeat(64)}`,
          ordinal: 1,
          image: {
            url: "https://public.example.test/slides/quarterly-review.png",
            contentHash: "f".repeat(64),
            width: 1920,
            height: 1080,
          },
          accessibilityLabel: "Quarterly review",
        },
      ],
    }),
    sourceHash,
  };
  const uploads: DeckUploadService = {
    async acceptRawDeck(input) {
      lastInput = input;
      const chunks: Uint8Array[] = [];
      const reader = input.upload.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) {
          chunks.push(value);
          onFileChunk?.();
        }
      }
      const actual = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) {
        actual.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (input.upload.byteLength !== undefined && actual.byteLength !== input.upload.byteLength) {
        throw new Error(
          `declared ${input.upload.byteLength} bytes but streamed ${actual.byteLength}`,
        );
      }
      received = actual;
      if (uploadFailure !== undefined) throw uploadFailure;
      return receipt;
    },
  };
  const dependencies = {
    coordinator: new PreparedEvidenceCoordinator(new PreparedEvidenceProjectionGateway()),
    identityVerifier: {
      async verifyCredentials() {
        return { accountId: "account_alpha", actorId: "actor_alpha" };
      },
    },
    internalAuthToken: "internal-test-token-uploads",
    now: () => 1_000,
    uploads,
  } satisfies PrivateBackendHttpDependencies & { readonly uploads: DeckUploadService };
  return {
    handler: createPrivateBackendHandler(config, dependencies),
    receipt,
    lastInput: () => lastInput,
    receivedBytes: () => received,
  };
}

async function signIn(handler: PrivateBackendHandler) {
  const response = await handler(
    request("/v1/account-sessions", {
      method: "POST",
      body: JSON.stringify({ username: "upload@example.test", password: "upload-password" }),
    }),
  );
  expect(response.status).toBe(201);
  const session = await response.json();
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined || typeof session.csrfToken !== "string") {
    throw new Error("sign-in failed");
  }
  return { cookie, csrfToken: session.csrfToken };
}

function authenticatedHeaders(auth: Awaited<ReturnType<typeof signIn>>): HeadersInit {
  return { Cookie: auth.cookie, "X-CSRF-Token": auth.csrfToken };
}

function waitForSignal(signal: Promise<void>, description: string): Promise<void> {
  const timeout = AbortSignal.timeout(2_000);
  return Promise.race([
    signal,
    new Promise<never>((_resolve, reject) => {
      timeout.addEventListener(
        "abort",
        () => reject(new Error(`timed out waiting for ${description}`)),
        { once: true },
      );
    }),
  ]);
}

describe("multipart deck upload HTTP boundary", () => {
  test("accepts an authenticated multipart PPTX and passes only its file stream to the upload service", async () => {
    const { handler, receipt, lastInput, receivedBytes } = uploadHarness();
    const auth = await signIn(handler);
    const bytes = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x50, 0x50, 0x54, 0x58, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);

    const response = await handler(
      request("/v1/deck-uploads", {
        method: "POST",
        headers: authenticatedHeaders(auth),
        body: uploadForm("quarterly-review.pptx", PPTX_CONTENT_TYPE, bytes),
      }),
    );

    expect(response.status).toBe(201);
    const payload = (await response.json()) as DeckUploadReceipt & {
      readonly presentationSessionId: string;
      readonly deckVersion: string;
    };
    expect(payload).toMatchObject(receipt);
    expect(payload.presentationSessionId).toMatch(/^ps_/);
    expect(payload.deckVersion).toBe(receipt.privateDeck.deckVersion);

    const input = lastInput();
    expect(input).not.toBeNull();
    expect(input?.accountId).toBe("account_alpha");
    expect(input?.actorId).toBe("actor_alpha");
    expect(input?.upload.filename).toBe("quarterly-review.pptx");
    expect(input?.upload.contentType).toBe(PPTX_CONTENT_TYPE);
    expect(input?.upload.byteLength).toBeUndefined();
    expect(receivedBytes()).toEqual(bytes);
  });

  test("accepts an authenticated multipart PDF with its exact filename and MIME", async () => {
    const { handler, lastInput, receivedBytes } = uploadHarness();
    const auth = await signIn(handler);
    const bytes = new Uint8Array([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a,
    ]);

    const response = await handler(
      request("/v1/deck-uploads", {
        method: "POST",
        headers: authenticatedHeaders(auth),
        body: uploadForm("board handout.PDF", PDF_CONTENT_TYPE, bytes),
      }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ sourceHash: "e".repeat(64) });
    expect(lastInput()?.upload.contentType).toBe(PDF_CONTENT_TYPE);
    expect(lastInput()?.upload.filename).toBe("board handout.PDF");
    expect(receivedBytes()).toEqual(bytes);
  });

  test("starts consuming a chunked file part before the multipart request finishes", async () => {
    let signalFirstChunk!: () => void;
    const firstChunk = new Promise<void>((resolve) => {
      signalFirstChunk = resolve;
    });
    let firstChunkSeen = false;
    const { handler, receivedBytes } = uploadHarness(() => {
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        signalFirstChunk();
      }
    });
    const auth = await signIn(handler);
    const boundary = "streaming-deck-boundary";
    const bytes = new Uint8Array(256);
    bytes.set([0x50, 0x4b, 0x03, 0x04, 0x14]);
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
    });
    const uploadRequest = request("/v1/deck-uploads", {
      method: "POST",
      headers: {
        ...authenticatedHeaders(auth),
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    for (const method of ["formData", "arrayBuffer", "blob", "text"] as const) {
      Object.defineProperty(uploadRequest, method, {
        value() {
          throw new Error(`request.${method} must not be used for multipart deck uploads`);
        },
      });
    }

    const responsePending = handler(uploadRequest);
    bodyController.enqueue(multipartPreamble(boundary, "streamed.pptx", PPTX_CONTENT_TYPE));
    bodyController.enqueue(bytes);
    await waitForSignal(firstChunk, "the upload service to read the first file chunk");
    bodyController.enqueue(multipartClosing(boundary));
    bodyController.close();

    const response = await responsePending;
    expect(response.status).toBe(201);
    expect(receivedBytes()).toEqual(bytes);
  });

  test("rejects raw uploads and malformed multipart envelopes instead of retaining a second API", async () => {
    const { handler, lastInput } = uploadHarness();
    const auth = await signIn(handler);
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

    const raw = await handler(
      request("/v1/deck-uploads", {
        method: "POST",
        headers: { ...authenticatedHeaders(auth), "Content-Type": PDF_CONTENT_TYPE },
        body: bytes,
      }),
    );
    expect(raw.status).toBe(400);
    expect(await raw.json()).toEqual({ error: "unsupported_content_type" });

    const missingBoundary = await handler(
      request("/v1/deck-uploads", {
        method: "POST",
        headers: {
          ...authenticatedHeaders(auth),
          "Content-Type": "multipart/form-data",
        },
        body: bytes,
      }),
    );
    expect(missingBoundary.status).toBe(400);
    expect(lastInput()).toBeNull();
  });

  test("maps a typed OCR failure to the dedicated 422 boundary response", async () => {
    const { handler } = uploadHarness(
      undefined,
      new DeckUploadWorkerError(
        "ocr_unavailable",
        "Renderer failed (ocr_unavailable): private OCR diagnostic",
      ),
    );
    const auth = await signIn(handler);
    const response = await handler(
      request("/v1/deck-uploads", {
        method: "POST",
        headers: authenticatedHeaders(auth),
        body: uploadForm("scanned.pdf", PDF_CONTENT_TYPE, new TextEncoder().encode("%PDF-1.7")),
      }),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "OCR_UNAVAILABLE" });
  });

  test("accepts only one file field and validates its filename/MIME pair", async () => {
    const { handler } = uploadHarness();
    const auth = await signIn(handler);
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14]);

    const extraFile = new FormData();
    extraFile.append("file", new File([bytes], "first.pptx", { type: PPTX_CONTENT_TYPE }));
    extraFile.append("file", new File([bytes], "second.pptx", { type: PPTX_CONTENT_TYPE }));
    const extraFileResponse = await handler(
      request("/v1/deck-uploads", {
        method: "POST",
        headers: authenticatedHeaders(auth),
        body: extraFile,
      }),
    );
    expect(extraFileResponse.status).toBe(400);
    expect(await extraFileResponse.json()).toEqual({
      error: "deck_upload_rejected",
      code: "malformed_input",
    });

    const extraField = uploadForm("deck.pptx", PPTX_CONTENT_TYPE, bytes);
    extraField.append("caption", "not accepted");
    const extraFieldResponse = await handler(
      request("/v1/deck-uploads", {
        method: "POST",
        headers: authenticatedHeaders(auth),
        body: extraField,
      }),
    );
    expect(extraFieldResponse.status).toBe(400);
    expect(await extraFieldResponse.json()).toEqual({
      error: "deck_upload_rejected",
      code: "malformed_input",
    });

    const mismatch = await handler(
      request("/v1/deck-uploads", {
        method: "POST",
        headers: authenticatedHeaders(auth),
        body: uploadForm("deck.pdf", PPTX_CONTENT_TYPE, bytes),
      }),
    );
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toEqual({
      error: "deck_upload_rejected",
      code: "malformed_input",
    });
  });

  test("preserves exact origin, account cookie, and synchronizer CSRF requirements", async () => {
    const { handler } = uploadHarness();
    const auth = await signIn(handler);
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14]);

    const missingReferer = await handler(
      new Request("https://private.example.test/v1/deck-uploads", {
        method: "POST",
        headers: { Origin: origin },
        body: uploadForm("deck.pptx", PPTX_CONTENT_TYPE, bytes),
      }),
    );
    expect(missingReferer.status).toBe(403);

    const crossOrigin = await handler(
      request("/v1/deck-uploads", {
        method: "POST",
        headers: { Origin: "https://attacker.example.test" },
        body: uploadForm("deck.pptx", PPTX_CONTENT_TYPE, bytes),
      }),
    );
    expect(crossOrigin.status).toBe(403);

    const withoutCookie = await handler(
      request("/v1/deck-uploads", {
        method: "POST",
        headers: { "X-CSRF-Token": auth.csrfToken },
        body: uploadForm("deck.pptx", PPTX_CONTENT_TYPE, bytes),
      }),
    );
    expect(withoutCookie.status).toBe(401);

    const withoutCsrf = await handler(
      request("/v1/deck-uploads", {
        method: "POST",
        headers: { Cookie: auth.cookie },
        body: uploadForm("deck.pptx", PPTX_CONTENT_TYPE, bytes),
      }),
    );
    expect(withoutCsrf.status).toBe(403);
  });
});
