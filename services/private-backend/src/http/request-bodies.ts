import { MAX_AUDIO_FRAME_BYTES } from "../audio-ingest.ts";

export async function requestBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

type AudioFrameBody =
  | Readonly<{ outcome: "READ"; bytes: Uint8Array }>
  | Readonly<{ outcome: "REJECTED"; reason: "EMPTY_FRAME" | "FRAME_TOO_LARGE" }>;

export async function readAudioFrame(request: Request): Promise<AudioFrameBody> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) return { outcome: "REJECTED", reason: "FRAME_TOO_LARGE" };
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength > MAX_AUDIO_FRAME_BYTES) {
      return { outcome: "REJECTED", reason: "FRAME_TOO_LARGE" };
    }
  }
  if (request.body === null) return { outcome: "REJECTED", reason: "EMPTY_FRAME" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    byteLength += item.value.byteLength;
    if (byteLength > MAX_AUDIO_FRAME_BYTES) {
      await reader.cancel("audio frame exceeds memory boundary");
      return { outcome: "REJECTED", reason: "FRAME_TOO_LARGE" };
    }
    chunks.push(item.value);
  }
  if (byteLength === 0) return { outcome: "REJECTED", reason: "EMPTY_FRAME" };
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { outcome: "READ", bytes };
}

export function boundedAudioHeader(request: Request, name: string, maximum: number): number | null {
  const value = request.headers.get(name);
  if (value === null || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function accountCredentials(
  value: unknown,
): { readonly username: string; readonly password: string } | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    typeof value.username !== "string" ||
    typeof value.password !== "string"
  ) {
    return null;
  }
  return { username: value.username, password: value.password };
}

export function isMultipartFormData(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "multipart/form-data";
}

const MAX_REFERENCE_UPLOAD_BODY_BYTES = 24 * 1024 * 1024;

type BoundedFormBody =
  | Readonly<{ outcome: "READ"; form: FormData }>
  | Readonly<{ outcome: "REJECTED"; reason: "TOO_LARGE" | "MALFORMED_INPUT" }>;

/** Reads a multipart reference upload strictly inside one bounded buffer before parsing it. */
export async function boundedReferenceUploadForm(request: Request): Promise<BoundedFormBody> {
  if (request.body === null) return { outcome: "REJECTED", reason: "MALFORMED_INPUT" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    totalBytes += next.value.byteLength;
    if (totalBytes > MAX_REFERENCE_UPLOAD_BODY_BYTES) {
      await reader.cancel("reference upload exceeds the request limit");
      return { outcome: "REJECTED", reason: "TOO_LARGE" };
    }
    chunks.push(next.value);
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const contentType = request.headers.get("content-type") ?? "";
    const envelope = new Request("https://reference-documents.local/upload", {
      method: "POST",
      headers: { "content-type": contentType },
      body: body.buffer as ArrayBuffer,
    });
    return { outcome: "READ", form: await envelope.formData() };
  } catch {
    return { outcome: "REJECTED", reason: "MALFORMED_INPUT" };
  }
}
