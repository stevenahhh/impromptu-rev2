import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SAMPLE_RATE_HZ = 16_000;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_MS = (SAMPLE_RATE_HZ * BYTES_PER_SAMPLE) / 1_000;
const PARTIAL_CADENCE_MS = 3_000;
const MAX_WEBM_HEADER_BYTES = 65_536;
const OPUS_CODEC_ID = Buffer.from("A_OPUS", "ascii");
const SEGMENT_DURATION_MS = 15_000;
const SEGMENT_BYTES = SEGMENT_DURATION_MS * BYTES_PER_MS;
const PARTIAL_BYTES = PARTIAL_CADENCE_MS * BYTES_PER_MS;

export async function* transcribe(chunks, { configuration, signal }) {
  const settings = parseConfiguration(configuration);
  const events = new AsyncEventQueue();
  const pipeline = decodeAndTranscribe(chunks, settings, events, signal)
    .then(() => events.end())
    .catch((error) => events.fail(error));

  try {
    for await (const event of events) yield event;
    await pipeline;
  } finally {
    events.end();
  }
}

async function decodeAndTranscribe(chunks, settings, events, signal) {
  throwIfAborted(signal);
  const ffmpeg = spawn(
    settings.ffmpegPath,
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "webm",
      "-codec:a",
      "libopus",
      "-i",
      "pipe:0",
      "-ac",
      "1",
      "-ar",
      String(SAMPLE_RATE_HZ),
      "-f",
      "s16le",
      "pipe:1",
    ],
    { shell: false, stdio: ["pipe", "pipe", "pipe"] },
  );
  const stopFfmpeg = () => ffmpeg.kill();
  signal?.addEventListener("abort", stopFfmpeg, { once: true });
  const ffmpegExit = processExit(ffmpeg);
  const stderr = collectBytes(ffmpeg.stderr);
  const input = pumpChunks(chunks, ffmpeg.stdin, signal);
  void input.catch(() => undefined);

  let buffered = Buffer.alloc(0);
  let segmentIndex = 0;
  let sequence = 0;
  let lastPartialSequence;
  let partialInference;

  const emitPartial = async (pcm) => {
    const transcript = await infer(pcm, settings, signal);
    const eventSequence = sequence;
    sequence += 1;
    const segmentId = `whisper-segment-${segmentIndex}`;
    events.push(
      lastPartialSequence === undefined
        ? {
            kind: "PARTIAL",
            sessionGeneration: settings.sessionGeneration,
            sequence: eventSequence,
            segmentId,
            transcript,
          }
        : {
            kind: "REPLACE",
            sessionGeneration: settings.sessionGeneration,
            sequence: eventSequence,
            segmentId,
            replacesSequence: lastPartialSequence,
            transcript,
          },
    );
    lastPartialSequence = eventSequence;
  };

  const emitFinal = async (pcm) => {
    if (partialInference !== undefined) await partialInference;
    partialInference = undefined;
    const transcript = await infer(pcm, settings, signal);
    const segmentId = `whisper-segment-${segmentIndex}`;
    events.push({
      kind: "FINAL",
      sessionGeneration: settings.sessionGeneration,
      sequence,
      segmentId,
      finalSegmentId: `whisper-final-${settings.sessionGeneration}-${segmentIndex}`,
      transcript,
    });
    sequence += 1;
    segmentIndex += 1;
    lastPartialSequence = undefined;
  };

  try {
    for await (const decoded of ffmpeg.stdout) {
      throwIfAborted(signal);
      buffered = Buffer.concat([buffered, decoded]);
      while (buffered.length >= SEGMENT_BYTES) {
        const segment = buffered.subarray(0, SEGMENT_BYTES);
        buffered = buffered.subarray(SEGMENT_BYTES);
        if (partialInference === undefined) {
          partialInference = emitPartial(segment.subarray(0, PARTIAL_BYTES));
        }
        await emitFinal(segment);
      }
      const reachedCadence =
        buffered.length >= PARTIAL_BYTES * (lastPartialSequence === undefined ? 1 : 2);
      if (reachedCadence && partialInference === undefined) {
        partialInference = emitPartial(Buffer.from(buffered)).finally(() => {
          partialInference = undefined;
        });
      }
    }
    await input;
    const exit = await ffmpegExit;
    const diagnostic = (await stderr).toString("utf8").trim();
    if (exit !== 0) throw new Error(`ffmpeg decode failed${diagnostic ? `: ${diagnostic}` : ""}`);
    if (buffered.length === 0) throw new Error("ffmpeg decoded no audio");
    if (partialInference === undefined && lastPartialSequence === undefined) {
      partialInference = emitPartial(Buffer.from(buffered));
    }
    await emitFinal(buffered);
  } finally {
    signal?.removeEventListener("abort", stopFfmpeg);
    if (ffmpeg.exitCode === null) ffmpeg.kill();
  }
}

