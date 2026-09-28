import { afterEach, describe, expect, test } from "bun:test";
import { registerDom } from "@impromptu/test-harness";

registerDom();

const { cleanup } = await import("@testing-library/react");
const { BrowserCaptureController, BrowserCaptureError } = await import("./audio-capture");
const {
  createCaptureGrantRequester,
  MEDIA_RECORDER_TIMESLICE_MS,
  WebmOpusCaptureUploader,
  WEBM_OPUS_MIME_TYPE,
} = await import("./webm-opus-capture");
afterEach(cleanup);

const grant = {
  captureGrantId: "capture_alpha",
  presentationSessionId: "ps_alpha",
  presentationSessionEpoch: "pse_1",
  actorId: "actor_alpha",
  captureDeviceId: "device_microphone",
  consentRecordId: "consent_alpha",
  issuedAtMs: 1_000,
  expiresAtMs: 61_000,
} as const;

const notice = {
  purpose: "실시간 자막",
  vendors: ["selected service"],
  region: "Korea",
  retention: "Memory only, up to 30 seconds",
  deletion: "Deleted when capture stops",
} as const;

function runtime(options: { readonly denied?: boolean; readonly supported?: boolean } = {}) {
  const events: string[] = [];
  const track = { stop: () => events.push("track.stop") };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const uploader = {
    async start(_grant: typeof grant, _stream: MediaStream) {
      events.push("upload.start");
    },
    async finish() {
      events.push("upload.finish");
    },
    cancel() {
      events.push("upload.cancel");
    },
  };
  const mediaDevices = {
    async getUserMedia() {
      events.push("media.request");
      if (options.denied) throw new DOMException("denied", "NotAllowedError");
      return stream;
    },
  } as unknown as MediaDevices;
  const codecChecks: string[] = [];
  return {
    events,
    codecChecks,
    controller: new BrowserCaptureController(
      mediaDevices,
      uploader,
      () => 2_000,
      (mimeType) => {
        codecChecks.push(mimeType);
        return options.supported ?? true;
      },
    ),
  };
}

class FakeEventSource extends EventTarget {
  closed = false;

  close() {
    this.closed = true;
  }

  emit(type: "READY" | "TRANSCRIPT" | "RECOMMENDATION" | "TERMINAL", data: unknown) {
    const event = new Event(type);
    Object.defineProperty(event, "data", { value: JSON.stringify(data) });
    this.dispatchEvent(event);
  }

  ready() {
    this.emit("READY", { kind: "READY" });
  }
}

class FakeMediaRecorder extends EventTarget {
  state: RecordingState = "inactive";
  readonly starts: number[] = [];

  start(timeslice?: number) {
    this.state = "recording";
    this.starts.push(timeslice ?? 0);
  }

  emitFrame(bytes: readonly number[]) {
    const event = new Event("dataavailable");
    Object.defineProperty(event, "data", {
      value: new Blob([new Uint8Array(bytes)], { type: WEBM_OPUS_MIME_TYPE }),
    });
    this.dispatchEvent(event);
  }

  stop() {
    this.state = "inactive";
    this.dispatchEvent(new Event("stop"));
  }
}

type CapturedRequest = Readonly<{
  url: string;
  method: string;
  headers: Headers;
  body: BodyInit | null;
}>;

function uploaderRuntime(onServerEvent?: (event: unknown) => void) {
  const source = new FakeEventSource();
  const recorder = new FakeMediaRecorder();
  const requests: CapturedRequest[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body ?? null,
    });
    return new Response(JSON.stringify({ status: "ok" }), { status: 202 });
  }) as typeof fetch;
  const uploader = new WebmOpusCaptureUploader({
    csrfToken: "csrf-alpha",
    fetch: fakeFetch,
    createEventSource: (url) => {
      requests.push({ url, method: "SSE", headers: new Headers(), body: null });
      return source;
    },
    createMediaRecorder: (_stream, options) => {
      expect(options.mimeType).toBe(WEBM_OPUS_MIME_TYPE);
      return recorder;
    },
    ...(onServerEvent === undefined ? {} : { onServerEvent }),
  });
  return { source, recorder, requests, uploader };
}

