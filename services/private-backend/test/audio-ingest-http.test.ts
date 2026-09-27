import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AudioCaptureConsent } from "@impromptu/contracts/private";
import { PreparedEvidenceProjectionGateway } from "@impromptu/projection-gateway";
import { createCoachingState, reduceCoachingState } from "@impromptu/state/coaching";
import type { StreamingSttRouterBoundary } from "../src/audio-capture.ts";
import { type AudioIngestServiceOptions, createAudioIngestService } from "../src/audio-ingest.ts";
import { parsePrivateBackendConfig } from "../src/config.ts";
import { createPrivateBackendHandler, type PrivateBackendHandler } from "../src/http.ts";
import type { JsonLogger } from "../src/observability.ts";
import {
  createPreparedEvidenceStore,
  PreparedEvidenceCoordinator,
  snapshotPreparedEvidenceStore,
} from "../src/prepared-evidence.ts";

const origin = "https://console.example.test";

function deferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return {
    promise,
    resolve() {
      resolve?.();
    },
  };
}

class ConsumingRouter implements StreamingSttRouterBoundary {
  readonly frames: number[] = [];
  readonly tenantIds: unknown[] = [];

  async *streamStt(
    chunks: AsyncIterable<{ sequence: number; audio: Uint8Array }>,
    context: unknown,
  ) {
    this.tenantIds.push(
      typeof context === "object" && context !== null && "tenantId" in context
        ? context.tenantId
        : undefined,
    );
    for await (const chunk of chunks) {
      this.frames.push(chunk.sequence);
      yield {
        kind: "transcript" as const,
        event: {
          sessionGeneration: 1,
          sequence: chunk.sequence,
          segmentId: "segment-http",
          kind: "PARTIAL",
          transcript: { text: "브라우저 오디오", language: "ko-KR", durationMs: 100, words: [] },
        },
      };
    }
    yield {
      kind: "complete" as const,
      result: {
        ok: true as const,
        output: { text: "브라우저 오디오", language: "ko-KR", durationMs: 100 },
      },
    };
  }
}

class FinalRecommendationRouter implements StreamingSttRouterBoundary {
  readonly finalGate = deferred();
  readonly duplicateProcessed = deferred();
  readonly lateGate = deferred();
  readonly completed = deferred();

  async *streamStt(chunks: AsyncIterable<{ sequence: number; audio: Uint8Array }>) {
    for await (const _chunk of chunks) break;
    for (let sequence = 0; sequence < 20; sequence += 1) {
      yield {
        kind: "transcript" as const,
        event:
          sequence === 0
            ? {
                sessionGeneration: 7,
                sequence,
                segmentId: "segment-final",
                kind: "PARTIAL" as const,
                transcript: {
                  text: `preview-${sequence}`,
                  language: "ko-KR",
                  durationMs: 100,
                  words: [],
                },
              }
            : {
                sessionGeneration: 7,
                sequence,
                segmentId: "segment-final",
                kind: "REPLACE" as const,
                replacesSequence: sequence - 1,
                transcript: {
                  text: `preview-${sequence}`,
                  language: "ko-KR",
                  durationMs: 100,
                  words: [],
                },
              },
      };
    }
    await this.finalGate.promise;
    yield {
      kind: "transcript" as const,
      event: {
        sessionGeneration: 7,
        sequence: 20,
        segmentId: "segment-final",
        kind: "FINAL" as const,
        finalSegmentId: "final-exactly-once",
        transcript: {
          text: "FINAL_PRIVATE_SENTINEL",
          language: "ko-KR",
          durationMs: 200,
          words: [{ text: "확정", startMs: 0, endMs: 200 }],
        },
      },
    };
    yield {
      kind: "transcript" as const,
      event: {
        sessionGeneration: 7,
        sequence: 21,
        segmentId: "segment-final",
        kind: "FINAL" as const,
        finalSegmentId: "final-exactly-once",
        transcript: {
          text: "FINAL_PRIVATE_SENTINEL",
          language: "ko-KR",
          durationMs: 200,
          words: [{ text: "확정", startMs: 0, endMs: 200 }],
        },
      },
    };
    this.duplicateProcessed.resolve();
    await this.lateGate.promise;
    yield {
      kind: "transcript" as const,
      event: {
        sessionGeneration: 7,
        sequence: 22,
        segmentId: "segment-late",
        kind: "FINAL" as const,
        finalSegmentId: "late-final",
        transcript: {
          text: "LATE_PRIVATE_SENTINEL",
          language: "ko-KR",
          durationMs: 200,
          words: [],
        },
      },
    };
    this.completed.resolve();
    yield {
      kind: "complete" as const,
      result: { ok: false as const, error: { code: "cancelled" } },
    };
  }
}

const TEST_MANIFEST_HASH = createHash("sha256").update("final-forwarding").digest("hex");

function finalEvent(sequence: number, segment: string, text: string) {
  return {
    kind: "transcript" as const,
    event: {
      sessionGeneration: 3,
      sequence,
      segmentId: `segment-${segment}`,
      kind: "FINAL" as const,
      finalSegmentId: `final-${segment}`,
      transcript: { text, language: "ko-KR", durationMs: 120, words: [] },
    },
  };
}

/**
 * Emits one FINAL per segment once the first audio frame arrives so tests can hold the
 * recommendation provider on a deferred promise while watching the SSE event order.
 */
class ConsecutiveFinalRouter implements StreamingSttRouterBoundary {
  readonly sentFinals = deferred();

  constructor(private readonly segments: readonly string[]) {}

