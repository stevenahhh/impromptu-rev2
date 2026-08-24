import { describe, expect, test } from "bun:test";
import {
  ReferenceDocumentListResponseSchema,
  ReferenceDocumentUploadOutcomeSchema,
} from "@impromptu/contracts/private";
import { PreparedEvidenceProjectionGateway } from "@impromptu/projection-gateway";
import { parsePrivateBackendConfig } from "../src/config.ts";
import {
  createPrivateBackendHandler,
  type PrivateBackendHandler,
  type PrivateBackendHttpDependencies,
  type RawReferenceDocument,
  type ReferenceDocumentService,
  type ReferenceDocumentSummary,
} from "../src/http.ts";
import { PreparedEvidenceCoordinator } from "../src/prepared-evidence.ts";

const origin = "https://console.example.test";
const config = parsePrivateBackendConfig({ CONSOLE_ORIGIN: origin });

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

function referenceHarness(outcomes: Map<string, unknown> = new Map()): {
  handler: PrivateBackendHandler;
  received: Parameters<ReferenceDocumentService["acceptReferenceDocuments"]>[0][];
  listed: Parameters<ReferenceDocumentService["listReferenceDocuments"]>[0][];
} {
  const received: Parameters<ReferenceDocumentService["acceptReferenceDocuments"]>[0][] = [];
  const listed: Parameters<ReferenceDocumentService["listReferenceDocuments"]>[0][] = [];
  const summary = (
    filename: string,
    overrides: Partial<ReferenceDocumentSummary> = {},
  ): ReferenceDocumentSummary => ({
    documentId: "d".repeat(64),
    presentationSessionId: "ps_reference",
    filename,
    contentType: "text/markdown",
    byteLength: 32,
    chunkCount: 1,
    status: "INDEXED",
    ...overrides,
  });
  const uploads: ReferenceDocumentService = {
    async acceptReferenceDocuments(input) {
      received.push(input);
      const keyed = outcomes.get("accept");
      if (keyed !== undefined)
        return keyed as Awaited<ReturnType<ReferenceDocumentService["acceptReferenceDocuments"]>>;
      return {
        outcome: "ACCEPTED",
        documents: input.documents.map((document: RawReferenceDocument) =>
          summary(document.filename),
        ),
      };
    },
    async listReferenceDocuments(input) {
      listed.push(input);
      return [summary("notes.md"), summary("brief.txt", { status: "EMPTY", chunkCount: 0 })];
    },
  };
  const dependencies = {
    coordinator: new PreparedEvidenceCoordinator(new PreparedEvidenceProjectionGateway()),
    identityVerifier: {
      async verifyCredentials() {
        return { accountId: "account_alpha", actorId: "actor_alpha" };
      },
    },
    internalAuthToken: "internal-test-token-reference",
    now: () => 1_000,
    referenceDocuments: uploads,
  } satisfies PrivateBackendHttpDependencies;
  return {
    handler: createPrivateBackendHandler(config, dependencies),
    received,
    listed,
  };
}

function referenceForm(): FormData {
  const form = new FormData();
  form.append(
    "files",
    new File([new TextEncoder().encode("# Brief\nQuarterly risk is 12%.")], "notes.md", {
      type: "text/markdown",
    }),
  );
  form.append(
    "files",
    new File([new TextEncoder().encode("Agenda: pricing review.")], "brief.txt", {
      type: "text/plain",
    }),
  );
  form.append("presentationSessionId", "ps_reference");
  return form;
}

async function signIn(handler: PrivateBackendHandler) {
  const response = await handler(
    request("/v1/account-sessions", {
      method: "POST",
      body: JSON.stringify({ username: "ref@example.test", password: "ref-password" }),
    }),
  );
  expect(response.status).toBe(201);
  const session = await response.json();
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined || typeof session.csrfToken !== "string") {
    throw new Error("sign-in failed");
  }
  return { cookie, csrfToken: session.csrfToken as string };
}