function requestCount(requests: readonly CapturedRequest[], suffix: string): number {
  return requests.filter((request) => request.url.endsWith(suffix)).length;
}

async function bounded<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), 5_000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Feeds the real default event transport: the uploader opens the stream with an authenticated
 * POST fetch and parses SSE frames itself. The test controls the exact chunk boundaries so
 * frames, comments, and multi-byte codepoints can be split anywhere.
 */
function fetchSseRuntime(onServerEvent?: (event: unknown) => void) {
  const recorder = new FakeMediaRecorder();
  const requests: CapturedRequest[] = [];
  const credentials: string[] = [];
  let eventsSignal: AbortSignal | undefined;
  let eventsController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  const eventsStream = new ReadableStream<Uint8Array>({
    start(controller) {
      eventsController = controller;
    },
  });
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body ?? null,
    });
    if (String(input).endsWith("/v1/audio/events")) {
      eventsSignal = init?.signal ?? undefined;
      credentials.push(init?.credentials ?? "omitted");
      return new Response(eventsStream, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    }
    return new Response(JSON.stringify({ status: "ok" }), { status: 202 });
  }) as typeof fetch;
  const uploader = new WebmOpusCaptureUploader({
    csrfToken: "csrf-alpha",
    fetch: fakeFetch,
    createMediaRecorder: (_stream, options) => {
      expect(options.mimeType).toBe(WEBM_OPUS_MIME_TYPE);
      return recorder;
    },
    ...(onServerEvent === undefined ? {} : { onServerEvent }),
  });
  const write = (chunk: string | Uint8Array) => {
    eventsController?.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
  };
  return {
    recorder,
    requests,
    credentials,
    uploader,
    write,
    eventsStream,
    signal: () => eventsSignal,
  };
}

describe("browser audio capture", () => {
  test("answers the browser prompt before anything reaches the network", async () => {
    const { events, controller } = runtime();
    let grants = 0;

    await controller.start(async () => {
      grants += 1;
      return grant;
    });

    // The microphone is asked for first, so a refusal never becomes a request.
    expect(events).toEqual(["media.request", "upload.start"]);
    expect(grants).toBe(1);
  });

  test("microphone denial keeps grant, start, and frame requests at zero", async () => {
    const { controller, events } = runtime({ denied: true });
    let grants = 0;

    await expect(
      controller.start(async () => {
        grants += 1;
        return grant;
      }),
    ).rejects.toEqual(new BrowserCaptureError("MICROPHONE_DENIED"));

    expect(grants).toBe(0);
    expect(events).toEqual(["media.request"]);
  });

  test("unsupported codec checks only WebM Opus and keeps microphone and network at zero", async () => {
    const { codecChecks, controller, events } = runtime({ supported: false });
    let grants = 0;

    await expect(
      controller.start(async () => {
        grants += 1;
        return grant;
      }),
    ).rejects.toEqual(new BrowserCaptureError("UNSUPPORTED_CODEC"));

    expect(codecChecks).toEqual([WEBM_OPUS_MIME_TYPE]);
    expect(grants).toBe(0);
    expect(events).toEqual([]);
  });

  test("revoking mid-session cancels upload and stops every track", async () => {
    const { events, controller } = runtime();
    const issued = await controller.start(async () => grant);

    expect(controller.revoke(issued.captureGrantId)).toBe("GRANT_REVOKED");
    expect(events).toEqual(["media.request", "upload.start", "upload.cancel", "track.stop"]);
  });

  test("disposing the controller cancels active capture and stops every track", async () => {
    const { events, controller } = runtime();
    await controller.start(async () => grant);

    controller.dispose();
    expect(events).toEqual(["media.request", "upload.start", "upload.cancel", "track.stop"]);
  });
});