  async *streamStt(chunks: AsyncIterable<{ sequence: number; audio: Uint8Array }>) {
    for await (const _chunk of chunks) break;
    for (const [index, segment] of this.segments.entries()) {
      yield finalEvent(index, segment, `FINAL_${segment.toUpperCase()}_SENTINEL`);
    }
    this.sentFinals.resolve();
    yield {
      kind: "complete" as const,
      result: { ok: false as const, error: { code: "cancelled" } },
    };
  }
}

/**
 * Mirrors the whisper.cpp adapter's shape: it emits a PARTIAL when audio arrives, then holds
 * inference silent behind a gate before the FINAL. The gate is the deterministic stand-in for
 * a slow local inference that would otherwise be a wall-clock sleep.
 */
class GatedSilentInferenceRouter implements StreamingSttRouterBoundary {
  readonly inferenceStarted = deferred();
  readonly inferenceGate = deferred();

  async *streamStt(chunks: AsyncIterable<{ sequence: number; audio: Uint8Array }>) {
    for await (const _chunk of chunks) break;
    yield {
      kind: "transcript" as const,
      event: {
        sessionGeneration: 1,
        sequence: 0,
        segmentId: "segment-silent",
        kind: "PARTIAL" as const,
        transcript: { text: "silent-preview", language: "ko-KR", durationMs: 100, words: [] },
      },
    };
    this.inferenceStarted.resolve();
    await this.inferenceGate.promise;
    yield {
      kind: "transcript" as const,
      event: {
        sessionGeneration: 1,
        sequence: 1,
        segmentId: "segment-silent",
        kind: "FINAL" as const,
        finalSegmentId: "final-silent",
        transcript: {
          text: "SILENT_INFERENCE_SENTINEL",
          language: "ko-KR",
          durationMs: 100,
          words: [],
        },
      },
    };
    yield {
      kind: "complete" as const,
      result: {
        ok: true as const,
        output: { text: "SILENT_INFERENCE_SENTINEL", language: "ko-KR", durationMs: 100 },
      },
    };
  }
}

class BlockedRouter implements StreamingSttRouterBoundary {
  readonly gate = deferred();
  readonly completed = deferred();
  invocationCount = 0;

  async *streamStt(chunks: AsyncIterable<{ sequence: number; audio: Uint8Array }>) {
    this.invocationCount += 1;
    await this.gate.promise;
    for await (const _chunk of chunks) {
      // Draining is deliberately gated so buffered-duration behavior is deterministic.
    }
    this.completed.resolve();
    yield {
      kind: "complete" as const,
      result: { ok: true as const, output: { text: "", language: "ko-KR", durationMs: 0 } },
    };
  }
}

type BrowserSession = Readonly<{ accountCookie: string; csrfToken: string }>;

type TestSystem = Readonly<{
  handler: PrivateBackendHandler;
  logEvents: Array<Parameters<JsonLogger["request"]>[0]>;
}>;

function createSystem(
  router: StreamingSttRouterBoundary,
  serviceOptions?: Partial<AudioIngestServiceOptions>,
): TestSystem {
  const logEvents: Array<Parameters<JsonLogger["request"]>[0]> = [];
  const logger: JsonLogger = {
    request(event) {
      logEvents.push(event);
    },
    error() {},
  };
  const audio = createAudioIngestService({
    router,
    contextFor: (identity, signal) => ({ tenantId: identity.accountId, signal }),
    coachingPreviewEnabledFor: () => true,
    createGrantId: () => "capture_http_1",
    ...serviceOptions,
  });
  return {
    handler: createPrivateBackendHandler(parsePrivateBackendConfig({ CONSOLE_ORIGIN: origin }), {
      coordinator: new PreparedEvidenceCoordinator(new PreparedEvidenceProjectionGateway()),
      identityVerifier: {
        async verifyCredentials() {
          return { accountId: "account_http", actorId: "actor_http" };
        },
      },
      audio,
      internalAuthToken: "audio-http-test-token",
      now: () => 1_000,
      logger,
    }),
    logEvents,
  };
}

function createRecommendationSystem(
  router: StreamingSttRouterBoundary,
  recommendations: NonNullable<AudioIngestServiceOptions["recommendations"]>,
): TestSystem {
  const logEvents: Array<Parameters<JsonLogger["request"]>[0]> = [];
  const audio = createAudioIngestService({
    router,
    contextFor: (identity, signal) => ({ tenantId: identity.accountId, signal }),
    coachingPreviewEnabledFor: () => true,
    recommendations,
    createGrantId: () => "capture_http_1",
  });
  return {
    handler: createPrivateBackendHandler(parsePrivateBackendConfig({ CONSOLE_ORIGIN: origin }), {
      coordinator: new PreparedEvidenceCoordinator(new PreparedEvidenceProjectionGateway()),
      identityVerifier: {
        async verifyCredentials() {
          return { accountId: "account_http", actorId: "actor_http" };
        },
      },
      audio,
      internalAuthToken: "audio-http-test-token",
      now: () => 1_000,
      logger: {
        request(event) {
          logEvents.push(event);
        },
        error() {},
      },
    }),
    logEvents,
  };
}

function browserRequest(path: string, session?: BrowserSession, init: RequestInit = {}): Request {
  return new Request(`https://private.example.test${path}`, {
    ...init,
    headers: {
      Origin: origin,
      Referer: `${origin}/present`,
      ...(session === undefined
        ? {}
        : { Cookie: session.accountCookie, "x-csrf-token": session.csrfToken }),
      ...init.headers,
    },
  });
}

