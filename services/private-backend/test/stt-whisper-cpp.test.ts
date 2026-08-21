import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AdapterIsolate,
  createTrustedModelContext,
  type ModelInvocationContext,
} from "@impromptu/model-router";
import {
  createWhisperCppRegistration,
  verifyWhisperCppInstallation,
  WHISPER_CPP_ADAPTER_ID,
  WHISPER_CPP_COMMIT,
  WHISPER_CPP_MODEL_BYTES,
  WHISPER_CPP_MODEL_SHA256,
  WHISPER_CPP_TAG,
  WhisperCppAdapterIsolate,
} from "../src/model-adapters/stt-whisper-cpp.ts";

const executableHeader = "#!/usr/bin/env node\n";

test("pins the local adapter descriptor and fails closed on a non-pinned model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "impromptu-stt-pin-"));
  const binary = join(directory, "binary");
  const model = join(directory, "ggml-small-q5_1.bin");
  try {
    await Promise.all([
      writeExecutable(binary, "process.exit(0);\n"),
      writeFile(model, new Uint8Array([1, 2, 3])),
    ]);
    const registration = createWhisperCppRegistration({
      ffmpegPath: binary,
      whisperBinaryPath: binary,
      modelPath: model,
    });

    expect(registration.descriptor).toMatchObject({
      adapterId: WHISPER_CPP_ADAPTER_ID,
      modelVersion: `${WHISPER_CPP_TAG}:${WHISPER_CPP_COMMIT}`,
      estimatedCostUnits: 0,
    });
    expect(WHISPER_CPP_MODEL_BYTES).toBe(190_085_487);
    expect(WHISPER_CPP_MODEL_SHA256).toBe(
      "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
    );
    await expect(
      verifyWhisperCppInstallation({
        ffmpegPath: binary,
        whisperBinaryPath: binary,
        modelPath: model,
      }),
    ).rejects.toThrow("must be exactly");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("trusted local isolate emits a PARTIAL before one FINAL with monotonic word timestamps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "impromptu-stt-stream-"));
  const ffmpeg = join(directory, "ffmpeg");
  const whisper = join(directory, "whisper-cli");
  const model = join(directory, "ggml-small-q5_1.bin");
  try {
    await Promise.all([
      writeExecutable(
        ffmpeg,
        `process.stdin.resume();
process.stdin.on("end", () => process.stdout.write(Buffer.alloc(128000)));
`,
      ),
      writeExecutable(
        whisper,
        `const fs = require("node:fs");
const outputIndex = process.argv.indexOf("-of");
const output = process.argv[outputIndex + 1];
fs.writeFileSync(output + ".json", JSON.stringify({
  result: { language: "ko" },
  transcription: [{
    text: " 발표 지원 서비스입니다",
    tokens: [
      { text: " 발표", offsets: { from: 100, to: 700 } },
      { text: " 지원", offsets: { from: 800, to: 1400 } },
      { text: " 서비스", offsets: { from: 1500, to: 2300 } },
      { text: "입니다", offsets: { from: 2300, to: 2900 } }
    ]
  }]
}));
`,
      ),
      writeFile(model, new Uint8Array([0])),
    ]);
    const registration = createWhisperCppRegistration({
      ffmpegPath: ffmpeg,
      whisperBinaryPath: whisper,
      modelPath: model,
    });
    let fallbackUsed = false;
    const fallback: AdapterIsolate = {
      async invoke() {
        fallbackUsed = true;
        throw new Error("unexpected fallback");
      },
      streamStt() {
        fallbackUsed = true;
        throw new Error("unexpected fallback");
      },
    };
    const isolate = new WhisperCppAdapterIsolate(fallback);
    const cancellation = new AbortController();
    const trustedContext = createTrustedModelContext({
      tenantId: "tenant-1",
      principalId: "principal-1",
      requestId: "request-1",
      traceId: "trace-1",
      policyVersion: "model-policy-v1",
      deadlineAtMs: Date.now() + 30_000,
      signal: cancellation.signal,
    });
    const context: ModelInvocationContext = {
      trustedContext,
      signal: cancellation.signal,
    };
    async function* chunks() {
      yield { sequence: 0, audio: new TextEncoder().encode("webm-header-A_OPUS-audio") };
    }

    const events = [];
    for await (const event of isolate.streamStt(registration.module, chunks(), context)) {
      events.push(event);
    }

    expect(fallbackUsed).toBe(false);
    expect(events.map((event) => event.kind)).toEqual(["PARTIAL", "FINAL"]);
    expect(events.filter((event) => event.kind === "FINAL")).toHaveLength(1);
    const final = events.at(-1);
    expect(final?.kind).toBe("FINAL");
    if (final?.kind === "FINAL") {
      expect(final.transcript.text).toContain("발표 지원 서비스입니다");
      expect(final.transcript.words).toEqual([
        { text: "발표", startMs: 100, endMs: 700 },
        { text: "지원", startMs: 800, endMs: 1400 },
        { text: "서비스입니다", startMs: 1500, endMs: 2900 },
      ]);
      expect(
        final.transcript.words.every(
          (word, index, words) =>
            word.endMs <= final.transcript.durationMs &&
            (index === 0 || word.startMs >= (words[index - 1]?.endMs ?? 0)),
        ),
      ).toBe(true);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, `${executableHeader}${body}`);
  await chmod(path, 0o755);
}
