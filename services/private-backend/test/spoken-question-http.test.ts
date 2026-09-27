import { describe, expect, test } from "bun:test";
import {
  MAX_QUESTION_CLIP_BYTES,
  type SpokenQuestionTranscriptionOutcome,
} from "@impromptu/contracts/private";
import type { ServerModelRouter } from "@impromptu/model-router";
import { type PrivateBackendConfig, parsePrivateBackendConfig } from "../src/config.ts";
import type { AuthedRouteContext } from "../src/http/route-context.ts";
import {
  QUESTION_CLIP_TRANSCRIPTION_PATHNAME,
  spokenQuestionRoutes,
} from "../src/http/routes/spoken-question.ts";
import { createSpokenQuestionStt } from "../src/qa/spoken-question-stt.ts";

/**
 * Direct invocation of the exported route function with injected fakes, mirroring
 * qa-http.test.ts: the caller-visible HTTP semantics are asserted at this boundary while the
 * account-session cookie + CSRF enforcement stays owned by handler.ts's shared pipeline.
 */

const config: PrivateBackendConfig = parsePrivateBackendConfig({
  CONSOLE_ORIGIN: "https://console.example.test",
});
const origin = new Headers();

function request(init: {
  readonly body?: Uint8Array<ArrayBuffer> | undefined;
  readonly contentType?: string;
  readonly durationMs?: number;
}): Request {
  const headers = new Headers();
  if (init.contentType !== undefined) headers.set("content-type", init.contentType);
  if (init.durationMs !== undefined) headers.set("x-audio-duration-ms", String(init.durationMs));
  return new Request(`https://backend.example.test${QUESTION_CLIP_TRANSCRIPTION_PATHNAME}`, {
    method: "POST",
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}

function context(request_: Request): AuthedRouteContext {
  return {
    request: request_,
    url: new URL(request_.url),
    origin,
    config,
    dependencies: {} as AuthedRouteContext["dependencies"],
    accountSessionId: "account_session_1",
    accountId: "account_owner1" as unknown as AuthedRouteContext["accountId"],
    actorId: "actor_presenter" as unknown as AuthedRouteContext["actorId"],
    sessionExpiresAtMs: Number.MAX_SAFE_INTEGER,
  };
}

function webmClip(bytes: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

async function expectRejection(response: Response | null, reason: string): Promise<void> {
  const status = response?.status;
  const body = await response?.json();
  expect(status).toBe(200);
  expect(body).toEqual({ outcome: "REJECTED", reason });
}

describe("spoken question clip transcription route", () => {
  test("passes a bounded clip through and answers with the typed TRANSCRIBED outcome", async () => {
    let received: Uint8Array | undefined;
    const response = await spokenQuestionRoutes(
      context(
        request({
          body: webmClip(1024),
          contentType: "audio/webm;codecs=opus",
          durationMs: 4_000,
        }),
      ),
      {
        async transcribe(_identity, audio) {
          received = audio;
          return {
            outcome: "TRANSCRIBED",
            text: "청중 질문입니다.",
            language: "ko",
            durationMs: 4000,
          };
        },
      } satisfies NonNullable<Parameters<typeof spokenQuestionRoutes>[1]>,
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      outcome: "TRANSCRIBED",
      text: "청중 질문입니다.",
      language: "ko",
      durationMs: 4000,
    });
    expect(received?.length).toBe(1024);
  });

  test("refuses oversized clips as TOO_LARGE without touching STT", async () => {
    let called = false;
    const response = await spokenQuestionRoutes(
      // One byte past the contract bound; also past the frame-reader bound.
      context(
        request({
          body: webmClip(MAX_QUESTION_CLIP_BYTES + 1),
          contentType: "audio/webm;codecs=opus",
          durationMs: 1_000,
        }),
      ),
      {
        async transcribe() {
          called = true;
          return { outcome: "REJECTED", reason: "EMPTY_AUDIO" };
        },
      },
    );
    expect(called).toBe(false);
    await expectRejection(response, "TOO_LARGE");
  });

  test("refuses an unprovable or excessive duration declaration as TOO_LONG", async () => {
    let called = false;
    const over = await spokenQuestionRoutes(
      context(
        request({ body: webmClip(16), contentType: "audio/webm;codecs=opus", durationMs: 121_000 }),
      ),
      {
        async transcribe() {
          called = true;
          return { outcome: "REJECTED", reason: "EMPTY_AUDIO" };
        },
      },
    );
    const missing = await spokenQuestionRoutes(
      context(request({ body: webmClip(16), contentType: "audio/webm;codecs=opus" })),
      {
        async transcribe() {
          called = true;
          return { outcome: "REJECTED", reason: "EMPTY_AUDIO" };
        },
      },
    );
    expect(called).toBe(false);
    await expectRejection(over, "TOO_LONG");
    await expectRejection(missing, "TOO_LONG");
  });

  test("a non-WebM upload is UNSUPPORTED_CODEC and an empty one is EMPTY_AUDIO", async () => {
    let called = false;
    const wrongType = await spokenQuestionRoutes(
      context(request({ body: webmClip(16), contentType: "text/plain", durationMs: 1000 })),
      {
        async transcribe() {
          called = true;
          return { outcome: "REJECTED", reason: "EMPTY_AUDIO" };
        },
      },
    );
    const empty = await spokenQuestionRoutes(
      context(request({ contentType: "audio/webm;codecs=opus", durationMs: 1000 })),
      {
        async transcribe() {
          called = true;
          return { outcome: "REJECTED", reason: "EMPTY_AUDIO" };
        },
      },
    );
    expect(called).toBe(false);
    await expectRejection(wrongType, "UNSUPPORTED_CODEC");
    await expectRejection(empty, "EMPTY_AUDIO");
  });

  test("without local STT the route answers a typed STT_UNAVAILABLE, never a dead end", async () => {
    const response = await spokenQuestionRoutes(
      context(
        request({ body: webmClip(16), contentType: "audio/webm;codecs=opus", durationMs: 1000 }),
      ),
      undefined,
    );
    await expectRejection(response, "STT_UNAVAILABLE");
  });
});

describe("spoken question STT service", () => {
  function clipIdentity() {
    return { tenantId: "account_owner1", principalId: "actor_presenter" };
  }

  function routerOf(items: Iterable<unknown> | AsyncIterable<unknown>): ServerModelRouter {
    return Object.freeze({
      streamStt: async function* () {
        for await (const item of items) yield item;
      },
    }) as unknown as ServerModelRouter;
  }

  function finalEvent(text: string, sequence: number, durationMs: number) {
    return {
      kind: "transcript",
      event: {
        kind: "FINAL",
        sessionGeneration: 1,
        sequence,
        segmentId: `seg-${sequence}`,
        finalSegmentId: `final-${sequence}`,
        transcript: { text, language: "ko", durationMs, words: [] },
      },
    };
  }

  test("concatenates FINAL transcripts into one question text", async () => {
    const stt = createSpokenQuestionStt({
      router: routerOf([
        finalEvent("안녕하세요. ", 0, 2000),
        finalEvent("매출 질문입니다.", 1, 1800),
      ]),
    });
    const outcome = await stt(clipIdentity(), webmClip(64));
    expect(outcome).toEqual({
      outcome: "TRANSCRIBED",
      text: "안녕하세요. 매출 질문입니다.",
      language: "ko",
      durationMs: 3800,
    });
  });

  test("maps model-router failures to honest uppercase rejections", async () => {
    const failing = (): AsyncIterable<unknown> =>
      (async function* () {
        yield {
          kind: "complete",
          result: {
            ok: false,
            error: { code: "unsupported_capability", message: "none", retryable: false },
          },
        };
      })();
    const providerFailed = (): AsyncIterable<unknown> =>
      (async function* () {
        yield {
          kind: "complete",
          result: {
            ok: false,
            error: { code: "provider_error", message: "boom", retryable: true },
          },
        };
      })();
    expect(
      await createSpokenQuestionStt({
        router: routerOf(failing()),
      })(clipIdentity(), webmClip(64)),
    ).toEqual({ outcome: "REJECTED", reason: "STT_UNAVAILABLE" });
    expect(
      await createSpokenQuestionStt({
        router: routerOf(providerFailed()),
      })(clipIdentity(), webmClip(64)),
    ).toEqual({ outcome: "REJECTED", reason: "TRANSCRIPTION_FAILED" });
  });

  test("mints the deadline per call — a clip long after construction still transcribes", async () => {
    // Regression: the deadline used to be minted once at factory scope, so every clip submitted
    // more than a minute after boot carried an expired deadline. The fake router reproduces the
    // real CancellationScope check (now >= deadlineAtMs -> deadline_exceeded).
    const realNow = Date.now;
    let fakeNow = 1_000_000;
    Date.now = () => fakeNow;
    try {
      const router = {
        streamStt: async function* (
          _chunks: AsyncIterable<unknown>,
          context: { readonly deadlineAtMs: number },
        ) {
          if (Date.now() >= context.deadlineAtMs) {
            yield {
              kind: "complete",
              result: {
                ok: false,
                error: { code: "deadline_exceeded", message: "expired", retryable: true },
              },
            };
            return;
          }
          yield finalEvent("늦은 질문입니다.", 0, 1000);
        },
      } as unknown as ServerModelRouter;
      const stt = createSpokenQuestionStt({ router });
      fakeNow += 120_000;
      const first = await stt(clipIdentity(), webmClip(64));
      fakeNow += 120_000;
      const second = await stt(clipIdentity(), webmClip(64));
      expect(first.outcome).toBe("TRANSCRIBED");
      expect(second).toEqual({
        outcome: "TRANSCRIBED",
        text: "늦은 질문입니다.",
        language: "ko",
        durationMs: 1000,
      });
    } finally {
      Date.now = realNow;
    }
  });

  test("silence is never fabricated into text — it stays EMPTY_AUDIO", async () => {
    const stt = createSpokenQuestionStt({
      router: routerOf([finalEvent("", 0, 900)]),
    });
    const outcome: SpokenQuestionTranscriptionOutcome = await stt(clipIdentity(), webmClip(64));
    expect(outcome).toEqual({ outcome: "REJECTED", reason: "EMPTY_AUDIO" });
  });
});