async function signIn(handler: PrivateBackendHandler): Promise<BrowserSession> {
  const response = await handler(
    browserRequest("/v1/account-sessions", undefined, {
      method: "POST",
      body: JSON.stringify({ username: "presenter", password: "password" }),
    }),
  );
  const body = (await response.json()) as { csrfToken: string };
  const accountCookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (accountCookie === undefined) throw new Error("account cookie missing from test login");
  return { accountCookie, csrfToken: body.csrfToken };
}

function consent(): AudioCaptureConsent {
  return {
    consentRecordId: "consent_http" as AudioCaptureConsent["consentRecordId"],
    presentationSessionId: "ps_http" as AudioCaptureConsent["presentationSessionId"],
    presentationSessionEpoch: "pse_1" as AudioCaptureConsent["presentationSessionEpoch"],
    actorId: "actor_http" as AudioCaptureConsent["actorId"],
    captureDeviceId: "device_http" as AudioCaptureConsent["captureDeviceId"],
    notice: {
      purpose: "Korean transcription",
      vendors: ["local-whisper"],
      region: "local",
      retention: "memory queue only",
      deletion: "stream close",
    },
    explicitlyAccepted: true,
    acceptedAtMs: 1_000,
  };
}

async function issueGrant(
  handler: PrivateBackendHandler,
  session: BrowserSession,
): Promise<BrowserSession> {
  const response = await handler(
    browserRequest("/v1/audio/grants", session, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mimeType: "audio/webm;codecs=opus", consent: consent() }),
    }),
  );
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({
    mimeType: "audio/webm;codecs=opus",
    expiresAtMs: 61_000,
  });
  const captureCookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  expect(response.headers.get("set-cookie")).toContain(
    "__Host-capture=capture_http_1; Path=/; HttpOnly; Secure; SameSite=Strict",
  );
  if (captureCookie === undefined) throw new Error("capture cookie missing from grant response");
  return { ...session, accountCookie: `${session.accountCookie}; ${captureCookie}` };
}

async function bounded<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), 1_000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readSseEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Record<string, unknown>> {
  // Keep-alive comment frames carry no data line; skip them and keep waiting for the next
  // real event. Every enqueued frame is delivered as its own chunk by the source stream.
  for (;;) {
    const item = await bounded(reader.read(), "timed out waiting for audio SSE event");
    if (item.done) throw new Error("audio SSE ended before the expected event");
    const text = new TextDecoder().decode(item.value);
    const data = text
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length);
    if (data === undefined) continue;
    return JSON.parse(data) as Record<string, unknown>;
  }
}

/**
 * Reads one raw SSE frame, including comment frames that carry no `data:` line. Unlike
 * readSseEvent this never throws on a comment; it fails only if the stream ends first.
 */
async function readRawFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffered = "",
): Promise<string> {
  let pending = buffered;
  for (;;) {
    const boundary = pending.indexOf("\n\n");
    if (boundary !== -1) return pending.slice(0, boundary);
    const item = await bounded(reader.read(), "timed out waiting for an SSE frame");
    if (item.done) throw new Error("audio SSE ended before the expected frame");
    pending += new TextDecoder().decode(item.value);
  }
}

function audioMutation(
  handler: PrivateBackendHandler,
  session: BrowserSession,
  path: string,
  init: RequestInit = {},
) {
  return handler(browserRequest(path, session, { method: "POST", ...init }));
}

function socketRequest(
  baseUrl: string,
  path: string,
  session: BrowserSession | undefined,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Origin: origin,
      Referer: `${origin}/present`,
      ...(session === undefined
        ? {}
        : { Cookie: session.accountCookie, "x-csrf-token": session.csrfToken }),
      ...init.headers,
    },
  });
}

function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const single = response.headers.get("set-cookie");
  return single === null ? [] : [single];
}

async function socketSignIn(baseUrl: string): Promise<BrowserSession> {
  const response = await socketRequest(baseUrl, "/v1/account-sessions", undefined, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "presenter", password: "password" }),
  });
  const body = (await response.json()) as { csrfToken: string };
  const accountCookie = setCookies(response)
    .find((cookie) => cookie.startsWith("__Host-account="))
    ?.split(";", 1)[0];
  if (accountCookie === undefined) throw new Error("account cookie missing from socket login");
  return { accountCookie, csrfToken: body.csrfToken };
}

async function socketIssueGrant(baseUrl: string, session: BrowserSession): Promise<BrowserSession> {
  const response = await socketRequest(baseUrl, "/v1/audio/grants", session, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mimeType: "audio/webm;codecs=opus", consent: consent() }),
  });
  expect(response.status).toBe(201);
  const captureCookie = setCookies(response)
    .find((cookie) => cookie.startsWith("__Host-capture="))
    ?.split(";", 1)[0];
  if (captureCookie === undefined) throw new Error("capture cookie missing from grant response");
  return { ...session, accountCookie: `${session.accountCookie}; ${captureCookie}` };
}

class SocketSseReader {
  readonly #chunks: string[] = [];
  readonly #waiters: Array<() => void> = [];
  #finished = false;
  #failure: Error | undefined;

  constructor(response: Response) {
    const body = response.body;
    if (body === null) throw new Error("audio event stream body missing");
    void this.#pump(body.getReader());
  }

