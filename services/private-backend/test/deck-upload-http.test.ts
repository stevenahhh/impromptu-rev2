import { describe, expect, test } from "bun:test";
import { PrivateDeckContextSchema } from "@impromptu/contracts/private";
import { PublishedDeckArtifactSchema } from "@impromptu/contracts/public";
import { PreparedEvidenceProjectionGateway } from "@impromptu/projection-gateway";
import type { z } from "zod";
import { parsePrivateBackendConfig } from "../src/config.ts";
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
type RawDeckContentType = (typeof UPLOAD_CONTENT_TYPES)[number];

interface RawDeckUpload {
  readonly filename: string;
  readonly contentType: RawDeckContentType;
  readonly byteLength: number;
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

function uploadHarness() {
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
        if (value !== undefined) chunks.push(value);
      }
      const actual = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) {
        actual.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (actual.byteLength !== input.upload.byteLength) {
        throw new Error(
          `declared ${input.upload.byteLength} bytes but streamed ${actual.byteLength}`,
        );
      }
      received = actual;
      return receipt;
    },
  };
  const dependencies = {
    coordinator: new PreparedEvidenceCoordinator(new PreparedEvidenceProjectionGateway()),
    identityVerifier: {
      async exchangeAuthorizationCode() {
        return { accountId: "account_alpha", actorId: "actor_alpha" };
      },
    },
    internalAuthToken: "internal-test-token-uploads",
    now: () => 1_000,
    uploads,
  } satisfies PrivateBackendHttpDependencies & { readonly uploads: DeckUploadService };
  return {
    handler: createPrivateBackendHandler(config, dependencies),
    uploads,
    receipt,
    lastInput: () => lastInput,
    receivedBytes: () => received,
  };
}