async function infer(pcm, settings, signal) {
  throwIfAborted(signal);
  const directory = await mkdtemp(join(tmpdir(), "impromptu-whisper-"));
  const wavPath = join(directory, "audio.wav");
  const outputBase = join(directory, "transcript");
  try {
    await writeFile(wavPath, wav(pcm));
    const child = spawn(
      settings.whisperBinaryPath,
      ["-m", settings.modelPath, "-f", wavPath, "-l", "ko", "-ojf", "-of", outputBase, "-np"],
      { shell: false, stdio: ["ignore", "ignore", "pipe"] },
    );
    const stopChild = () => child.kill();
    signal?.addEventListener("abort", stopChild, { once: true });
    const childExit = processExit(child);
    const stderr = collectBytes(child.stderr);
    try {
      const exit = await childExit;
      const diagnostic = (await stderr).toString("utf8").trim();
      if (exit !== 0) {
        throw new Error(`whisper.cpp inference failed${diagnostic ? `: ${diagnostic}` : ""}`);
      }
    } finally {
      signal?.removeEventListener("abort", stopChild);
    }
    const output = JSON.parse(await readFile(`${outputBase}.json`, "utf8"));
    return parseTranscript(output, Math.floor(pcm.length / BYTES_PER_MS));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function parseTranscript(output, durationMs) {
  if (!isRecord(output) || !isRecord(output.result) || !Array.isArray(output.transcription)) {
    throw new Error("whisper.cpp returned invalid JSON");
  }
  const language = output.result.language;
  if (typeof language !== "string" || language.length < 2) {
    throw new Error("whisper.cpp omitted transcript language");
  }
  const textParts = [];
  const words = [];
  for (const segment of output.transcription) {
    if (!isRecord(segment) || typeof segment.text !== "string") {
      throw new Error("whisper.cpp returned an invalid segment");
    }
    textParts.push(segment.text);
    if (!Array.isArray(segment.tokens)) continue;
    for (const token of segment.tokens) appendToken(words, token, durationMs);
  }
  return {
    text: textParts.join("").trim(),
    language,
    durationMs,
    words,
  };
}

function appendToken(words, token, durationMs) {
  if (!isRecord(token) || typeof token.text !== "string" || !isRecord(token.offsets)) return;
  if (token.text.startsWith("[_")) return;
  const rawStart = token.offsets.from;
  const rawEnd = token.offsets.to;
  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) return;
  const text = token.text.trim();
  if (text.length === 0) return;
  const previous = words.at(-1);
  const startMs = Math.max(previous?.endMs ?? 0, Math.min(durationMs, Math.round(rawStart)));
  const endMs = Math.max(startMs, Math.min(durationMs, Math.round(rawEnd)));
  if (previous !== undefined && !/^\s/u.test(token.text)) {
    previous.text += text;
    previous.endMs = Math.max(previous.endMs, endMs);
    return;
  }
  words.push({ text, startMs, endMs });
}

function parseConfiguration(value) {
  if (!isRecord(value)) throw new Error("whisper.cpp configuration is required");
  for (const name of ["ffmpegPath", "whisperBinaryPath", "modelPath"]) {
    if (typeof value[name] !== "string" || !value[name].startsWith("/")) {
      throw new Error(`${name} must be an absolute path`);
    }
  }
  const sessionGeneration = Number(value.sessionGeneration ?? "1");
  if (!Number.isSafeInteger(sessionGeneration) || sessionGeneration <= 0) {
    throw new Error("sessionGeneration must be a positive safe integer");
  }
  return {
    ffmpegPath: value.ffmpegPath,
    whisperBinaryPath: value.whisperBinaryPath,
    modelPath: value.modelPath,
    sessionGeneration,
  };
}

function wav(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE_HZ, 24);
  header.writeUInt32LE(SAMPLE_RATE_HZ * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function pumpChunks(chunks, stdin, signal) {
  let header = Buffer.alloc(0);
  let opusValidated = false;
  try {
    for await (const chunk of chunks) {
      throwIfAborted(signal);
      if (!isRecord(chunk) || !(chunk.audio instanceof Uint8Array)) {
        throw new Error("invalid WebM/Opus chunk");
      }
      let output = chunk.audio;
      if (!opusValidated) {
        header = Buffer.concat([header, chunk.audio]);
        opusValidated = header.includes(OPUS_CODEC_ID);
        if (!opusValidated) {
          if (header.length >= MAX_WEBM_HEADER_BYTES) throw new Error("audio codec must be Opus");
          continue;
        }
        output = header;
        header = Buffer.alloc(0);
      }
      if (!stdin.write(output)) await new Promise((resolve) => stdin.once("drain", resolve));
    }
    if (!opusValidated) throw new Error("audio codec must be Opus");
    stdin.end();
  } catch (error) {
    stdin.destroy();
    throw error;
  }
}

function processExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

async function collectBytes(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error("STT cancelled");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class AsyncEventQueue {
  #values = [];
  #waiters = [];
  #ended = false;
  #error;

  [Symbol.asyncIterator]() {
    return { next: () => this.#next() };
  }

  push(value) {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#values.push(value);
    else waiter.resolve({ done: false, value });
  }

  end() {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  fail(error) {
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  async #next() {
    const value = this.#values.shift();
    if (value !== undefined) return { done: false, value };
    if (this.#error !== undefined) throw this.#error;
    if (this.#ended) return { done: true, value: undefined };
    return await new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }
}