  async #pump(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        this.#chunks.push(decoder.decode(item.value, { stream: true }));
        this.#wake();
      }
    } catch (error) {
      this.#failure = error instanceof Error ? error : new Error(String(error));
    }
    this.#finished = true;
    this.#wake();
  }

  #wake(): void {
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  frames(): string[] {
    return this.#chunks
      .join("")
      .split("\n\n")
      .filter((frame) => frame.length > 0);
  }

  nextFrame(): Promise<void> {
    if (this.#finished) return Promise.reject(this.#failure ?? new Error("audio SSE stream ended"));
    return new Promise<void>((resolve, reject) => {
      this.#waiters.push(() => {
        if (this.#finished) reject(this.#failure ?? new Error("audio SSE stream ended"));
        else resolve();
      });
    });
  }
}

/**
 * Waits until the stream has carried at least `count` frames matching `predicate`. A dead
 * socket settles the pending wake-up by rejection instead of a timeout, so the assertion
 * fails the moment the connection severs rather than after a fixed wait.
 */
async function awaitFrames(
  reader: SocketSseReader,
  count: number,
  predicate: (frame: string) => boolean,
  message: string,
): Promise<void> {
  const deadline = deferred();
  const guard = setTimeout(() => deadline.resolve(), 15_000);
  try {
    while (reader.frames().filter(predicate).length < count) {
      await Promise.race([
        reader.nextFrame(),
        deadline.promise.then(() => {
          throw new Error(message);
        }),
      ]);
    }
  } finally {
    clearTimeout(guard);
  }
}