describe("reference document HTTP boundary", () => {
  test("accepts authenticated multi-file reference uploads and returns the closed contract", async () => {
    const { handler, received } = referenceHarness();
    const auth = await signIn(handler);

    const response = await handler(
      request("/v1/reference-documents", {
        method: "POST",
        headers: { Cookie: auth.cookie, "X-CSRF-Token": auth.csrfToken },
        body: referenceForm(),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(() => ReferenceDocumentUploadOutcomeSchema.parse(payload)).not.toThrow();
    expect(payload.outcome).toBe("ACCEPTED");
    expect(payload.documents.map((item: { filename: string }) => item.filename)).toEqual([
      "notes.md",
      "brief.txt",
    ]);
    expect(received.length).toBe(1);
    expect(received[0]?.accountId).toBe("account_alpha");
    expect(received[0]?.actorId).toBe("actor_alpha");
    expect(received[0]?.presentationSessionId).toBe("ps_reference");
    expect(received[0]?.documents.map((item) => item.filename)).toEqual(["notes.md", "brief.txt"]);
    expect(received[0]?.documents[0]?.bytes.byteLength).toBeGreaterThan(0);
  });

  test("requires an account session cookie for uploads", async () => {
    const { handler } = referenceHarness();
    const response = await handler(
      request("/v1/reference-documents", { method: "POST", body: referenceForm() }),
    );
    expect(response.status).toBe(401);
  });

  test("rejects uploads without the synchronizer CSRF token", async () => {
    const { handler } = referenceHarness();
    const auth = await signIn(handler);
    const response = await handler(
      request("/v1/reference-documents", {
        method: "POST",
        headers: { Cookie: auth.cookie },
        body: referenceForm(),
      }),
    );
    expect(response.status).toBe(403);
  });

  test("rejects non-multipart upload requests", async () => {
    const { handler } = referenceHarness();
    const auth = await signIn(handler);
    const response = await handler(
      request("/v1/reference-documents", {
        method: "POST",
        headers: {
          Cookie: auth.cookie,
          "X-CSRF-Token": auth.csrfToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(400);
  });

  test("maps closed rejection outcomes onto stable status codes", async () => {
    for (const [reason, status] of [
      ["UNSUPPORTED_TYPE", 400],
      ["UNSAFE_FILENAME", 400],
      ["TOO_MANY_FILES", 400],
      ["EMPTY_INPUT", 400],
      ["TOO_LARGE", 413],
      ["EXTRACTION_FAILED", 422],
      ["PRESENTATION_UNKNOWN", 404],
    ] as const) {
      const outcomes = new Map<string, unknown>([["accept", { outcome: "REJECTED", reason }]]);
      const { handler } = referenceHarness(outcomes);
      const auth = await signIn(handler);
      const response = await handler(
        request("/v1/reference-documents", {
          method: "POST",
          headers: { Cookie: auth.cookie, "X-CSRF-Token": auth.csrfToken },
          body: referenceForm(),
        }),
      );
      const payload = await response.json();
      expect(response.status, reason).toBe(status);
      expect(payload.outcome).toBe("REJECTED");
      expect(payload.reason).toBe(reason);
    }
  });

  test("lists the session's uploaded reference documents behind authentication", async () => {
    const { handler, listed } = referenceHarness();
    const auth = await signIn(handler);

    const response = await handler(
      request("/v1/reference-documents?presentationSessionId=ps_reference", {
        method: "GET",
        headers: { Cookie: auth.cookie },
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(() => ReferenceDocumentListResponseSchema.parse(payload)).not.toThrow();
    expect(payload.documents.length).toBe(2);
    expect(listed[0]?.accountId).toBe("account_alpha");
    expect(listed[0]?.presentationSessionId).toBe("ps_reference");
  });

  test("requires a presentation session filter for listings", async () => {
    const { handler } = referenceHarness();
    const auth = await signIn(handler);
    const response = await handler(
      request("/v1/reference-documents", { method: "GET", headers: { Cookie: auth.cookie } }),
    );
    expect(response.status).toBe(400);
  });

  test("reports the capability as unavailable when no service is configured", async () => {
    const dependencies = {
      coordinator: new PreparedEvidenceCoordinator(new PreparedEvidenceProjectionGateway()),
      identityVerifier: {
        async verifyCredentials() {
          return { accountId: "account_alpha", actorId: "actor_alpha" };
        },
      },
      internalAuthToken: "internal-test-token-reference",
      now: () => 1_000,
    } satisfies PrivateBackendHttpDependencies;
    const handler = createPrivateBackendHandler(config, dependencies);
    const auth = await signIn(handler);
    const upload = await handler(
      request("/v1/reference-documents", {
        method: "POST",
        headers: { Cookie: auth.cookie, "X-CSRF-Token": auth.csrfToken },
        body: referenceForm(),
      }),
    );
    expect(upload.status).toBe(503);
  });
});