describe("WebM Opus private upload", () => {
  test("forwards named private stream events only while the capture stream is open", async () => {
    const events: unknown[] = [];
    const { source, uploader } = uploaderRuntime((event) => events.push(event));
    const starting = uploader.start(grant, { getTracks: () => [] } as unknown as MediaStream);
    source.ready();
    await starting;
    source.emit("TRANSCRIPT", {
      kind: "TRANSCRIPT",
      event: { kind: "PARTIAL", transcript: { text: "미리보기" } },
    });
    expect(events).toEqual([
      { kind: "READY" },
      {
        kind: "TRANSCRIPT",
        event: { kind: "PARTIAL", transcript: { text: "미리보기" } },
      },
    ]);

    uploader.cancel();
    source.emit("TRANSCRIPT", { kind: "TRANSCRIPT", event: { kind: "PARTIAL" } });
    expect(events).toHaveLength(2);
  });

  test("opens SSE before start, waits for exact READY, uploads ordered 1,000 ms frames, and stops", async () => {
    const { recorder, requests, source, uploader } = uploaderRuntime();
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const starting = uploader.start(grant, stream);

    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual(["SSE /v1/audio/events"]);
    expect(recorder.starts).toEqual([]);

    const unrelated = new Event("message");
    Object.defineProperty(unrelated, "data", { value: JSON.stringify({ kind: "TRANSCRIPT" }) });
    source.dispatchEvent(unrelated);
    expect(recorder.starts).toEqual([]);
    source.ready();
    await starting;

    expect(requests[1]?.url).toBe("/v1/audio/stream/start");
    expect(recorder.starts).toEqual([MEDIA_RECORDER_TIMESLICE_MS]);
    recorder.emitFrame([1, 2, 3]);
    recorder.emitFrame([4, 5]);
    await uploader.finish();

    const frames = requests.filter((request) => request.url.endsWith("/v1/audio/frames"));
    expect(frames).toHaveLength(2);
    expect(frames.map((frame) => frame.headers.get("x-audio-sequence"))).toEqual(["0", "1"]);
    expect(frames.map((frame) => frame.headers.get("x-audio-duration-ms"))).toEqual([
      "1000",
      "1000",
    ]);
    expect(
      frames.every((frame) => frame.headers.get("content-type") === "application/octet-stream"),
    ).toBe(true);
    expect(requestCount(requests, "/v1/audio/stream/stop")).toBe(1);
    expect(source.closed).toBe(true);
  });

  test("cancel closes recorder and SSE, revokes the HttpOnly-cookie grant, and blocks late frames", async () => {
    const { recorder, requests, source, uploader } = uploaderRuntime();
    const starting = uploader.start(grant, { getTracks: () => [] } as unknown as MediaStream);
    source.ready();
    await starting;

    uploader.cancel();
    recorder.emitFrame([9]);
    await uploader.whenIdle();

    expect(recorder.state).toBe("inactive");
    expect(source.closed).toBe(true);
    expect(requestCount(requests, "/v1/audio/grant")).toBe(1);
    expect(requestCount(requests, "/v1/audio/frames")).toBe(0);
    expect(requestCount(requests, "/v1/audio/stream/stop")).toBe(0);
  });

  test("default transport opens POST SSE and parses named events across chunk boundaries", async () => {
    const events: unknown[] = [];
    const { credentials, recorder, requests, signal, uploader, write } = fetchSseRuntime((event) =>
      events.push(event),
    );
    const starting = uploader.start(grant, { getTracks: () => [] } as unknown as MediaStream);

    // The event stream is a cookie-carrying CSRF mutation, not an EventSource GET.
    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "POST /v1/audio/events",
    ]);
    expect(requests[0]?.headers.get("x-csrf-token")).toBe("csrf-alpha");
    expect(credentials).toEqual(["include"]);
    expect(recorder.starts).toEqual([]);

    // READY arrives with its event line split mid-token and its data line split mid-value;
    // a keep-alive comment frame (also split across chunks) must neither satisfy READY nor
    // reach the forwarding callback.
    write("event: REA");
    write('DY\ndata: {"kind":"REA');
    write('DY"}\n\n: keep-al');
    write("ive\n\n");
    await bounded(starting, "capture never became ready over the POST event stream");
    expect(recorder.starts).toEqual([MEDIA_RECORDER_TIMESLICE_MS]);
    expect(requests[1]?.method).toBe("POST");
    expect(requests[1]?.url).toBe("/v1/audio/stream/start");

    // A TRANSCRIPT whose UTF-8 payload is split inside a multi-byte character still parses.
    const transcript =
      'event: TRANSCRIPT\ndata: {"kind":"TRANSCRIPT","event":{"kind":"PARTIAL","transcript":{"text":"반가워요"}}}\n\n';
    const encoded = new TextEncoder().encode(transcript);
    const split = encoded.findIndex((byte, index) => index > 20 && byte > 0x7f);
    write(encoded.subarray(0, split + 1));
    write(encoded.subarray(split + 1));

    recorder.emitFrame([1, 2, 3]);
    recorder.emitFrame([4, 5]);
    write('event: TERMINAL\ndata: {"kind":"TERMINAL","outcome":"COMPLETED"}\n\n');
    await uploader.finish();

    expect(events).toEqual([
      { kind: "READY" },
      {
        kind: "TRANSCRIPT",
        event: { kind: "PARTIAL", transcript: { text: "반가워요" } },
      },
      { kind: "TERMINAL", outcome: "COMPLETED" },
    ]);
    const frames = requests.filter((request) => request.url.endsWith("/v1/audio/frames"));
    expect(frames.map((frame) => frame.headers.get("x-audio-sequence"))).toEqual(["0", "1"]);
    expect(requestCount(requests, "/v1/audio/stream/stop")).toBe(1);
    expect(signal()?.aborted).toBe(true);
  });

  test("a rejected POST event stream fails before stream start and still revokes the grant", async () => {
    const requests: CapturedRequest[] = [];
    const recorder = new FakeMediaRecorder();
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: init?.body ?? null,
      });
      if (String(input).endsWith("/v1/audio/events")) {
        return new Response(JSON.stringify({ error: "capture_grant_required" }), {
          status: 401,
        });
      }
      return new Response(JSON.stringify({ status: "ok" }), { status: 202 });
    }) as typeof fetch;
    const uploader = new WebmOpusCaptureUploader({
      csrfToken: "csrf-alpha",
      fetch: fakeFetch,
      createMediaRecorder: () => recorder,
    });

    await expect(
      uploader.start(grant, { getTracks: () => [] } as unknown as MediaStream),
    ).rejects.toThrow("Audio event stream failed");

    expect(recorder.starts).toEqual([]);
    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "POST /v1/audio/events",
      "DELETE /v1/audio/grant",
    ]);
  });

  test("cancel before READY aborts the POST event stream and revokes the grant", async () => {
    const { requests, signal, uploader } = fetchSseRuntime();
    const starting = uploader.start(grant, { getTracks: () => [] } as unknown as MediaStream);
    uploader.cancel();
    await expect(starting).rejects.toThrow("cancelled");
    await uploader.whenIdle();

    expect(signal()?.aborted).toBe(true);
    expect(requestCount(requests, "/v1/audio/grant")).toBe(1);
    expect(requestCount(requests, "/v1/audio/stream/start")).toBe(0);
  });

  test("grant requester sends the frozen MIME and complete explicit consent", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const requester = createCaptureGrantRequester({
      csrfToken: "csrf-alpha",
      input: {
        presentationSessionId: grant.presentationSessionId,
        presentationSessionEpoch: grant.presentationSessionEpoch,
        actorId: grant.actorId,
        captureDeviceId: grant.captureDeviceId,
        consentRecordId: grant.consentRecordId,
        notice,
        acceptedAtMs: 2_000,
      },
      now: () => 2_001,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), ...(init === undefined ? {} : { init }) });
        return new Response(
          JSON.stringify({ mimeType: WEBM_OPUS_MIME_TYPE, expiresAtMs: 61_000 }),
          {
            status: 201,
            headers: { "content-type": "application/json" },
          },
        );
      }) as typeof fetch,
    });

    expect(await requester()).toEqual({
      ...grant,
      captureGrantId: "HTTP_ONLY_COOKIE",
      issuedAtMs: 2_001,
    });
    expect(requests[0]?.url).toBe("/v1/audio/grants");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      mimeType: WEBM_OPUS_MIME_TYPE,
      consent: {
        consentRecordId: grant.consentRecordId,
        presentationSessionId: grant.presentationSessionId,
        presentationSessionEpoch: grant.presentationSessionEpoch,
        actorId: grant.actorId,
        captureDeviceId: grant.captureDeviceId,
        notice,
        explicitlyAccepted: true,
        acceptedAtMs: 2_000,
      },
    });
  });
});
