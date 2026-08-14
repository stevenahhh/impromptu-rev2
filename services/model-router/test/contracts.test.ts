import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  createTrustedModelContext,
  DeterministicFakeSttAdapter,
  DeterministicFakeUnaryAdapter,
  isTrustedModelContext,
  MODEL_CAPABILITIES,
  modelFailureSchema,
  modelResultSchema,
  modelSuccessSchema,
  sttTranscriptSchema,
} from "../src/index.ts";

const trustedContextInput = {
  tenantId: "tenant-1",
  principalId: "user-1",
  requestId: "request-1",
  traceId: "trace-1",
  policyVersion: "policy-2026-08",
  deadlineAtMs: 2_000,
  signal: new AbortController().signal,
};

const metadata = {
  capability: "llm" as const,
  adapterId: "fake-llm",
  provider: "fake",
  model: "fixed-output",
  modelVersion: "1",
  policyVersion: "policy-2026-08",
  requestId: "request-1",
  traceId: "trace-1",
  startedAtMs: 1_000,
  completedAtMs: 1_025,
  latencyMs: 25,
  cacheStatus: "bypass" as const,
};

describe("model-router contracts", () => {
  test("defines the complete server capability registry vocabulary", () => {
    expect(MODEL_CAPABILITIES).toEqual([
      "stt",
      "ocr",
      "vlm",
      "embedding",
      "rerank",
      "llm",
      "verifier",
      "dlp-pii",
      "coaching",
      "report-summary",
    ]);
  });

  test("validates successful and failed terminal results", () => {
    const resultSchema = modelResultSchema(z.object({ answer: z.string() }));

    expect(
      resultSchema.parse({
        ok: true,
        output: { answer: "deterministic" },
        metadata,
      }),
    ).toEqual({ ok: true, output: { answer: "deterministic" }, metadata });

    expect(
      resultSchema.parse({
        ok: false,
        error: {
          code: "deadline_exceeded",
          message: "The model deadline elapsed",
          retryable: true,
        },
        metadata,
      }).ok,
    ).toBe(false);

    expect(() =>
      modelSuccessSchema(z.string()).parse({
        ok: true,
        output: "bad timing",
        metadata: { ...metadata, latencyMs: 24 },
      }),
    ).toThrow();
    expect(() =>
      modelFailureSchema.parse({
        ok: false,
        error: { code: "unknown", message: "untyped", retryable: false },
        metadata,
      }),
    ).toThrow();
  });

  test("brands only contexts created at the trusted server boundary", () => {
    const context = createTrustedModelContext(trustedContextInput);

    expect(isTrustedModelContext(context)).toBe(true);
    expect(isTrustedModelContext({ ...trustedContextInput })).toBe(false);
    expect(Object.isFrozen(context)).toBe(true);
  });
});

describe("deterministic fake adapters", () => {
  test("returns a scripted unary output without provider dependencies", async () => {
    const adapter = new DeterministicFakeUnaryAdapter({
      descriptor: {
        adapterId: "fake-llm",
        capability: "llm",
        provider: "fake",
        model: "fixed-output",
        modelVersion: "1",
      },
      inputSchema: z.object({ prompt: z.string() }),
      outputSchema: z.object({ answer: z.string() }),
      respond: ({ prompt }) => ({ answer: prompt.toUpperCase() }),
    });
    const context = createTrustedModelContext(trustedContextInput);

    await expect(
      adapter.invoke({ prompt: "repeatable" }, { trustedContext: context, signal: context.signal }),
    ).resolves.toEqual({ answer: "REPEATABLE" });
    expect(adapter.invocationCount).toBe(1);
  });

  test("replays scripted unary and streaming STT results in order", async () => {
    const transcript = { text: "안녕하세요", language: "ko", durationMs: 420 };
    const adapter = new DeterministicFakeSttAdapter({
      transcript,
      events: [
        { kind: "partial", sequence: 0, transcript: { ...transcript, text: "안녕" } },
        { kind: "final", sequence: 1, transcript },
      ],
    });
    const context = createTrustedModelContext(trustedContextInput);
    const invocation = { trustedContext: context, signal: context.signal };

    await expect(
      adapter.invoke(
        { audio: new Uint8Array([1, 2]), encoding: "pcm-s16le", sampleRateHz: 16_000 },
        invocation,
      ),
    ).resolves.toEqual(transcript);

    const events = [];
    for await (const event of adapter.transcribe(emptyAudio(), invocation)) {
      events.push(event);
    }
    expect(events).toEqual([
      { kind: "partial", sequence: 0, transcript: { ...transcript, text: "안녕" } },
      { kind: "final", sequence: 1, transcript },
    ]);
    expect(sttTranscriptSchema.parse(transcript)).toEqual(transcript);
  });
});

async function* emptyAudio(): AsyncIterable<never> {}