async function signIn(handler: PrivateBackendHandler) {
  const response = await handler(
    request("/v1/account-sessions", {
      method: "POST",
      body: JSON.stringify({ authorizationCode: "upload-code" }),
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

describe("raw deck upload HTTP boundary", () => {
  test("accepts an authenticated raw PPTX upload and returns a typed 201 from the injected upload service", async () => {
    const { handler, receipt, lastInput, receivedBytes } = uploadHarness();
    const { cookie, csrfToken } = await signIn(handler);
    const bytes = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x50, 0x50, 0x54, 0x58, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);

    const response = await handler(
      request("/v1/deck-uploads", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "X-CSRF-Token": csrfToken,
          "Content-Type": PPTX_CONTENT_TYPE,
          "Content-Length": String(bytes.byteLength),
          "X-Filename": "quarterly-review.pptx",
        },
        body: bytes,
      }),
    );

    expect(response.status).toBe(201);
    const payload = await response.json();
    const privateDeck = PrivateDeckContextSchema.parse(payload.privateDeck);
    const publicDeck = PublishedDeckArtifactSchema.parse(payload.publicDeck);
    expect(payload).toEqual(receipt);
    expect(String(privateDeck.ownerAccountId)).toBe("account_alpha");
    expect(publicDeck.slides).toHaveLength(1);

    const input = lastInput();
    expect(input).not.toBeNull();
    expect(input?.accountId).toBe("account_alpha");
    expect(input?.actorId).toBe("actor_alpha");
    expect(input?.upload.filename).toBe("quarterly-review.pptx");
    expect(input?.upload.contentType).toBe(PPTX_CONTENT_TYPE);
    expect(input?.upload.byteLength).toBe(bytes.byteLength);
    expect(receivedBytes()).toEqual(bytes);
  });

  test("accepts an authenticated raw PDF upload", async () => {
    const { handler, lastInput, receivedBytes } = uploadHarness();
    const { cookie, csrfToken } = await signIn(handler);
    const bytes = new Uint8Array([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a,
    ]);

    const response = await handler(
      request("/v1/deck-uploads", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "X-CSRF-Token": csrfToken,
          "Content-Type": PDF_CONTENT_TYPE,
          "Content-Length": String(bytes.byteLength),
          "X-Filename": "handout.pdf",
        },
        body: bytes,
      }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ sourceHash: "e".repeat(64) });
    expect(lastInput()?.upload.contentType).toBe(PDF_CONTENT_TYPE);
    expect(lastInput()?.upload.filename).toBe("handout.pdf");
    expect(lastInput()?.upload.byteLength).toBe(bytes.byteLength);
    expect(receivedBytes()).toEqual(bytes);
  });

  test("streams the raw upload body without ever materializing it via request.arrayBuffer", async () => {
    const { handler, lastInput, receivedBytes } = uploadHarness();
    const { cookie, csrfToken } = await signIn(handler);
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);
    const uploadRequest = request("/v1/deck-uploads", {
      method: "POST",
      headers: {
        Cookie: cookie,
        "X-CSRF-Token": csrfToken,
        "Content-Type": PPTX_CONTENT_TYPE,
        "Content-Length": String(bytes.byteLength),
        "X-Filename": "streamed.pptx",
      },
      body: bytes,
    });
    Object.defineProperty(uploadRequest, "arrayBuffer", {
      value() {
        throw new Error("request.arrayBuffer must not be used for raw deck uploads");
      },
    });

    const response = await handler(uploadRequest);

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ sourceHash: "e".repeat(64) });
    expect(lastInput()?.upload.filename).toBe("streamed.pptx");
    expect(receivedBytes()).toEqual(bytes);
  });

  test("requires content-length, content-type, and filename metadata on raw uploads", async () => {
    const { handler } = uploadHarness();
    const { cookie, csrfToken } = await signIn(handler);
    const body = new Uint8Array([1, 2, 3]);
    const send = (headers: Record<string, string>) =>
      handler(
        request("/v1/deck-uploads", {
          method: "POST",
          headers: { Cookie: cookie, "X-CSRF-Token": csrfToken, ...headers },
          body,
        }),
      );

    const missingFilename = await send({
      "Content-Type": PPTX_CONTENT_TYPE,
      "Content-Length": "3",
    });
    expect(missingFilename.status).toBe(400);

    const missingContentLength = await send({
      "Content-Type": PPTX_CONTENT_TYPE,
      "X-Filename": "deck.pptx",
    });
    expect(missingContentLength.status).toBe(400);

    const mismatchedContentLength = await send({
      "Content-Type": PPTX_CONTENT_TYPE,
      "Content-Length": "999",
      "X-Filename": "deck.pptx",
    });
    expect(mismatchedContentLength.status).toBe(400);

    const unsupportedContentType = await send({
      "Content-Type": "text/plain",
      "Content-Length": "3",
      "X-Filename": "deck.txt",
    });
    expect(unsupportedContentType.status).toBe(400);
  });

  test("preserves exact origin and synchronizer CSRF requirements for raw uploads", async () => {
    const { handler } = uploadHarness();
    const { cookie, csrfToken } = await signIn(handler);
    const bytes = new Uint8Array([1, 2, 3]);
    const uploadHeaders = {
      "Content-Type": PPTX_CONTENT_TYPE,
      "Content-Length": "3",
      "X-Filename": "deck.pptx",
    };

    const missingReferer = await handler(
      new Request("https://private.example.test/v1/deck-uploads", {
        method: "POST",
        headers: { Origin: origin },
        body: bytes,
      }),
    );
    expect(missingReferer.status).toBe(403);

    const crossOrigin = await handler(
      request("/v1/deck-uploads", {
        method: "POST",
        headers: { Origin: "https://attacker.example.test", ...uploadHeaders },
        body: bytes,
      }),
    );
    expect(crossOrigin.status).toBe(403);

    const withoutCookie = await handler(
      request("/v1/deck-uploads", {
        method: "POST",
        headers: { "X-CSRF-Token": csrfToken, ...uploadHeaders },
        body: bytes,
      }),
    );
    expect(withoutCookie.status).toBe(401);

    const withoutCsrf = await handler(
      request("/v1/deck-uploads", {
        method: "POST",
        headers: { Cookie: cookie, ...uploadHeaders },
        body: bytes,
      }),
    );
    expect(withoutCsrf.status).toBe(403);
  });
});
