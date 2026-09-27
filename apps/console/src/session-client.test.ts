import { expect, test } from "bun:test";
import type {
  DeckUploadProgress,
  DeckUploadProgressEvent,
  DeckUploadXhr,
  ReportEventSource,
  SessionReportView,
} from "./session-client";
import {
  AccountRegistrationError,
  createConsoleSessionClient,
  DeckUploadError,
} from "./session-client";

const PPTX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const PDF_CONTENT_TYPE = "application/pdf";

const finalizedReport: SessionReportView = {
  reportVersion: 1,
  presentationSessionId: "ps_report",
  ownerAccountId: "account_owner",
  finalizedAtMs: 10_000,
  totalDurationMs: 1_000,
  slideVisits: [
    {
      sequence: 1,
      publicSlideKey: "A",
      occurrenceSequence: 1,
      enteredOffsetMs: 0,
      leftOffsetMs: 300,
      dwellMs: 300,
      revisit: false,
    },
    {
      sequence: 2,
      publicSlideKey: "B",
      occurrenceSequence: 1,
      enteredOffsetMs: 300,
      leftOffsetMs: 600,
      dwellMs: 300,
      revisit: false,
    },
    {
      sequence: 3,
      publicSlideKey: "A",
      occurrenceSequence: 2,
      enteredOffsetMs: 600,
      leftOffsetMs: 1_000,
      dwellMs: 400,
      revisit: true,
    },
  ],
  speech: {
    derivedSummary: "1개 최종 발화에서 2개 단어를 집계했습니다.",
    wordCount: 2,
    speakingDurationMs: 400,
    timingAggregate: { finalCount: 1, measuredFinalCount: 1 },
    coachingAggregate: {
      cueCount: 1,
      latestCurrentWordsPerMinute: 120,
      latestPreviousWordsPerMinute: null,
    },
  },
  preparedEvidence: {
    label: "준비된 근거",
    items: [
      {
        evidenceId: "evidence-1",
        sourceId: "source-1",
        sourceUrl: null,
        provenance: "CURATED_PREAPPROVED",
      },
    ],
  },
};

class FakeReportEventSource extends EventTarget implements ReportEventSource {
  closed = false;
  close(): void {
    this.closed = true;
  }
  emit(type: string, body?: unknown): void {
    const event = new Event(type);
    if (body !== undefined) Object.defineProperty(event, "data", { value: JSON.stringify(body) });
    this.dispatchEvent(event);
  }
}

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

test("signUp sends only username and password in the credentialed request body", async () => {
  const originalFetch = globalThis.fetch;
  const received: Array<{ url: string; init: RequestInit }> = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      received.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ account: { accountId: "account_new" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  });
  try {
    await createConsoleSessionClient("https://private.example.test").signUp(
      "presenter-new",
      "transient-password",
    );
    const call = received[0];
    if (call === undefined) throw new Error("sign-up request was not sent");
    expect(call.url).toBe("https://private.example.test/v1/accounts");
    expect(call.url).not.toContain("presenter-new");
    expect(call.url).not.toContain("transient-password");
    expect(call.init).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
    });
    if (typeof call.init.body !== "string") throw new Error("sign-up body was not JSON");
    const body: unknown = JSON.parse(call.init.body);
    expect(body).toEqual({ username: "presenter-new", password: "transient-password" });
  } finally {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  }
});

test("signUp exposes duplicate usernames as a typed registration failure", async () => {
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () =>
      new Response(JSON.stringify({ error: "USERNAME_TAKEN" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
  });
  try {
    const registration = createConsoleSessionClient("https://private.example.test").signUp(
      "presenter-taken",
      "transient-password",
    );
    await expect(registration).rejects.toBeInstanceOf(AccountRegistrationError);
    await expect(registration).rejects.toMatchObject({ reason: "USERNAME_TAKEN", status: 409 });
  } finally {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  }
});

test("signIn sends only username and password in the credentialed request body", async () => {
  const originalFetch = globalThis.fetch;
  const received: Array<{ url: string; init: RequestInit }> = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      received.push({ url: String(input), init: init ?? {} });
      return new Response(
        JSON.stringify({
          account: { accountId: "account_alpha", actorId: "actor_alpha" },
          expiresAtMs: 10_000,
          csrfToken: "csrf-alpha",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    },
  });
  try {
    await createConsoleSessionClient("https://private.example.test").signIn(
      "presenter-alpha",
      "transient-password",
    );
    const call = received[0];
    if (call === undefined) throw new Error("sign-in request was not sent");
    expect(call.url).toBe("https://private.example.test/v1/account-sessions");
    expect(call.url).not.toContain("presenter-alpha");
    expect(call.url).not.toContain("transient-password");
    expect(call.init).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
    });
    if (typeof call.init.body !== "string") throw new Error("sign-in body was not JSON");
    const body: unknown = JSON.parse(call.init.body);
    expect(body).toEqual({ username: "presenter-alpha", password: "transient-password" });
  } finally {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  }
});

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

