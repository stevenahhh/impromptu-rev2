import type { AudioConsentNoticeView, CaptureGrantView, CaptureUploader } from "./audio-capture";

export const WEBM_OPUS_MIME_TYPE = "audio/webm;codecs=opus" as const;
export const MEDIA_RECORDER_TIMESLICE_MS = 1_000;

interface CaptureEventSource {
  addEventListener(type: "message" | "error", listener: EventListener): void;
  removeEventListener(type: "message" | "error", listener: EventListener): void;
  close(): void;
}

interface CaptureMediaRecorder extends EventTarget {
  readonly state: RecordingState;
  start(timeslice?: number): void;
  stop(): void;
}

type CaptureFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface WebmOpusCaptureUploaderOptions {
  readonly csrfToken: string;
  readonly baseUrl?: string;
  readonly fetch?: CaptureFetch;
  readonly createEventSource?: (url: string) => CaptureEventSource;
  readonly createMediaRecorder?: (
    stream: MediaStream,
    options: MediaRecorderOptions,
  ) => CaptureMediaRecorder;
  readonly readyTimeoutMs?: number;
}

export interface CaptureGrantRequestInput {
  readonly presentationSessionId: string;
  readonly presentationSessionEpoch: string;
  readonly actorId: string;
  readonly captureDeviceId: string;
  readonly consentRecordId: string;
  readonly notice: AudioConsentNoticeView;
  readonly acceptedAtMs: number;
}

export interface CaptureGrantRequesterOptions {
  readonly csrfToken: string;
  readonly input: CaptureGrantRequestInput;
  readonly baseUrl?: string;
  readonly fetch?: CaptureFetch;
  readonly now?: () => number;
}

const DEFAULT_READY_TIMEOUT_MS = 10_000;

function mutationHeaders(csrfToken: string, contentType?: string): HeadersInit {
  return {
    "x-csrf-token": csrfToken,
    ...(contentType === undefined ? {} : { "content-type": contentType }),
  };
}

async function requireOk(response: Response, operation: string): Promise<void> {
  if (!response.ok) throw new Error(`${operation} failed (${response.status})`);
}

function eventData(event: Event): unknown {
  if (!("data" in event) || typeof event.data !== "string") return null;
  try {
    return JSON.parse(event.data) as unknown;
  } catch {
    return null;
  }
}

function isReadyEvent(event: Event): boolean {
  const data = eventData(event);
  return (
    typeof data === "object" &&
    data !== null &&
    Object.keys(data).length === 1 &&
    (data as Record<string, unknown>).kind === "READY"
  );
}

function boundedReady(
  source: CaptureEventSource,
  timeoutMs: number,
): { readonly promise: Promise<void>; readonly dispose: () => void } {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;

  const cleanup = () => {
    source.removeEventListener("message", onMessage);
    source.removeEventListener("error", onError);
    if (timeout !== undefined) clearTimeout(timeout);
  };
  const complete = (action: () => void) => {
    if (settled) return;
    settled = true;
    cleanup();
    action();
  };
  const onMessage: EventListener = (event) => {
    if (isReadyEvent(event)) complete(() => resolveReady?.());
  };
  const onError: EventListener = () =>
    complete(() => rejectReady?.(new Error("Audio event stream failed before READY")));

  const promise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
    source.addEventListener("message", onMessage);
    source.addEventListener("error", onError);
    timeout = setTimeout(
      () => complete(() => reject(new Error("Audio event stream timed out before READY"))),
      timeoutMs,
    );
  });
  return {
    promise,
    dispose: () => complete(() => rejectReady?.(new Error("Audio capture was cancelled"))),
  };
}

function stopped(recorder: CaptureMediaRecorder): Promise<void> {
  return new Promise((resolve) => {
    const onStop: EventListener = () => {
      recorder.removeEventListener("stop", onStop);
      resolve();
    };
    recorder.addEventListener("stop", onStop);
  });
}

