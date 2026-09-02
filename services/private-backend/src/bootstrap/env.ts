import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

export function required(name: string): string {
  const value = Bun.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

export type WhisperCppPaths = {
  readonly ffmpegPath: string;
  readonly whisperBinaryPath: string;
  readonly modelPath: string;
};

export function optionalWhisperCppPaths(): WhisperCppPaths | null {
  const ffmpegPath = Bun.env.FFMPEG_BINARY_PATH;
  const whisperBinaryPath = Bun.env.WHISPER_CPP_BINARY_PATH;
  const modelPath = Bun.env.WHISPER_CPP_MODEL_PATH;
  if (
    ffmpegPath === undefined ||
    ffmpegPath.length === 0 ||
    whisperBinaryPath === undefined ||
    whisperBinaryPath.length === 0 ||
    modelPath === undefined ||
    modelPath.length === 0
  ) {
    return null;
  }
  return { ffmpegPath, whisperBinaryPath, modelPath };
}

export function existingAbsoluteDirectory(path: string, name: string): string {
  if (!isAbsolute(path)) {
    throw new Error(`${name} must be an existing absolute directory: ${path}`);
  }
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch {
    throw new Error(`${name} must be an existing absolute directory: ${path}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`${name} must be an existing absolute directory: ${path}`);
  }
  return path;
}

export function renderDeadlineMs(value: string | undefined): number {
  // The deadline covers rasterizing every page AND the structural ingest after it. A scanned
  // deck carries no text layer, so each page goes through CPU-bound local OCR: a twenty-page
  // scan that ingests in about eleven seconds on an idle host ran past sixty on a busy one and
  // the upload came back deck_upload_rejected. Sized for the slowest input the product accepts;
  // DECK_RENDER_DEADLINE_MS still tightens it wherever a deployment wants a shorter ceiling.
  if (value === undefined) return 240_000;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("DECK_RENDER_DEADLINE_MS must be a positive integer of milliseconds");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("DECK_RENDER_DEADLINE_MS must be a positive integer of milliseconds");
  }
  return parsed;
}

export function positiveNumber(name: string, defaultValue: number): number {
  const value = Bun.env[name];
  if (value === undefined) return defaultValue;
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error(`${name} must be a positive finite number`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return parsed;
}

export function credentialFreeHttpsBaseUrl(name: string): URL {
  const url = new URL(required(name));
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`${name} must be a credential-free HTTPS URL without query or fragment`);
  }
  return url;
}

export function apiPrefix(url: URL): string {
  return url.pathname.replace(/\/$/, "") || "/";
}
