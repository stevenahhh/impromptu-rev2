import type { AudioConsentNoticeView, CaptureGrantView, CaptureUploader } from "./audio-capture";

export const WEBM_OPUS_MIME_TYPE = "audio/webm;codecs=opus" as const;
export const MEDIA_RECORDER_TIMESLICE_MS = 1_000;

type CaptureEventType = "READY" | "TRANSCRIPT" | "RECOMMENDATION" | "TERMINAL" | "error";

interface CaptureEventSource {
  addEventListener(type: CaptureEventType, listener: EventListener): void;
  removeEventListener(type: CaptureEventType, listener: EventListener): void;
  close(): void;
}

/**
 * Opens the capture event stream with `fetch` POST instead of `EventSource` GET. Cloudflare
 * quick tunnels buffer GET `text/event-stream` bodies until the upstream closes (cloudflared
 * #1449), which starved READY past the capture deadline in production; the POST body of the
 * same stream arrived unbuffered. Parsing reassembles `event:`/`data:` frames across arbitrary
 * chunk boundaries - including UTF-8 sequences split mid-codepoint and SSE lines split across
 * reads - and ignores keep-alive comment frames. `close()` aborts the fetch, which is also
 * how the uploader tears the stream down.
 */
class FetchSseEventSource extends EventTarget implements CaptureEventSource {
  readonly #abort = new AbortController();
  readonly #decoder = new TextDecoder();
  #buffer = "";
  #data = "";
  #eventName = "";
  #closed = false;

