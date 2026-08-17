import { expect, test } from "bun:test";
import type { DeckUploadProgress, DeckUploadProgressEvent, DeckUploadXhr } from "./session-client";
import { createConsoleSessionClient, DeckUploadError } from "./session-client";

const PPTX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const PDF_CONTENT_TYPE = "application/pdf";

function deckFile(name = "quarterly-review.pptx", type = PPTX_CONTENT_TYPE): File {
  return new File(["fake deck bytes"], name, { type });
}

interface UploadHarness {
  readonly transport: DeckUploadXhr;
  readonly opened: Array<{ readonly method: string; readonly url: string }>;
  readonly headers: ReadonlyMap<string, string>;
  readonly sent: readonly unknown[];
  readonly aborts: number;
  progress(loaded: number, total: number): void;
  complete(status: number, body: unknown): void;
  failNetwork(): void;
}

function createUploadHarness(): UploadHarness {
  const opened: Array<{ readonly method: string; readonly url: string }> = [];
  const headers = new Map<string, string>();
  const sent: unknown[] = [];
  const upload: { onprogress: ((event: DeckUploadProgressEvent) => void) | null } = {
    onprogress: null,
  };
  let aborts = 0;
  const transport: DeckUploadXhr = {
    withCredentials: false,
    status: 0,
    responseText: "",
    upload,
    onload: null,
    onerror: null,
    onabort: null,
    ontimeout: null,
    open(method, url) {
      opened.push({ method, url });
    },
    setRequestHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    send(body) {
      sent.push(body);
    },
    abort() {
      aborts += 1;
      transport.onabort?.({});
    },
  };
  return {
    transport,
    opened,
    headers,
    sent,
    get aborts() {
      return aborts;
    },
    progress(loaded, total) {
      transport.upload.onprogress?.({ loaded, total });
    },
    complete(status, body) {
      transport.status = status;
      transport.responseText = typeof body === "string" ? body : JSON.stringify(body);
      transport.onload?.({});
    },
    failNetwork() {
      transport.onerror?.({});
    },
  };
}

function rejectionOf(upload: Promise<unknown>): Promise<unknown> {
  return upload.then(
    (value) => {
      throw new Error(`expected rejection, received ${JSON.stringify(value)}`);
    },
    (cause: unknown) => cause,
  );
}