test("recommend maps only closed private provenance and drops unsafe external URLs", async () => {
  const originalFetch = globalThis.fetch;
  const providerSnippet = "SEARCH_SNIPPET_SENTINEL";
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () =>
      new Response(
        JSON.stringify({
          outcome: "RECOMMEND",
          recommendation: {
            claim: "Revenue increased.",
            evidenceIds: ["external:safe", "internal:safe"],
            facts: { numbers: [], units: [], dates: [], entities: [] },
          },
          evidence: [
            {
              evidenceId: `external:${"a".repeat(64)}`,
              sourceId: "external-search:duckduckgo-html",
              title: "Origin report title",
              quote: "Origin report body",
              canonicalUrl: "https://origin.example/report",
              sourceDate: "2025-03-04T00:00:00.000Z",
              rights: "UNKNOWN",
              providerSnippet,
            },
            {
              evidenceId: `external:${"b".repeat(64)}`,
              sourceId: "external-search:duckduckgo-html",
              title: "Unsafe origin",
              quote: "Unsafe body",
              canonicalUrl: "http://127.0.0.1/private",
              sourceDate: null,
              rights: "UNKNOWN",
              providerSnippet,
            },
            {
              evidenceId: "internal:object-1:revision-1",
              sourceId: "internal-deck",
              title: "Internal source",
              quote: "Internal body",
              canonicalUrl: null,
              sourceDate: null,
              rights: "APPROVED",
              providerSnippet,
            },
          ],
          completedAtMs: 100,
          latencyMs: 20,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
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
    expect(result.outcome).toBe("RECOMMEND");
    if (result.outcome !== "RECOMMEND") throw new Error("expected recommendation");
    expect(result.evidence).toEqual([
      {
        kind: "EXTERNAL",
        evidenceId: `external:${"a".repeat(64)}`,
        title: "Origin report title",
        sourceUrl: "https://origin.example/report",
        sourceDate: "2025-03-04T00:00:00.000Z",
        rights: "UNKNOWN",
      },
      {
        kind: "INTERNAL",
        evidenceId: "internal:object-1:revision-1",
        title: "Internal source",
        sourceUrl: null,
        sourceDate: null,
        rights: "APPROVED",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(providerSnippet);
    expect(result.evidence).toHaveLength(2);
  } finally {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
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
    presentationSessionEpoch: "pse_3",
    deckVersion: "deck-v1",
    sourceHash: "a".repeat(64),
    privateDeck: { deckId: "private_deck-1" },
    publicDeck: { deckVersion: "deck-v1" },
  });
  const view = await upload;
  expect(view).toEqual({
    presentationSessionId: "ps_deck-upload-1",
    presentationSessionEpoch: "pse_3",
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
  harness.complete(201, {
    presentationSessionId: "ps_pdf-1",
    presentationSessionEpoch: "pse_1",
    deckVersion: "deck_pdf",
  });
  await expect(upload).resolves.toMatchObject({
    presentationSessionId: "ps_pdf-1",
    presentationSessionEpoch: "pse_1",
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
    { presentationSessionId: "ps_1", presentationSessionEpoch: "pse_1", deckVersion: "" },
    { presentationSessionId: "", presentationSessionEpoch: "pse_1", deckVersion: "deck_v1" },
    { deckVersion: "deck_v1" },
    { presentationSessionId: "ps_1", presentationSessionEpoch: "pse_1" },
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

test("uploadDeck maps closed backend rejection codes, including 413", async () => {
  const cases = [
    { status: 400, backendCode: "empty_input", expectedCode: "empty_input" },
    {
      status: 400,
      backendCode: "unsupported_extension",
      expectedCode: "unsupported_extension",
    },
    { status: 400, backendCode: "malformed_input", expectedCode: "malformed_input" },
    { status: 413, backendCode: "input_too_large", expectedCode: "input_too_large" },
    { status: 400, backendCode: "unsafe_filename", expectedCode: "unsafe_filename" },
    { status: 400, backendCode: "size_mismatch", expectedCode: "size_mismatch" },
    { status: 400, backendCode: "not_a_closed_code", expectedCode: "deck_upload_rejected" },
    { status: 400, backendCode: "input_too_large", expectedCode: "deck_upload_rejected" },
  ];
  for (const { status, backendCode, expectedCode } of cases) {
    const harness = createUploadHarness();
    const upload = createConsoleSessionClient("https://private.example.test").uploadDeck(
      "csrf-error",
      deckFile(),
      { transport: harness.transport },
    );
    harness.complete(status, { error: "deck_upload_rejected", code: backendCode });

    const rejection = await rejectionOf(upload);
    expect(rejection).toBeInstanceOf(DeckUploadError);
    expect(rejection).toMatchObject({ code: expectedCode, status });
    expect((rejection as Error).message).toBe(expectedCode);
  }
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
  harness.complete(201, {
    presentationSessionId: "ps_progress-1",
    presentationSessionEpoch: "pse_1",
    deckVersion: "deck_v1",
  });
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

test("session end subscribes first and awaits the exact REPORT_READY event without polling", async () => {
  const originalFetch = globalThis.fetch;
  const source = new FakeReportEventSource();
  const requests: string[] = [];
  let signalEndRequested: () => void = () => {
    throw new Error("end request signal was not installed");
  };
  const endRequested = new Promise<void>((resolve) => {
    signalEndRequested = resolve;
  });
  globalThis.fetch = (async (input, init) => {
    requests.push(`${init?.method ?? "GET"} ${String(input)}`);
    signalEndRequested();
    return new Response(JSON.stringify({ status: "accepted" }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const client = createConsoleSessionClient("https://private.example.test", {
      createReportEventSource(url) {
        requests.push(`SSE ${url}`);
        return source;
      },
    });
    const finalized = client.endPresentationAndAwaitReport?.("csrf-report", "ps_report");
    if (finalized === undefined) throw new Error("report finalization client is missing");
    expect(requests).toEqual([
      "SSE https://private.example.test/v1/playback/controller-events?presentationSessionId=ps_report",
    ]);

    source.emit("open");
    await endRequested;
    source.emit("message", {
      kind: "REPORT_READY",
      presentationSessionId: "ps_report",
      report: finalizedReport,
    });
    source.emit("REPORT_READY", {
      kind: "REPORT_READY",
      presentationSessionId: "ps_other",
      report: finalizedReport,
    });
    source.emit("REPORT_READY", {
      kind: "REPORT_READY",
      presentationSessionId: "ps_report",
      report: { ...finalizedReport, presentationSessionId: "ps_other" },
    });
    source.emit("REPORT_READY", {
      kind: "REPORT_READY",
      presentationSessionId: "ps_report",
      report: {
        ...finalizedReport,
        transcript: "TRANSCRIPT_BODY_SENTINEL",
        silence: "SILENCE_SENTINEL",
        usedEvidence: "사용한 근거",
      },
    });

    const report = await finalized;
    expect(report).toEqual(finalizedReport);
    expect(JSON.stringify(report)).not.toContain("TRANSCRIPT_BODY_SENTINEL");
    expect(JSON.stringify(report)).not.toContain("SILENCE_SENTINEL");
    expect(JSON.stringify(report)).not.toContain("사용한 근거");
    expect(requests).toEqual([
      "SSE https://private.example.test/v1/playback/controller-events?presentationSessionId=ps_report",
      "POST https://private.example.test/v1/presentation-sessions/ps_report/end",
    ]);
    expect(source.closed).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("session end resolves the version-2 report carrying the qa defense section", async () => {
  const originalFetch = globalThis.fetch;
  const source = new FakeReportEventSource();
  let resolveTimeout: (timer: ReturnType<typeof setTimeout>) => void = () => {};
  const timeoutInstalled = new Promise<ReturnType<typeof setTimeout>>((resolve) => {
    resolveTimeout = resolve;
  });
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ status: "accepted" }), {
      status: 202,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  try {
    const client = createConsoleSessionClient("https://private.example.test", {
      createReportEventSource() {
        return source;
      },
    });
    const finalizedPromise = client.endPresentationAndAwaitReport?.("csrf-report", "ps_report");
    if (finalizedPromise === undefined) throw new Error("report finalization client is missing");

    source.emit("open");
    source.emit("REPORT_READY", {
      kind: "REPORT_READY",
      presentationSessionId: "ps_report",
      report: {
        ...finalizedReport,
        reportVersion: 2,
        qaDefense: {
          label: "질의응답",
          exchanges: [
            {
              exchangeId: "qa-1",
              askedAtMs: 5_000,
              question: "올해 매출 목표가 있나요?",
              origin: "TYPED",
              defense: {
                outcome: "ANSWERED",
                answerText: "목표 매출은 100억입니다.",
                citations: [{ kind: "DECK_SLIDE", slideOrdinal: 2 }],
              },
            },
          ],
        },
      },
    });

    // The regression this test names: an unparseable v2 report left this promise pending until
    // the bounded signal, so the presenter saw 리포트를 마무리하지 못했습니다 and stayed on the
    // cockpit. The timer is only a failure backstop; it is cleared when either side settles.
    const bounded = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("v2 REPORT_READY was not accepted")), 2_000);
      resolveTimeout(timer);
    });
    const report = await Promise.race([finalizedPromise, bounded]);
    expect(report).toEqual({
      ...finalizedReport,
      reportVersion: 2,
      qaDefense: {
        status: "READY",
        label: "질의응답",
        exchanges: [
          {
            exchangeId: "qa-1",
            askedAtMs: 5_000,
            question: "올해 매출 목표가 있나요?",
            origin: "TYPED",
            defense: {
              outcome: "ANSWERED",
              answerText: "목표 매출은 100억입니다.",
              citations: [{ kind: "DECK_SLIDE", slideOrdinal: 2 }],
            },
          },
        ],
      },
    });
  } finally {
    const timer = await timeoutInstalled;
    clearTimeout(timer);
    globalThis.fetch = originalFetch;
  }
});

test("reload GET parses finalized reports and exposes owner denial without report data", async () => {
  const originalFetch = globalThis.fetch;
  let owner = true;
  globalThis.fetch = (async () =>
    owner
      ? new Response(
          JSON.stringify({
            report: {
              ...finalizedReport,
              transcript: "TRANSCRIPT_BODY_SENTINEL",
              silence: "SILENCE_SENTINEL",
              usedEvidence: "사용한 근거",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      : new Response(JSON.stringify({ error: "report_forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;
  try {
    const client = createConsoleSessionClient("https://private.example.test");
    const result = await client.readFinalizedReport?.("ps_report");
    expect(result).toEqual({ status: "FINALIZED", report: finalizedReport });
    owner = false;
    await expect(client.readFinalizedReport?.("ps_report")).rejects.toMatchObject({
      status: 403,
      code: "report_forbidden",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uploadReferenceDocuments posts every file as one credentialed multipart request", async () => {
  const originalFetch = globalThis.fetch;
  type CapturedUpload = { url: string; method: string; csrf: string | null; names: string[] };
  const captured: CapturedUpload[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body as FormData;
    captured.push({
      url: String(input),
      method: init?.method ?? "GET",
      csrf: new Headers(init?.headers).get("x-csrf-token"),
      names: body.getAll("files").map((entry) => (entry as File).name),
    });
    return new Response(
      JSON.stringify({
        outcome: "ACCEPTED",
        documents: [
          {
            documentId: "a".repeat(64),
            presentationSessionId: "ps_1",
            filename: "brief.md",
            contentType: "text/markdown",
            byteLength: 12,
            chunkCount: 2,
            status: "INDEXED",
          },
        ],
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  try {
    const { uploadReferenceDocuments } = createConsoleSessionClient("https://private.example.test");
    if (uploadReferenceDocuments === undefined) throw new Error("client lacks reference uploads");
    const outcome = await uploadReferenceDocuments("csrf_1", "ps_1", [
      new File(["hello world!"], "brief.md", { type: "text/markdown" }),
      new File(["second"], "notes.txt", { type: "text/plain" }),
    ]);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("https://private.example.test/v1/reference-documents");
    expect(captured[0]?.method).toBe("POST");
    expect(captured[0]?.csrf).toBe("csrf_1");
    expect(captured[0]?.names).toEqual(["brief.md", "notes.txt"]);
    expect(outcome.outcome).toBe("ACCEPTED");
    expect(outcome.outcome === "ACCEPTED" ? outcome.documents[0]?.filename : null).toBe("brief.md");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uploadReferenceDocuments surfaces a closed rejection reason instead of throwing raw", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ outcome: "REJECTED", reason: "UNSUPPORTED_TYPE" }), {
      status: 415,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  try {
    const { uploadReferenceDocuments } = createConsoleSessionClient("https://private.example.test");
    if (uploadReferenceDocuments === undefined) throw new Error("client lacks reference uploads");
    const outcome = await uploadReferenceDocuments("csrf_1", "ps_1", [
      new File(["x"], "virus.exe", { type: "application/octet-stream" }),
    ]);
    expect(outcome).toEqual({ outcome: "REJECTED", reason: "UNSUPPORTED_TYPE" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
