import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type AdapterIsolate,
  type IsolatedAdapterModule,
  type IsolatedStreamingSttAdapterRegistration,
  type ModelInvocationContext,
  type ModelRoutingRegistry,
  type SttAudioChunk,
  type SttStreamEvent,
  sttAudioChunkSchema,
  sttStreamEventSchema,
} from "@impromptu/model-router";

export const WHISPER_CPP_TAG = "b4938";
export const WHISPER_CPP_COMMIT = "371b5a7561823ab2bb32142d2751e35e7534727b";
export const WHISPER_CPP_MODEL_NAME = "ggml-small-q5_1.bin";
export const WHISPER_CPP_MODEL_BYTES = 190_085_487;
export const WHISPER_CPP_MODEL_SHA256 =
  "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb";
export const WHISPER_CPP_ADAPTER_ID = "local-whisper-cpp-ko";
export const WHISPER_CPP_AUDIO_MIME_TYPE = "audio/webm;codecs=opus";

const adapterModulePath = fileURLToPath(new URL("./stt-whisper-cpp.mjs", import.meta.url));
const adapterExportName = "transcribe";

export interface WhisperCppPaths {
  readonly ffmpegPath: string;
  readonly whisperBinaryPath: string;
  readonly modelPath: string;
}

export async function verifyWhisperCppInstallation(paths: WhisperCppPaths): Promise<
  Readonly<{
    binaryPath: string;
    binarySha256: string;
    modelPath: string;
    modelBytes: number;
    modelSha256: string;
  }>
> {
  assertAbsolutePaths(paths);
  await Promise.all([
    access(paths.ffmpegPath, constants.X_OK),
    access(paths.whisperBinaryPath, constants.X_OK),
    access(paths.modelPath, constants.R_OK),
  ]);
  const model = await stat(paths.modelPath);
  if (!model.isFile() || model.size !== WHISPER_CPP_MODEL_BYTES) {
    throw new Error(`${WHISPER_CPP_MODEL_NAME} must be exactly ${WHISPER_CPP_MODEL_BYTES} bytes`);
  }
  const [binarySha256, modelSha256] = await Promise.all([
    sha256(paths.whisperBinaryPath),
    sha256(paths.modelPath),
  ]);
  if (modelSha256 !== WHISPER_CPP_MODEL_SHA256) {
    throw new Error(`${WHISPER_CPP_MODEL_NAME} SHA-256 does not match the pinned model`);
  }
  return Object.freeze({
    binaryPath: paths.whisperBinaryPath,
    binarySha256,
    modelPath: paths.modelPath,
    modelBytes: model.size,
    modelSha256,
  });
}

export function createWhisperCppRegistration(
  paths: WhisperCppPaths,
  sessionGeneration = 1,
): IsolatedStreamingSttAdapterRegistration {
  assertAbsolutePaths(paths);
  if (!Number.isSafeInteger(sessionGeneration) || sessionGeneration <= 0) {
    throw new TypeError("sessionGeneration must be a positive safe integer");
  }
  return Object.freeze({
    descriptor: Object.freeze({
      adapterId: WHISPER_CPP_ADAPTER_ID,
      capability: "stt" as const,
      provider: "local-whisper-cpp",
      model: WHISPER_CPP_MODEL_NAME,
      modelVersion: `${WHISPER_CPP_TAG}:${WHISPER_CPP_COMMIT}`,
      estimatedCostUnits: 0,
    }),
    chunkSchema: sttAudioChunkSchema,
    eventSchema: sttStreamEventSchema,
    module: Object.freeze({
      modulePath: adapterModulePath,
      exportName: adapterExportName,
      allowedReadPaths: [],
      configuration: {
        ffmpegPath: paths.ffmpegPath,
        whisperBinaryPath: paths.whisperBinaryPath,
        modelPath: paths.modelPath,
        sessionGeneration: String(sessionGeneration),
      },
    }),
  });
}

export function registerWhisperCppStreamingStt(
  registry: ModelRoutingRegistry,
  paths: WhisperCppPaths,
  sessionGeneration = 1,
): void {
  const failure = registry.registerIsolatedStreamingStt(
    createWhisperCppRegistration(paths, sessionGeneration),
    { default: true },
  );
  if (failure !== undefined) throw new Error("Local whisper.cpp STT registration failed");
}

export class WhisperCppAdapterIsolate implements AdapterIsolate {
  readonly #fallback: AdapterIsolate;

  constructor(fallback: AdapterIsolate) {
    this.#fallback = fallback;
  }

  invoke(
    module: IsolatedAdapterModule,
    input: unknown,
    context: ModelInvocationContext,
  ): Promise<unknown> {
    return this.#fallback.invoke(module, input, context);
  }

  streamStt(
    module: IsolatedAdapterModule,
    chunks: AsyncIterable<SttAudioChunk>,
    context: ModelInvocationContext,
  ): AsyncIterable<SttStreamEvent> {
    if (module.modulePath !== adapterModulePath) {
      return this.#fallback.streamStt(module, chunks, context);
    }
    return runTrustedLocalWhisper(module, chunks, context);
  }
}

async function* runTrustedLocalWhisper(
  module: IsolatedAdapterModule,
  chunks: AsyncIterable<SttAudioChunk>,
  context: ModelInvocationContext,
): AsyncIterable<SttStreamEvent> {
  if (module.exportName !== adapterExportName) {
    throw new Error("Unexpected local whisper.cpp adapter export");
  }
  const imported: Readonly<Record<string, unknown>> = await import(
    pathToFileURL(module.modulePath).href
  );
  const adapter = imported[module.exportName];
  if (typeof adapter !== "function") throw new Error("Local whisper.cpp adapter export is invalid");
  const result = Reflect.apply(adapter, undefined, [
    chunks,
    {
      configuration: module.configuration,
      context: Object.freeze({
        tenantId: context.trustedContext.tenantId,
        requestId: context.trustedContext.requestId,
        traceId: context.trustedContext.traceId,
        policyVersion: context.trustedContext.policyVersion,
      }),
      signal: context.signal,
    },
  ]);
  if (!isAsyncIterable(result))
    throw new Error("Local whisper.cpp adapter did not return a stream");
  for await (const event of result) yield sttStreamEventSchema.parse(event);
}

function assertAbsolutePaths(paths: WhisperCppPaths): void {
  for (const [name, value] of Object.entries(paths)) {
    if (!isAbsolute(value)) throw new TypeError(`${name} must be an absolute path`);
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}
