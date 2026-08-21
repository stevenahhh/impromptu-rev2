import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());
const { act, cleanup, fireEvent, render, within } = await import("@testing-library/react");
const { AudioConsentControl, BrowserCaptureController, BrowserCaptureError } = await import(
  "./audio-capture"
);
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

  ready() {
    const event = new Event("message");
    Object.defineProperty(event, "data", { value: JSON.stringify({ kind: "READY" }) });
    this.dispatchEvent(event);
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

function uploaderRuntime() {
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
  });
  return { source, recorder, requests, uploader };
}

function requestCount(requests: readonly CapturedRequest[], suffix: string): number {
  return requests.filter((request) => request.url.endsWith(suffix)).length;
}

describe("browser audio consent", () => {
  test("does not request a microphone or grant before explicit acceptance", async () => {
    const { events, controller } = runtime();
    let grants = 0;
    render(
      <AudioConsentControl
        controller={controller}
        notice={notice}
        requestGrant={async () => {
          grants += 1;
          return grant;
        }}
      />,
    );

    const start = within(document.body).getByRole("button", { name: "Start microphone" });
    expect(start.hasAttribute("disabled")).toBe(true);
    expect(events).toEqual([]);
    expect(grants).toBe(0);

    fireEvent.click(within(document.body).getByRole("checkbox", { name: /I consent/ }));
    await act(async () => fireEvent.click(start));
    expect(grants).toBe(1);
    expect(events).toEqual(["media.request", "upload.start"]);
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
    render(
      <AudioConsentControl
        controller={controller}
        notice={notice}
        requestGrant={async () => grant}
      />,
    );
    fireEvent.click(within(document.body).getByRole("checkbox", { name: /I consent/ }));
    await act(async () =>
      fireEvent.click(within(document.body).getByRole("button", { name: "Start microphone" })),
    );
    fireEvent.click(within(document.body).getByRole("button", { name: "Revoke consent" }));

    expect(events).toEqual(["media.request", "upload.start", "upload.cancel", "track.stop"]);
    expect(within(document.body).getByText("Consent revoked. Capture stopped.")).toBeTruthy();
  });

  test("unmount cancels active capture and stops every track", async () => {
    const { events, controller } = runtime();
    const view = render(
      <AudioConsentControl
        controller={controller}
        notice={notice}
        requestGrant={async () => grant}
      />,
    );
    fireEvent.click(within(document.body).getByRole("checkbox", { name: /I consent/ }));
    await act(async () =>
      fireEvent.click(within(document.body).getByRole("button", { name: "Start microphone" })),
    );
    view.unmount();

    expect(events).toEqual(["media.request", "upload.start", "upload.cancel", "track.stop"]);
  });
});

describe("WebM Opus private upload", () => {
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