describe("private audio ingest HTTP transport", () => {
  test("grant, pre-subscribed SSE, start, frames, and stop carry browser audio to the router", async () => {
    const router = new ConsumingRouter();
    const { handler, logEvents } = createSystem(router);
    const account = await signIn(handler);
    const session = await issueGrant(handler, account);

    const eventsResponse = await handler(browserRequest("/v1/audio/events", session));
    expect(eventsResponse.status).toBe(200);
    expect(eventsResponse.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const reader = eventsResponse.body?.getReader();
    if (reader === undefined) throw new Error("audio event stream body missing");
    expect(await readSseEvent(reader)).toEqual({ kind: "READY" });

    expect((await audioMutation(handler, session, "/v1/audio/stream/start")).status).toBe(202);
    const frame = await audioMutation(handler, session, "/v1/audio/frames", {
      headers: {
        "content-type": "application/octet-stream",
        "x-audio-sequence": "0",
        "x-audio-duration-ms": "100",
      },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(frame.status).toBe(202);
    expect(await frame.json()).toEqual({ status: "accepted" });
    expect(await readSseEvent(reader)).toEqual({
      kind: "TRANSCRIPT",
      event: {
        sessionGeneration: 1,
        sequence: 0,
        segmentId: "segment-http",
        kind: "PARTIAL",
        transcript: { text: "브라우저 오디오", language: "ko-KR", durationMs: 100, words: [] },
      },
    });

    expect((await audioMutation(handler, session, "/v1/audio/stream/stop")).status).toBe(202);
    expect(await readSseEvent(reader)).toEqual({ kind: "TERMINAL", outcome: "COMPLETED" });
    expect(router.frames).toEqual([0]);
    expect(router.tenantIds).toEqual(["account_http"]);
    expect(
      logEvents.filter((event) => event.path === "/v1/audio/frames" && event.status === 202),
    ).toHaveLength(1);
  });

  test("rejects sequence gaps, the buffered-duration overflow, and late frames after revoke", async () => {
    const router = new BlockedRouter();
    const { handler } = createSystem(router);
    const account = await signIn(handler);
    const session = await issueGrant(handler, account);
    const eventsResponse = await handler(browserRequest("/v1/audio/events", session));
    const reader = eventsResponse.body?.getReader();
    if (reader === undefined) throw new Error("audio event stream body missing");
    expect(await readSseEvent(reader)).toEqual({ kind: "READY" });
    expect((await audioMutation(handler, session, "/v1/audio/stream/start")).status).toBe(202);

    const sendFrame = (sequence: number, durationMs: number) =>
      audioMutation(handler, session, "/v1/audio/frames", {
        headers: {
          "content-type": "application/octet-stream",
          "x-audio-sequence": String(sequence),
          "x-audio-duration-ms": String(durationMs),
        },
        body: new Uint8Array([sequence + 1]),
      });

    const gap = await sendFrame(1, 1);
    expect(gap.status).toBe(409);
    expect(await gap.json()).toEqual({ error: "INVALID_SEQUENCE" });
    expect((await sendFrame(0, 30_000)).status).toBe(202);
    const overflow = await sendFrame(1, 1);
    expect(overflow.status).toBe(409);
    expect(await overflow.json()).toEqual({ error: "BUFFER_LIMIT_EXCEEDED" });

    const revoke = await handler(browserRequest("/v1/audio/grant", session, { method: "DELETE" }));
    expect(revoke.status).toBe(200);
    expect(revoke.headers.get("set-cookie")).toContain("__Host-capture=;");
    expect(await readSseEvent(reader)).toEqual({ kind: "TERMINAL", outcome: "GRANT_REVOKED" });
    const late = await sendFrame(1, 1);
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ error: "GRANT_REVOKED" });
    expect(router.invocationCount).toBe(1);
    router.gate.resolve();
    await bounded(router.completed.promise, "timed out waiting for revoked router cleanup");
  });

  test("connects one text-layer PDF session from PARTIAL through FINAL, coaching, recommendation, and report aggregate", async () => {
    const fixtureBytes = readFileSync("tests/fixtures/format-neutral-decks/korean-text-layer.pdf");
    expect(fixtureBytes.subarray(0, 5).toString()).toBe("%PDF-");
    const fixtureManifestHash = createHash("sha256").update(fixtureBytes).digest("hex");
    const router = new FinalRecommendationRouter();
    const store = createPreparedEvidenceStore();
    const projectionCalls: string[] = [];
    const coordinator = new PreparedEvidenceCoordinator(
      {
        bindDisplay() {
          projectionCalls.push("bindDisplay");
          return { outcome: "REJECTED" as const, reason: "unused" };
        },
        projectPlayback() {
          projectionCalls.push("projectPlayback");
          return false;
        },
        recordPlaybackApplied() {
          projectionCalls.push("recordPlaybackApplied");
          return false;
        },
        issueDisplayInvitation() {
          projectionCalls.push("issueDisplayInvitation");
          return { outcome: "REJECTED" as const, reason: "unused" };
        },
        readDisplayInvitation() {
          projectionCalls.push("readDisplayInvitation");
          return { outcome: "REJECTED" as const, reason: "unused" };
        },
      },
      store,
    );
    const recommendationInputs: unknown[] = [];
    const finalAggregates: unknown[] = [];
    let coachingState = reduceCoachingState(createCoachingState(), {
      kind: "OPT_IN",
      enabled: true,
    }).state;
    const persistedSnapshots: string[] = [];
    const logEvents: Array<Parameters<JsonLogger["request"]>[0]> = [];
    const audio = createAudioIngestService({
      router,
      contextFor: (identity, signal) => ({ tenantId: identity.accountId, signal }),
      coachingPreviewEnabledFor: () => true,
      onFinal(identity, event) {
        finalAggregates.push({
          presentationSessionId: identity.presentationSessionId,
          finalSegmentId: event.finalSegmentId,
          wordCount: event.transcript.words.length,
        });
        coachingState = reduceCoachingState(coachingState, {
          sessionGeneration: event.sessionGeneration,
          sequence: event.sequence,
          segmentId: event.segmentId,
          kind: "FINAL",
          finalSegmentId: event.finalSegmentId,
          finalizedAtSessionMs: event.transcript.durationMs,
          words: event.transcript.words.map((word) => ({
            text: word.text,
            startSessionMs: word.startMs,
            endSessionMs: word.endMs,
          })),
        }).state;
      },
      recommendations: {
        resolveContext(identity) {
          expect(identity.presentationSessionId).toBe("ps_http");
          return { deckVersion: "deck_current", manifestHash: fixtureManifestHash };
        },
        async recommend(_accountSessionId, input) {
          recommendationInputs.push(structuredClone(input));
          return {
            outcome: "ABSTAIN",
            reason: "INSUFFICIENT_EVIDENCE",
            completedAtMs: 1_001,
            latencyMs: 1,
          };
        },
      },
      createGrantId: () => "capture_http_1",
    });
    const handler = createPrivateBackendHandler(
      parsePrivateBackendConfig({ CONSOLE_ORIGIN: origin }),
      {
        coordinator,
        identityVerifier: {
          async verifyCredentials() {
            return { accountId: "account_http", actorId: "actor_http" };
          },
        },
        audio,
        internalAuthToken: "stage-service-credential",
        now: () => 1_000,
        persist: async () => {
          persistedSnapshots.push(JSON.stringify(snapshotPreparedEvidenceStore(store)));
        },
        logger: {
          request(event) {
            logEvents.push(event);
          },
          error() {},
        },
      },
    );

    const stageCredential = await handler(
      new Request("https://private.example.test/v1/audio/events", {
        headers: { authorization: "Bearer stage-service-credential" },
      }),
    );
    expect(stageCredential.status).toBe(401);

    const account = await signIn(handler);
    const persistCountAfterLogin = persistedSnapshots.length;
    const snapshotBefore = JSON.stringify(snapshotPreparedEvidenceStore(store));
    const session = await issueGrant(handler, account);
    const eventsResponse = await handler(browserRequest("/v1/audio/events", session));
    const reader = eventsResponse.body?.getReader();
    if (reader === undefined) throw new Error("audio event stream body missing");
    expect(await readSseEvent(reader)).toEqual({ kind: "READY" });
    expect((await audioMutation(handler, session, "/v1/audio/stream/start")).status).toBe(202);
    expect(
      (
        await audioMutation(handler, session, "/v1/audio/frames", {
          headers: {
            "content-type": "application/octet-stream",
            "x-audio-sequence": "0",
            "x-audio-duration-ms": "100",
          },
          body: new Uint8Array([1]),
        })
      ).status,
    ).toBe(202);

    for (let index = 0; index < 20; index += 1) {
      expect(await readSseEvent(reader)).toMatchObject({ kind: "TRANSCRIPT" });
    }
    expect(recommendationInputs).toHaveLength(0);

    router.finalGate.resolve();
    expect(await readSseEvent(reader)).toMatchObject({
      kind: "TRANSCRIPT",
      event: { kind: "FINAL", finalSegmentId: "final-exactly-once" },
    });
    expect(await readSseEvent(reader)).toEqual({
      kind: "RECOMMENDATION",
      presentationSessionId: "ps_http",
      sessionGeneration: 7,
      finalSegmentId: "final-exactly-once",
      recommendation: {
        outcome: "ABSTAIN",
        reason: "INSUFFICIENT_EVIDENCE",
        completedAtMs: 1_001,
        latencyMs: 1,
      },
    });
    expect(recommendationInputs).toEqual([
      {
        query: "FINAL_PRIVATE_SENTINEL",
        deckVersion: "deck_current",
        manifestHash: fixtureManifestHash,
        maxResults: 3,
      },
    ]);
    expect(finalAggregates).toEqual([
      {
        presentationSessionId: "ps_http",
        finalSegmentId: "final-exactly-once",
        wordCount: 1,
      },
    ]);
    expect(coachingState).toMatchObject({
      optedIn: true,
      cueCount: 1,
      measurement: { outcome: "MEASUREMENT_UNAVAILABLE" },
    });

    await bounded(router.duplicateProcessed.promise, "duplicate FINAL was not processed");
    expect(recommendationInputs).toHaveLength(1);
    const revoke = await handler(browserRequest("/v1/audio/grant", session, { method: "DELETE" }));
    expect(revoke.status).toBe(200);
    expect(await readSseEvent(reader)).toEqual({ kind: "TERMINAL", outcome: "GRANT_REVOKED" });
    router.lateGate.resolve();
    await bounded(router.completed.promise, "late FINAL was not processed");
    expect(recommendationInputs).toHaveLength(1);

    expect(projectionCalls).toEqual([]);
    expect(JSON.stringify(snapshotPreparedEvidenceStore(store))).toBe(snapshotBefore);
    expect(persistedSnapshots).toHaveLength(persistCountAfterLogin);
    expect(JSON.stringify(logEvents)).not.toContain("FINAL_PRIVATE_SENTINEL");
    expect(JSON.stringify(snapshotPreparedEvidenceStore(store))).not.toContain(
      "FINAL_PRIVATE_SENTINEL",
    );
    expect(JSON.stringify(persistedSnapshots)).not.toContain("FINAL_PRIVATE_SENTINEL");
  });

  test("forwards a consecutive FINAL transcript while a recommendation is still pending", async () => {
    const router = new ConsecutiveFinalRouter(["a", "b"]);
    const recommendationGate = deferred();
    const recommendationCalls: string[] = [];
    const { handler } = createRecommendationSystem(router, {
      resolveContext: () => ({
        deckVersion: "deck_head_of_line",
        manifestHash: TEST_MANIFEST_HASH,
      }),
      async recommend(_accountSessionId, input) {
        recommendationCalls.push((input as { query: string }).query);
        await recommendationGate.promise;
        return {
          outcome: "ABSTAIN" as const,
          reason: "INSUFFICIENT_EVIDENCE" as const,
          completedAtMs: 1_001,
          latencyMs: 1,
        };
      },
    });
    const account = await signIn(handler);
    const session = await issueGrant(handler, account);
    const eventsResponse = await handler(browserRequest("/v1/audio/events", session));
    const reader = eventsResponse.body?.getReader();
    if (reader === undefined) throw new Error("audio event stream body missing");
    expect(await readSseEvent(reader)).toEqual({ kind: "READY" });
    expect((await audioMutation(handler, session, "/v1/audio/stream/start")).status).toBe(202);
    expect(
      (
        await audioMutation(handler, session, "/v1/audio/frames", {
          headers: {
            "content-type": "application/octet-stream",
            "x-audio-sequence": "0",
            "x-audio-duration-ms": "100",
          },
          body: new Uint8Array([1]),
        })
      ).status,
    ).toBe(202);

    await bounded(router.sentFinals.promise, "router did not emit both FINAL events");
    // Both transcripts must reach SSE before the held recommendation resolves; awaiting the
    // first recommendation inside transcript forwarding is the head-of-line block under test.
    expect(await readSseEvent(reader)).toMatchObject({
      kind: "TRANSCRIPT",
      event: { kind: "FINAL", finalSegmentId: "final-a" },
    });
    expect(await readSseEvent(reader)).toMatchObject({
      kind: "TRANSCRIPT",
      event: { kind: "FINAL", finalSegmentId: "final-b" },
    });
    expect(recommendationCalls).toEqual(["FINAL_A_SENTINEL"]);
    recommendationGate.resolve();
    expect(await readSseEvent(reader)).toMatchObject({
      kind: "RECOMMENDATION",
      finalSegmentId: "final-a",
      recommendation: { outcome: "ABSTAIN", reason: "INSUFFICIENT_EVIDENCE" },
    });
    expect(await readSseEvent(reader)).toMatchObject({
      kind: "RECOMMENDATION",
      finalSegmentId: "final-b",
      recommendation: { outcome: "ABSTAIN" },
    });
    expect(await readSseEvent(reader)).toEqual({ kind: "TERMINAL", outcome: "STREAM_CANCELLED" });
    expect(recommendationCalls).toEqual(["FINAL_A_SENTINEL", "FINAL_B_SENTINEL"]);
  });

  test("bounds the recommendation lane and reports provider failure as a typed abstention", async () => {
    const router = new ConsecutiveFinalRouter(["a", "b", "c", "d", "e"]);
    const recommendationGate = deferred();
    const recommendationCalls: string[] = [];
    const { handler } = createRecommendationSystem(router, {
      resolveContext: () => ({
        deckVersion: "deck_head_of_line",
        manifestHash: TEST_MANIFEST_HASH,
      }),
      async recommend(_accountSessionId, input) {
        const query = (input as { query: string }).query;
        recommendationCalls.push(query);
        await recommendationGate.promise;
        if (query === "FINAL_C_SENTINEL") throw new Error("provider exploded");
        return {
          outcome: "ABSTAIN" as const,
          reason: "INSUFFICIENT_EVIDENCE" as const,
          completedAtMs: 1_001,
          latencyMs: 1,
        };
      },
    });
    const account = await signIn(handler);
    const session = await issueGrant(handler, account);
    const eventsResponse = await handler(browserRequest("/v1/audio/events", session));
    const reader = eventsResponse.body?.getReader();
    if (reader === undefined) throw new Error("audio event stream body missing");
    expect(await readSseEvent(reader)).toEqual({ kind: "READY" });
    expect((await audioMutation(handler, session, "/v1/audio/stream/start")).status).toBe(202);
    expect(
      (
        await audioMutation(handler, session, "/v1/audio/frames", {
          headers: {
            "content-type": "application/octet-stream",
            "x-audio-sequence": "0",
            "x-audio-duration-ms": "100",
          },
          body: new Uint8Array([1]),
        })
      ).status,
    ).toBe(202);

    for (const segment of ["a", "b", "c", "d", "e"]) {
      expect(await readSseEvent(reader)).toMatchObject({
        kind: "TRANSCRIPT",
        event: { kind: "FINAL", finalSegmentId: `final-${segment}` },
      });
    }
    // The lane holds four dispatches; the fifth FINAL earns a typed abstention immediately
    // instead of queueing without bound.
    expect(await readSseEvent(reader)).toMatchObject({
      kind: "RECOMMENDATION",
      finalSegmentId: "final-e",
      recommendation: { outcome: "ABSTAIN", reason: "BUDGET_EXCEEDED" },
    });
    recommendationGate.resolve();
    const outcomes: Record<string, unknown>[] = [];
    for (let index = 0; index < 4; index += 1) {
      outcomes.push(await readSseEvent(reader));
    }
    expect(outcomes.map((outcome) => outcome.finalSegmentId)).toEqual([
      "final-a",
      "final-b",
      "final-c",
      "final-d",
    ]);
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({
        kind: "RECOMMENDATION",
        recommendation: { outcome: "ABSTAIN" },
      });
    }
    // The provider rejection on the third FINAL degrades to a typed outcome; the stream and
    // the remaining queued recommendations continue in order.
    expect(outcomes[2]).toMatchObject({
      recommendation: { outcome: "ABSTAIN", reason: "MODEL_FAILURE" },
    });
    expect(await readSseEvent(reader)).toEqual({ kind: "TERMINAL", outcome: "STREAM_CANCELLED" });
    expect(recommendationCalls).toEqual([
      "FINAL_A_SENTINEL",
      "FINAL_B_SENTINEL",
      "FINAL_C_SENTINEL",
      "FINAL_D_SENTINEL",
    ]);
  });

  test("revoking the grant cancels queued and running recommendations without leaking results", async () => {
    const router = new ConsecutiveFinalRouter(["first", "second"]);
    const recommendationGate = deferred();
    const runningSettled = deferred();
    const recommendationCalls: string[] = [];
    const { handler } = createRecommendationSystem(router, {
      resolveContext: () => ({
        deckVersion: "deck_head_of_line",
        manifestHash: TEST_MANIFEST_HASH,
      }),
      async recommend(_accountSessionId, input) {
        recommendationCalls.push((input as { query: string }).query);
        await recommendationGate.promise;
        runningSettled.resolve();
        return {
          outcome: "ABSTAIN" as const,
          reason: "INSUFFICIENT_EVIDENCE" as const,
          completedAtMs: 1_001,
          latencyMs: 1,
        };
      },
    });
    const account = await signIn(handler);
    const session = await issueGrant(handler, account);
    const eventsResponse = await handler(browserRequest("/v1/audio/events", session));
    const reader = eventsResponse.body?.getReader();
    if (reader === undefined) throw new Error("audio event stream body missing");
    expect(await readSseEvent(reader)).toEqual({ kind: "READY" });
    expect((await audioMutation(handler, session, "/v1/audio/stream/start")).status).toBe(202);
    expect(
      (
        await audioMutation(handler, session, "/v1/audio/frames", {
          headers: {
            "content-type": "application/octet-stream",
            "x-audio-sequence": "0",
            "x-audio-duration-ms": "100",
          },
          body: new Uint8Array([1]),
        })
      ).status,
    ).toBe(202);

    for (const segment of ["first", "second"]) {
      expect(await readSseEvent(reader)).toMatchObject({
        kind: "TRANSCRIPT",
        event: { kind: "FINAL", finalSegmentId: `final-${segment}` },
      });
    }
    // First recommendation is running on the held provider, second is queued on the lane.
    const revoke = await handler(browserRequest("/v1/audio/grant", session, { method: "DELETE" }));
    expect(revoke.status).toBe(200);
    expect(await readSseEvent(reader)).toEqual({ kind: "TERMINAL", outcome: "GRANT_REVOKED" });
    recommendationGate.resolve();
    await bounded(runningSettled.promise, "running recommendation did not settle");
    // The cancelled queued job never reaches the provider, and the running job's late outcome
    // is discarded: no RECOMMENDATION event may arrive after the terminal.
    expect(recommendationCalls).toEqual(["FINAL_FIRST_SENTINEL"]);
    const tail = await bounded(reader.read(), "event stream did not close after revocation");
    expect(tail.done).toBe(true);
  });

  test("requires the account actor and exact mutation CSRF before issuing a capture grant", async () => {
    const { handler } = createSystem(new ConsumingRouter());
    const account = await signIn(handler);
    const forgedConsent = { ...consent(), actorId: "actor_forged" };
    const forged = await handler(
      browserRequest("/v1/audio/grants", account, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mimeType: "audio/webm;codecs=opus", consent: forgedConsent }),
      }),
    );
    expect(forged.status).toBe(403);
    expect(await forged.json()).toEqual({ error: "ACTOR_MISMATCH" });

    const withoutCsrf = await handler(
      browserRequest("/v1/audio/grants", undefined, {
        method: "POST",
        headers: { Cookie: account.accountCookie, "content-type": "application/json" },
        body: JSON.stringify({ mimeType: "audio/webm;codecs=opus", consent: consent() }),
      }),
    );
    expect(withoutCsrf.status).toBe(403);
  });

  test("emits keep-alive comment frames while inference holds the transcript stream silent", async () => {
    // The whisper.cpp adapter emits nothing while a segment infers; without periodic writes the
    // SSE body goes silent for seconds at a time (live-baseline F3). The stream contract must
    // include keep-alive comments so intermediaries and the HTTP server never see an idle body.
    const router = new GatedSilentInferenceRouter();
    const { handler } = createSystem(router, { eventStreamHeartbeatIntervalMs: 150 });
    const account = await signIn(handler);
    const session = await issueGrant(handler, account);
    const eventsResponse = await handler(browserRequest("/v1/audio/events", session));
    const reader = eventsResponse.body?.getReader();
    if (reader === undefined) throw new Error("audio event stream body missing");
    expect(await readSseEvent(reader)).toEqual({ kind: "READY" });
    expect((await audioMutation(handler, session, "/v1/audio/stream/start")).status).toBe(202);
    expect(
      (
        await audioMutation(handler, session, "/v1/audio/frames", {
          headers: {
            "content-type": "application/octet-stream",
            "x-audio-sequence": "0",
            "x-audio-duration-ms": "100",
          },
          body: new Uint8Array([1]),
        })
      ).status,
    ).toBe(202);

    await bounded(router.inferenceStarted.promise, "inference never consumed the audio frame");
    // The PARTIAL transcript may already sit ahead of the first heartbeat; keep reading raw
    // frames until a comment frame proves the stream writes while inference holds it silent.
    const keepAliveDeadline = deferred();
    const keepAliveGuard = setTimeout(() => keepAliveDeadline.resolve(), 1_000);
    let keepAlive = "";
    try {
      while (!keepAlive.startsWith(":")) {
        keepAlive = await Promise.race([
          readRawFrame(reader),
          keepAliveDeadline.promise.then(() => {
            throw new Error("no keep-alive frame during inference");
          }),
        ]);
      }
    } finally {
      clearTimeout(keepAliveGuard);
    }

    router.inferenceGate.resolve();
    expect(await readSseEvent(reader)).toMatchObject({
      kind: "TRANSCRIPT",
      event: { kind: "FINAL", finalSegmentId: "final-silent" },
    });
    expect(await readSseEvent(reader)).toEqual({ kind: "TERMINAL", outcome: "COMPLETED" });
  });

  test("keeps the SSE socket connected across an inference longer than the server idle timeout", async () => {
    // F3 regression at the real socket layer: Bun.serve closes responses whose body writes go
    // idle past idleTimeout, checked on a ~4s sweep (default 10s -> kill 8-12s after the last
    // write; production captures pause that long inside whisper inference). Serving with
    // idleTimeout:5 reproduces the kill deterministically, while 200ms heartbeats keep the
    // body active across the whole sweep window so the stream still reaches TERMINAL.
    const router = new GatedSilentInferenceRouter();
    const { handler } = createSystem(router, { eventStreamHeartbeatIntervalMs: 200 });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 5, fetch: handler });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    try {
      const account = await socketSignIn(baseUrl);
      const session = await socketIssueGrant(baseUrl, account);
      const eventsResponse = await socketRequest(baseUrl, "/v1/audio/events", session);
      expect(eventsResponse.status).toBe(200);
      const events = new SocketSseReader(eventsResponse);

      const start = await socketRequest(baseUrl, "/v1/audio/stream/start", session, {
        method: "POST",
      });
      expect(start.status).toBe(202);
      const frame = await socketRequest(baseUrl, "/v1/audio/frames", session, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-audio-sequence": "0",
          "x-audio-duration-ms": "100",
        },
        body: new Uint8Array([1]),
      });
      expect(frame.status).toBe(202);

      // Hold inference silent until the stream has carried ~9s of heartbeat frames: longer
      // than the worst-case idleTimeout:5 kill (one or two 4s sweeps after the last write).
      // Reaching the count proves the connection survived; a dead socket rejects instead.
      await awaitFrames(
        events,
        45,
        (frame) => frame.startsWith(":"),
        "audio SSE produced too few keep-alive frames before the deadline",
      );

      router.inferenceGate.resolve();
      await awaitFrames(
        events,
        1,
        (frame) => frame.includes('"finalSegmentId":"final-silent"'),
        "audio SSE never delivered the FINAL transcript after inference",
      );
      await awaitFrames(
        events,
        1,
        (frame) => frame.includes('"kind":"TERMINAL"'),
        "audio SSE never delivered the TERMINAL event",
      );
      const terminal = events
        .frames()
        .map((frame) => {
          const data = frame
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice("data: ".length);
          return data === undefined
            ? undefined
            : (JSON.parse(data) as { kind?: string; outcome?: string });
        })
        .find((event) => event?.kind === "TERMINAL");
      expect(terminal).toMatchObject({ kind: "TERMINAL", outcome: "COMPLETED" });
    } finally {
      server.stop(true);
    }
  }, 20_000);
});
