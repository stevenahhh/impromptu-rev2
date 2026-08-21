import { describe, expect, test } from "bun:test";
import { z } from "zod";
import * as productionApi from "../src/index.ts";
import {
  createTrustedModelContext,
  isTrustedModelContext,
  MODEL_CAPABILITIES,
  modelFailureSchema,
  modelResultSchema,
  modelSuccessSchema,
  sttTranscriptSchema,
} from "../src/index.ts";
import { createScriptedSttAdapter, createScriptedUnaryAdapter } from "../src/testing.ts";

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

  test("brands only complete, strict contexts with a real AbortSignal", () => {
    const context = createTrustedModelContext(trustedContextInput);

    expect(isTrustedModelContext(context)).toBe(true);
    expect(isTrustedModelContext({ ...trustedContextInput })).toBe(false);
    expect(Object.isFrozen(context)).toBe(true);
    expect(() => createTrustedModelContext({ ...trustedContextInput, unexpected: true })).toThrow();
    expect(() =>
      createTrustedModelContext({
        ...trustedContextInput,
        signal: { aborted: false } as AbortSignal,
      }),
    ).toThrow();
  });

  test("rejects unknown properties recursively in router-owned results", () => {
    const resultSchema = modelResultSchema(z.object({ answer: z.string() }).strict());

    expect(() =>
      resultSchema.parse({
        ok: true,
        output: { answer: "ok" },
        metadata: { ...metadata, unexpected: true },
      }),
    ).toThrow();
    expect(() =>
      resultSchema.parse({
        ok: false,
        error: {
          code: "provider_error",
          message: "failed",
          retryable: true,
          unexpected: true,
        },
        metadata,
      }),
    ).toThrow();
    expect(() =>
      resultSchema.parse({
        ok: true,
        output: { answer: "ok" },
        metadata,
        unexpected: true,
      }),
    ).toThrow();
  });
});

describe("deterministic fake adapters", () => {
  test("keeps test-only factories out of the production API", () => {
    expect("createScriptedUnaryAdapter" in productionApi).toBe(false);
    expect("createScriptedSttAdapter" in productionApi).toBe(false);
  });

  test("returns a scripted unary output without provider dependencies", async () => {
    const adapter = createScriptedUnaryAdapter({
      descriptor: {
        adapterId: "fake-llm",
        capability: "llm",
        provider: "fake",
        model: "fixed-output",
        modelVersion: "1",
        estimatedCostUnits: 1,
      },
      inputSchema: z.object({ prompt: z.string() }),
      outputSchema: z.object({ answer: z.string() }),
      steps: [{ kind: "output", output: { answer: "REPEATABLE" } }],
    });
    const context = createTrustedModelContext(trustedContextInput);

    await expect(
      adapter.invoke({ prompt: "repeatable" }, { trustedContext: context, signal: context.signal }),
    ).resolves.toEqual({ answer: "REPEATABLE" });
    expect(adapter.invocationCount).toBe(1);
  });

  test("clones and freezes outputs so caller mutation cannot alter later calls", async () => {
    const scripted = { nested: { values: ["stable"] } };
    const adapter = createScriptedUnaryAdapter({
      descriptor: {
        adapterId: "fake-clone",
        capability: "llm",
        provider: "fake",
        model: "fixed-output",
        modelVersion: "1",
        estimatedCostUnits: 1,
      },
      inputSchema: z.object({}).strict(),
      outputSchema: z
        .object({ nested: z.object({ values: z.array(z.string()) }).strict() })
        .strict(),
      steps: [{ kind: "output", output: scripted }],
    });
    const context = createTrustedModelContext(trustedContextInput);
    const invocation = { trustedContext: context, signal: context.signal };

    const first = await adapter.invoke({}, invocation);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.nested)).toBe(true);
    expect(() => first.nested.values.push("mutated")).toThrow();
    expect(await adapter.invoke({}, invocation)).toEqual({ nested: { values: ["stable"] } });
  });

  test("replays scripted unary and streaming STT results in order", async () => {
    const transcript = { text: "안녕하세요", language: "ko", durationMs: 420 };
    const adapter = createScriptedSttAdapter({
      transcript,
      events: [
        {
          kind: "PARTIAL",
          sessionGeneration: 1,
          sequence: 0,
          segmentId: "segment-1",
          transcript: { ...transcript, text: "안녕", words: [] },
        },
        {
          kind: "FINAL",
          sessionGeneration: 1,
          sequence: 1,
          segmentId: "segment-1",
          finalSegmentId: "final-segment-1",
          transcript: { ...transcript, words: [] },
        },
      ],
    });
    const context = createTrustedModelContext(trustedContextInput);
    const invocation = { trustedContext: context, signal: context.signal };

    await expect(
      adapter.invoke(
        {
          audio: new Uint8Array([1, 2]),
          encoding: "audio/webm;codecs=opus",
          sampleRateHz: 16_000,
        },
        invocation,
      ),
    ).resolves.toEqual(transcript);

    const events = [];
    for await (const event of adapter.transcribe(emptyAudio(), invocation)) {
      events.push(event);
    }
    expect(events).toEqual([
      {
        kind: "PARTIAL",
        sessionGeneration: 1,
        sequence: 0,
        segmentId: "segment-1",
        transcript: { ...transcript, text: "안녕", words: [] },
      },
      {
        kind: "FINAL",
        sessionGeneration: 1,
        sequence: 1,
        segmentId: "segment-1",
        finalSegmentId: "final-segment-1",
        transcript: { ...transcript, words: [] },
      },
    ]);
    expect(sttTranscriptSchema.parse(transcript)).toEqual(transcript);
  });
});

async function* emptyAudio(): AsyncIterable<never> {}