export class WebmOpusCaptureUploader implements CaptureUploader {
  readonly #baseUrl: string;
  readonly #csrfToken: string;
  readonly #fetch: CaptureFetch;
  readonly #createEventSource: (url: string) => CaptureEventSource;
  readonly #createMediaRecorder: (
    stream: MediaStream,
    options: MediaRecorderOptions,
  ) => CaptureMediaRecorder;
  readonly #readyTimeoutMs: number;

  #abortController: AbortController | undefined;
  #eventSource: CaptureEventSource | undefined;
  #readyWait: ReturnType<typeof boundedReady> | undefined;
  #recorder: CaptureMediaRecorder | undefined;
  #sequence = 0;
  #uploads: Promise<void> = Promise.resolve();
  #uploadError: Error | undefined;
  #revoke: Promise<void> = Promise.resolve();

  constructor(options: WebmOpusCaptureUploaderOptions) {
    this.#baseUrl = options.baseUrl ?? "";
    this.#csrfToken = options.csrfToken;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#createEventSource =
      options.createEventSource ?? ((url) => new EventSource(url, { withCredentials: true }));
    this.#createMediaRecorder =
      options.createMediaRecorder ??
      ((stream, recorderOptions) => new MediaRecorder(stream, recorderOptions));
    this.#readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  }

  async start(_grant: CaptureGrantView, stream: MediaStream): Promise<void> {
    if (this.#recorder !== undefined || this.#eventSource !== undefined) {
      throw new Error("Audio capture is already active");
    }

    this.#sequence = 0;
    this.#uploads = Promise.resolve();
    this.#uploadError = undefined;
    this.#abortController = new AbortController();
    const source = this.#createEventSource(`${this.#baseUrl}/v1/audio/events`);
    this.#eventSource = source;
    const ready = boundedReady(source, this.#readyTimeoutMs);
    this.#readyWait = ready;

    try {
      await ready.promise;
      await requireOk(
        await this.#fetch(`${this.#baseUrl}/v1/audio/stream/start`, {
          method: "POST",
          credentials: "include",
          headers: mutationHeaders(this.#csrfToken),
          signal: this.#abortController.signal,
        }),
        "Audio stream start",
      );

      const recorder = this.#createMediaRecorder(stream, { mimeType: WEBM_OPUS_MIME_TYPE });
      recorder.addEventListener("dataavailable", this.#onDataAvailable);
      this.#recorder = recorder;
      recorder.start(MEDIA_RECORDER_TIMESLICE_MS);
    } catch (caught) {
      await this.#cleanupFailedStart();
      throw caught;
    }
  }

  async finish(): Promise<void> {
    const recorder = this.#recorder;
    if (recorder === undefined) return;

    if (recorder.state !== "inactive") {
      const didStop = stopped(recorder);
      recorder.stop();
      await didStop;
    }
    recorder.removeEventListener("dataavailable", this.#onDataAvailable);
    this.#recorder = undefined;
    await this.#uploads;

    try {
      if (this.#uploadError !== undefined) throw this.#uploadError;
      await requireOk(
        await this.#fetch(`${this.#baseUrl}/v1/audio/stream/stop`, {
          method: "POST",
          credentials: "include",
          headers: mutationHeaders(this.#csrfToken),
          ...(this.#abortController === undefined ? {} : { signal: this.#abortController.signal }),
        }),
        "Audio stream stop",
      );
    } finally {
      this.#closeLocalResources();
    }
  }

  cancel(): void {
    const hadRemoteGrant = this.#eventSource !== undefined || this.#recorder !== undefined;
    this.#readyWait?.dispose();
    this.#abortController?.abort();
    const recorder = this.#recorder;
    if (recorder !== undefined) {
      recorder.removeEventListener("dataavailable", this.#onDataAvailable);
      if (recorder.state !== "inactive") recorder.stop();
    }
    this.#closeLocalResources();
    if (hadRemoteGrant) this.#revoke = this.#deleteGrant();
  }

  async whenIdle(): Promise<void> {
    await this.#uploads;
    await this.#revoke;
  }

  readonly #onDataAvailable: EventListener = (event) => {
    const data = "data" in event ? event.data : undefined;
    if (!(data instanceof Blob) || data.size === 0) return;
    const sequence = this.#sequence;
    this.#sequence += 1;
    const blob = data;
    const signal = this.#abortController?.signal;
    this.#uploads = this.#uploads
      .then(async () => {
        await requireOk(
          await this.#fetch(`${this.#baseUrl}/v1/audio/frames`, {
            method: "POST",
            credentials: "include",
            headers: {
              ...mutationHeaders(this.#csrfToken, "application/octet-stream"),
              "x-audio-sequence": String(sequence),
              "x-audio-duration-ms": String(MEDIA_RECORDER_TIMESLICE_MS),
            },
            body: blob,
            ...(signal === undefined ? {} : { signal }),
          }),
          "Audio frame upload",
        );
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        this.#uploadError =
          caught instanceof Error ? caught : new Error("Audio frame upload failed");
      });
  };

  async #cleanupFailedStart(): Promise<void> {
    this.#readyWait?.dispose();
    this.#abortController?.abort();
    this.#closeLocalResources();
    this.#revoke = this.#deleteGrant();
    await this.#revoke;
  }

  async #deleteGrant(): Promise<void> {
    try {
      await this.#fetch(`${this.#baseUrl}/v1/audio/grant`, {
        method: "DELETE",
        credentials: "include",
        headers: mutationHeaders(this.#csrfToken),
      });
    } catch {
      // Local capture is already closed; the server grant expires independently if unreachable.
    }
  }

  #closeLocalResources(): void {
    this.#readyWait = undefined;
    this.#eventSource?.close();
    this.#eventSource = undefined;
    this.#recorder = undefined;
    this.#abortController = undefined;
  }
}

export function createCaptureGrantRequester({
  baseUrl = "",
  csrfToken,
  fetch: fetchImplementation,
  input,
  now = Date.now,
}: CaptureGrantRequesterOptions): () => Promise<CaptureGrantView> {
  const fetchRequest = fetchImplementation ?? ((request, init) => fetch(request, init));
  return async () => {
    const response = await fetchRequest(`${baseUrl}/v1/audio/grants`, {
      method: "POST",
      credentials: "include",
      headers: mutationHeaders(csrfToken, "application/json"),
      body: JSON.stringify({
        mimeType: WEBM_OPUS_MIME_TYPE,
        consent: {
          consentRecordId: input.consentRecordId,
          presentationSessionId: input.presentationSessionId,
          presentationSessionEpoch: input.presentationSessionEpoch,
          actorId: input.actorId,
          captureDeviceId: input.captureDeviceId,
          notice: input.notice,
          explicitlyAccepted: true,
          acceptedAtMs: input.acceptedAtMs,
        },
      }),
    });
    const body: unknown = await response.json();
    const expiresAtMs =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>).expiresAtMs
        : undefined;
    if (!response.ok || typeof expiresAtMs !== "number") {
      throw new Error(`Audio capture grant failed (${response.status})`);
    }
    return {
      captureGrantId: "HTTP_ONLY_COOKIE",
      presentationSessionId: input.presentationSessionId,
      presentationSessionEpoch: input.presentationSessionEpoch,
      actorId: input.actorId,
      captureDeviceId: input.captureDeviceId,
      consentRecordId: input.consentRecordId,
      issuedAtMs: now(),
      expiresAtMs,
    };
  };
}