test("Console recommendation client calls the authenticated private HTTP route", async () => {
  const originalFetch = globalThis.fetch;
  const received: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    received.push({ url: String(input), init: init ?? {} });
    return new Response(
      JSON.stringify({
        outcome: "ABSTAIN",
        reason: "INSUFFICIENT_EVIDENCE",
        completedAtMs: 100,
        latencyMs: 20,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const result = await createConsoleSessionClient("https://private.example.test").recommend(
      "csrf-token",
      {
        query: "revenue",
        deckVersion: "deck_v1",
        manifestHash: "a".repeat(64),
        maxResults: 3,
      },
    );
    expect(result).toMatchObject({ outcome: "ABSTAIN", reason: "INSUFFICIENT_EVIDENCE" });
    const call = received[0];
    if (call === undefined) throw new Error("recommendation request was not sent");
    expect(call.url).toBe("https://private.example.test/v1/recommendations");
    expect(call.init).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", "x-csrf-token": "csrf-token" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createConsoleSessionClient exposes a typed uploadDeck method", () => {
  const client = createConsoleSessionClient();
  expect(typeof client.uploadDeck).toBe("function");
});

test("uploadDeck sends a PPTX as one multipart file part over credentialed XHR", async () => {
  const harness = createUploadHarness();
  const file = deckFile("quarterly-review.pptx");
  const upload = createConsoleSessionClient("https://private.example.test").uploadDeck(
    "csrf-upload",
    file,
    { transport: harness.transport },
  );

  expect(harness.opened).toEqual([
    { method: "POST", url: "https://private.example.test/v1/deck-uploads" },
  ]);
  expect(harness.transport.withCredentials).toBe(true);
  // XMLHttpRequest must generate the multipart boundary and Content-Length.
  expect(harness.headers.has("content-type")).toBe(false);
  expect(harness.headers.has("content-length")).toBe(false);
  expect(harness.headers.has("x-filename")).toBe(false);
  expect(harness.headers).toEqual(new Map([["x-csrf-token", "csrf-upload"]]));
  expect(harness.sent).toHaveLength(1);
  expect(harness.sent[0]).toBeInstanceOf(FormData);
  const parts = [...(harness.sent[0] as FormData).entries()];
  expect(parts).toHaveLength(1);
  expect(parts[0]?.[0]).toBe("file");
  expect(parts[0]?.[1]).toBeInstanceOf(File);
  expect(parts[0]?.[1]).toMatchObject({
    name: file.name,
    type: file.type,
    size: file.size,
  });

  harness.complete(201, {
    presentationSessionId: "ps_deck-upload-1",
    deckVersion: "deck-v1",
    sourceHash: "a".repeat(64),
    privateDeck: { deckId: "private_deck-1" },
    publicDeck: { deckVersion: "deck-v1" },
  });
  const view = await upload;
  expect(view).toEqual({
    presentationSessionId: "ps_deck-upload-1",
    deckVersion: "deck-v1",
    sourceHash: "a".repeat(64),
    privateDeck: { deckId: "private_deck-1" },
    publicDeck: { deckVersion: "deck-v1" },
  });
  expect(harness.aborts).toBe(0);
});

test("uploadDeck preserves PDF filename and MIME inside the multipart file part", async () => {
  const harness = createUploadHarness();
  const file = deckFile("rehearsal handout.pdf", PDF_CONTENT_TYPE);
  const upload = createConsoleSessionClient("https://private.example.test").uploadDeck(
    "csrf-pdf",
    file,
    { transport: harness.transport },
  );

  expect(harness.headers).toEqual(new Map([["x-csrf-token", "csrf-pdf"]]));
  const form = harness.sent[0];
  expect(form).toBeInstanceOf(FormData);
  const part = (form as FormData).get("file");
  expect(part).toBeInstanceOf(File);
  expect(part).toMatchObject({
    name: "rehearsal handout.pdf",
    type: PDF_CONTENT_TYPE,
    size: file.size,
  });
  harness.complete(201, { presentationSessionId: "ps_pdf-1", deckVersion: "deck_pdf" });
  await expect(upload).resolves.toMatchObject({
    presentationSessionId: "ps_pdf-1",
    deckVersion: "deck_pdf",
  });
});

test("uploadDeck strictly parses the typed 201 receipt requiring nonempty session identity", async () => {
  const invalidBodies: unknown[] = [
    "not json",
    null,
    [],
    {},
    { presentationSessionId: "" },
    { presentationSessionId: "ps_1", deckVersion: "" },
    { presentationSessionId: "", deckVersion: "deck_v1" },
    { deckVersion: "deck_v1" },
    { presentationSessionId: "ps_1" },
  ];
  for (const body of invalidBodies) {
    const harness = createUploadHarness();
    const upload = createConsoleSessionClient("https://private.example.test").uploadDeck(
      "csrf-strict",
      deckFile(),
      { transport: harness.transport },
    );
    harness.complete(201, body);
    const rejection = await rejectionOf(upload);
    expect(rejection).toBeInstanceOf(DeckUploadError);
    expect(rejection).toMatchObject({ code: "invalid_upload_receipt", status: 201 });
  }
});

test("uploadDeck rejects non-201 responses as typed backend errors", async () => {
  const harness = createUploadHarness();
  const upload = createConsoleSessionClient("https://private.example.test").uploadDeck(
    "csrf-error",
    deckFile(),
    { transport: harness.transport },
  );
  harness.complete(400, { error: "deck_upload_rejected" });

  const rejection = await rejectionOf(upload);
  expect(rejection).toBeInstanceOf(DeckUploadError);
  expect(rejection).toMatchObject({ code: "deck_upload_rejected", status: 400 });
  expect((rejection as Error).message).toBe("deck_upload_rejected");
});

test("uploadDeck maps server and non-JSON failures to deterministic error codes", async () => {
  const cases = [
    { status: 503, body: { error: "uploads_unavailable" }, code: "uploads_unavailable" },
    { status: 401, body: "forbidden", code: "upload_rejected" },
    { status: 400, body: { detail: "no error code" }, code: "upload_rejected" },
  ];
  for (const { status, body, code } of cases) {
    const harness = createUploadHarness();
    const upload = createConsoleSessionClient("https://private.example.test").uploadDeck(
      "csrf-map",
      deckFile(),
      { transport: harness.transport },
    );
    harness.complete(status, body);
    const rejection = await rejectionOf(upload);
    expect(rejection).toBeInstanceOf(DeckUploadError);
    expect(rejection).toMatchObject({ code, status });
  }
});

test("uploadDeck emits deterministic progress for each XHR upload progress event", async () => {
  const harness = createUploadHarness();
  const progress: DeckUploadProgress[] = [];
  const upload = createConsoleSessionClient("https://private.example.test").uploadDeck(
    "csrf-progress",
    deckFile(),
    { transport: harness.transport, onProgress: (event) => progress.push(event) },
  );

  expect(harness.transport.upload.onprogress).not.toBeNull();
  harness.progress(64, 100);
  harness.progress(100, 100);
  harness.complete(201, { presentationSessionId: "ps_progress-1", deckVersion: "deck_v1" });
  await upload;

  expect(progress).toEqual([
    { loadedBytes: 64, totalBytes: 100 },
    { loadedBytes: 100, totalBytes: 100 },
  ]);
  harness.progress(200, 100);
  expect(progress).toHaveLength(2);
});

test("uploadDeck aborts the transport when the AbortSignal fires", async () => {
  const harness = createUploadHarness();
  const controller = new AbortController();
  const upload = createConsoleSessionClient("https://private.example.test").uploadDeck(
    "csrf-abort",
    deckFile(),
    { transport: harness.transport, signal: controller.signal },
  );
  controller.abort();

  const rejection = await rejectionOf(upload);
  expect(rejection).toMatchObject({ name: "AbortError" });
  expect(harness.aborts).toBe(1);
});

test("uploadDeck rejects before network when the signal is already aborted", async () => {
  const harness = createUploadHarness();
  const controller = new AbortController();
  controller.abort();
  const upload = createConsoleSessionClient("https://private.example.test").uploadDeck(
    "csrf-preabort",
    deckFile(),
    { transport: harness.transport, signal: controller.signal },
  );

  await expect(upload).rejects.toMatchObject({ name: "AbortError" });
  expect(harness.opened).toHaveLength(0);
  expect(harness.aborts).toBe(0);
});

test("uploadDeck surfaces transport failures as typed errors", async () => {
  const harness = createUploadHarness();
  const upload = createConsoleSessionClient("https://private.example.test").uploadDeck(
    "csrf-net",
    deckFile(),
    { transport: harness.transport },
  );
  harness.failNetwork();

  const rejection = await rejectionOf(upload);
  expect(rejection).toBeInstanceOf(DeckUploadError);
  expect(rejection).toMatchObject({ code: "network_error", status: 0 });
});

test("uploadDeck rejects unsupported deck inputs before any network activity", async () => {
  const unsupported = [
    deckFile("notes.txt", "text/plain"),
    deckFile("deck.pptx", ""),
    new File(["bytes"], "", { type: PPTX_CONTENT_TYPE }),
  ];
  for (const file of unsupported) {
    const harness = createUploadHarness();
    const upload = createConsoleSessionClient("https://private.example.test").uploadDeck(
      "csrf-validation",
      file,
      { transport: harness.transport },
    );
    await expect(upload).rejects.toBeInstanceOf(DeckUploadError);
    await expect(upload).rejects.toMatchObject({ code: "unsupported_deck_file", status: 0 });
    expect(harness.opened).toHaveLength(0);
    expect(harness.sent).toHaveLength(0);
  }
});