  constructor(url: string, fetchImpl: CaptureFetch, csrfToken: string, signal: AbortSignal) {
    super();
    signal.addEventListener("abort", () => this.#abort.abort(), { once: true });
    void this.#open(url, fetchImpl, csrfToken);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#abort.abort();
  }

  async #open(url: string, fetchImpl: CaptureFetch, csrfToken: string): Promise<void> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        credentials: "include",
        headers: mutationHeaders(csrfToken),
        signal: this.#abort.signal,
      });
      if (!response.ok || response.body === null) {
        throw new Error(`Audio event stream failed (${response.status})`);
      }
      reader = response.body.getReader();
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        this.#push(this.#decoder.decode(item.value, { stream: true }));
      }
      this.#push(this.#decoder.decode());
      // A stream that ends before TERMINAL is a severed connection, not a normal close: the
      // READY waiter must reject instead of timing out or hanging until the deadline.
      this.#fail();
    } catch {
      // AbortError from close()/cancel() is the normal teardown path; any other failure
      // surfaces as the EventSource-style "error" event.
      this.#fail();
    } finally {
      reader?.releaseLock();
    }
  }

  #fail(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.dispatchEvent(new Event("error"));
  }

  /** Consumes decoded text, dispatching an event for every complete blank-line-terminated frame. */
  #push(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      if (this.#buffer.length === 0) return;
      const lf = this.#buffer.indexOf("\n");
      const cr = this.#buffer.indexOf("\r");
      if (cr !== -1 && (lf === -1 || cr < lf)) {
        // A trailing CR may precede an LF arriving in the next chunk; hold it back.
        if (cr === this.#buffer.length - 1) return;
        const length = this.#buffer[cr + 1] === "\n" ? cr + 2 : cr + 1;
        this.#line(this.#buffer.slice(0, cr));
        this.#buffer = this.#buffer.slice(length);
      } else if (lf !== -1) {
        this.#line(this.#buffer.slice(0, lf));
        this.#buffer = this.#buffer.slice(lf + 1);
      } else {
        return;
      }
    }
  }

  #line(line: string): void {
    if (line === "") {
      if (this.#data !== "") {
        this.dispatchEvent(
          new MessageEvent(this.#eventName === "" ? "message" : this.#eventName, {
            data: this.#data,
          }),
        );
      }
      this.#data = "";
      this.#eventName = "";
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") this.#eventName = value;
    else if (field === "data") {
      this.#data = this.#data === "" ? value : `${this.#data}\n${value}`;
    }
  }
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
  /** Overrides the event-stream transport for tests; production always uses POST fetch SSE. */
  readonly createEventSource?: (url: string) => CaptureEventSource;
  readonly createMediaRecorder?: (
    stream: MediaStream,
    options: MediaRecorderOptions,
  ) => CaptureMediaRecorder;
  readonly readyTimeoutMs?: number;
  readonly onServerEvent?: (event: unknown) => void;
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
    source.removeEventListener("READY", onReady);
    source.removeEventListener("error", onError);
    if (timeout !== undefined) clearTimeout(timeout);
  };
  const complete = (action: () => void) => {
    if (settled) return;
    settled = true;
    cleanup();
    action();
  };
  const onReady: EventListener = (event) => {
    if (isReadyEvent(event)) complete(() => resolveReady?.());
  };
  const onError: EventListener = () =>
    complete(() => rejectReady?.(new Error("Audio event stream failed before READY")));

  const promise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
    source.addEventListener("READY", onReady);
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
  readonly #createEventSource: ((url: string) => CaptureEventSource) | undefined;
  readonly #createMediaRecorder: (
    stream: MediaStream,
    options: MediaRecorderOptions,
  ) => CaptureMediaRecorder;
  readonly #readyTimeoutMs: number;
  readonly #onServerEvent: ((event: unknown) => void) | undefined;

  #abortController: AbortController | undefined;
  #eventSource: CaptureEventSource | undefined;
  #readyWait: ReturnType<typeof boundedReady> | undefined;
  #recorder: CaptureMediaRecorder | undefined;
  #sequence = 0;
  #uploads: Promise<void> = Promise.resolve();
  #uploadError: Error | undefined;
  // Single-flight: cancel() racing a failing start() must still issue exactly one DELETE.
  #revokePending: Promise<void> | undefined;

  constructor(options: WebmOpusCaptureUploaderOptions) {
    this.#baseUrl = options.baseUrl ?? "";
    this.#csrfToken = options.csrfToken;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#createEventSource = options.createEventSource;
    this.#createMediaRecorder =
      options.createMediaRecorder ??
      ((stream, recorderOptions) => new MediaRecorder(stream, recorderOptions));
    this.#readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.#onServerEvent = options.onServerEvent;
  }

  async start(_grant: CaptureGrantView, stream: MediaStream): Promise<void> {
    if (this.#recorder !== undefined || this.#eventSource !== undefined) {
      throw new Error("Audio capture is already active");
    }

    this.#sequence = 0;
    this.#uploads = Promise.resolve();
    this.#uploadError = undefined;
    this.#revokePending = undefined;
    this.#abortController = new AbortController();
    // POST fetch is the default transport (see FetchSseEventSource); injected sources keep
    // tests off the network. Both receive the same URL and signal-driven teardown.
    const source =
      this.#createEventSource?.(`${this.#baseUrl}/v1/audio/events`) ??
      new FetchSseEventSource(
        `${this.#baseUrl}/v1/audio/events`,
        this.#fetch,
        this.#csrfToken,
        this.#abortController.signal,
      );
    this.#eventSource = source;
    for (const type of ["READY", "TRANSCRIPT", "RECOMMENDATION", "TERMINAL"] as const) {
      source.addEventListener(type, this.#forwardServerEvent);
    }
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
    if (hadRemoteGrant) void this.#revokeOnce();
  }

  async whenIdle(): Promise<void> {
    await this.#uploads;
    await this.#revokePending;
  }

  readonly #forwardServerEvent: EventListener = (event) => {
    const data = eventData(event);
    if (data !== null) this.#onServerEvent?.(data);
  };

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
    await this.#revokeOnce();
  }

  #revokeOnce(): Promise<void> {
    this.#revokePending ??= this.#deleteGrant();
    return this.#revokePending;
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
    if (this.#eventSource !== undefined) {
      for (const type of ["READY", "TRANSCRIPT", "RECOMMENDATION", "TERMINAL"] as const) {
        this.#eventSource.removeEventListener(type, this.#forwardServerEvent);
      }
      this.#eventSource.close();
    }
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
