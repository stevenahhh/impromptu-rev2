import { describe, expect, test } from "bun:test";
import type { AudioCaptureConsent } from "@impromptu/contracts/private";
import { PreparedEvidenceProjectionGateway } from "@impromptu/projection-gateway";
import type { StreamingSttRouterBoundary } from "../src/audio-capture.ts";
import { createAudioIngestService } from "../src/audio-ingest.ts";
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

function createSystem(router: StreamingSttRouterBoundary): TestSystem {
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
  const item = await bounded(reader.read(), "timed out waiting for audio SSE event");
  if (item.done) throw new Error("audio SSE ended before the expected event");
  const text = new TextDecoder().decode(item.value);
  const data = text
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  if (data === undefined) throw new Error(`audio SSE data missing: ${text}`);
  return JSON.parse(data) as Record<string, unknown>;
}

function audioMutation(
  handler: PrivateBackendHandler,
  session: BrowserSession,
  path: string,
  init: RequestInit = {},
) {
  return handler(browserRequest(path, session, { method: "POST", ...init }));
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

  test("invokes recommendations once on FINAL and keeps the result private and ephemeral", async () => {
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
      },
      store,
    );
    const recommendationInputs: unknown[] = [];
    const persistedSnapshots: string[] = [];
    const logEvents: Array<Parameters<JsonLogger["request"]>[0]> = [];
    const audio = createAudioIngestService({
      router,
      contextFor: (identity, signal) => ({ tenantId: identity.accountId, signal }),
      coachingPreviewEnabledFor: () => true,
      recommendations: {
        resolveContext(identity) {
          expect(identity.presentationSessionId).toBe("ps_http");
          return { deckVersion: "deck_current", manifestHash: "a".repeat(64) };
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
        manifestHash: "a".repeat(64),
        maxResults: 3,
      },
    ]);

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
});
