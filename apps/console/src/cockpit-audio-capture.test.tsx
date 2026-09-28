import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerDom } from "@impromptu/test-harness";

registerDom();

const { act, cleanup, fireEvent, render } = await import("@testing-library/react");
const { AuthProvider } = await import("./auth-session");
const { CockpitAudioCapture } = await import("./cockpit-audio-capture");

import { messages } from "./i18n";
import type { ConsoleSessionClient } from "./session-client";

afterEach(cleanup);

// Capture state settles from promise chains that no single act() call encloses, so the tests
// drain those chains inside an explicit act scope. Testing Library only registers the act
// environment setup under the suite that first imports it, so this file asserts it for itself
// and restores whatever the surrounding suite had.
let previousActEnvironment: boolean | undefined;
beforeEach(() => {
  previousActEnvironment = (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT as
    | boolean
    | undefined;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

// The browser prompt is the consent gate, so the component talks to navigator.mediaDevices
// directly. These fakes stand in for the parts of that path that would otherwise leave the
// test process: MediaRecorder support, the SSE event stream, and the private API calls.
class FakeEventSource extends EventTarget {
  constructor() {
    super();
    // READY arrives on a microtask after the uploader attaches its listeners, keeping the
    // whole capture chain microtask-only so a bounded act drain can settle it.
    queueMicrotask(() => {
      const ready = new Event("READY");
      Object.defineProperty(ready, "data", { value: JSON.stringify({ kind: "READY" }) });
      this.dispatchEvent(ready);
    });
  }

  close() {}
}

class FakeMediaRecorder extends EventTarget {
  static isTypeSupported(_mimeType: string): boolean {
    return true;
  }

  state: RecordingState = "inactive";

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    this.dispatchEvent(new Event("stop"));
  }
}

globalThis.MediaRecorder = FakeMediaRecorder as unknown as typeof MediaRecorder;
// The capture chain posts grants and frames through fetch. Scoping this stub to the test
// lifecycle keeps it from poisoning sibling suites that sign in through the same global fetch
// (a permanent stub previously stripped set-cookie headers from their sign-in responses).
const realFetch = globalThis.fetch;
const stubFetch = (async () =>
  new Response(JSON.stringify({ expiresAtMs: Date.now() + 3_600_000 }), {
    status: 201,
  })) as unknown as typeof fetch;
beforeEach(() => {
  globalThis.fetch = stubFetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const stubClient = {} as ConsoleSessionClient;

const notice = {
  purpose: "실시간 자막",
  vendors: ["selected service"],
  region: "Korea",
  retention: "Memory only, up to 30 seconds",
  deletion: "Deleted when capture stops",
} as const;

function installMicrophone(script: (call: number) => Promise<MediaStream>): readonly number[] {
  const calls: number[] = [];
  const mediaDevices = {
    getUserMedia: async () => {
      calls.push(calls.length + 1);
      return script(calls.length);
    },
  } as unknown as MediaDevices;
  Object.defineProperty(navigator, "mediaDevices", {
    value: mediaDevices,
    configurable: true,
  });
  return calls;
}

function renderCapture() {
  return render(
    <AuthProvider client={stubClient}>
      <CockpitAudioCapture
        csrfToken="csrf-alpha"
        presentationSessionId="ps_alpha"
        presentationSessionEpoch="pse_1"
        actorId="actor_alpha"
        createEventSource={() => new FakeEventSource()}
        notice={notice}
        text={{
          capturing: "capturing-copy",
          denied: "denied-copy",
          unavailable: "unavailable-copy",
        }}
      />
    </AuthProvider>,
  );
}

function captureStatus(): string | null {
  return (
    document.querySelector("[data-capture-status]")?.getAttribute("data-capture-status") ?? null
  );
}

// The capture chain advances purely on microtasks, and each await here lets the whole pending
// microtask queue run once, so a bounded drain always settles the chain before act resolves.
async function drainCaptureChain() {
  await act(async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve();
  });
}

describe("cockpit audio capture failure copy", () => {
  test("microphone denial renders the attention status line with a retry control", async () => {
    installMicrophone(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    renderCapture();
    await drainCaptureChain();

    expect(captureStatus()).toBe("MICROPHONE_DENIED");
    const line = document.querySelector("[data-capture-status='MICROPHONE_DENIED']");
    expect(line?.className).toContain("console-status-line--attention");
    expect(document.querySelector("[data-capture-retry]")).toBeTruthy();
  });

  test("unavailable microphone also keeps the retry control reachable", async () => {
    installMicrophone(async () => {
      throw new DOMException("no device", "NotFoundError");
    });
    renderCapture();
    await drainCaptureChain();

    expect(captureStatus()).toBe("UNAVAILABLE");
    const line = document.querySelector("[data-capture-status='UNAVAILABLE']");
    expect(line?.className).toContain("console-status-line--attention");
    expect(document.querySelector("[data-capture-retry]")).toBeTruthy();
  });

  test("retry re-runs the capture start path and lands on capturing", async () => {
    const calls = installMicrophone(async (call) => {
      if (call === 1) throw new DOMException("denied", "NotAllowedError");
      return { getTracks: () => [] } as unknown as MediaStream;
    });
    renderCapture();
    await drainCaptureChain();

    expect(captureStatus()).toBe("MICROPHONE_DENIED");
    const retry = document.querySelector("[data-capture-retry]");
    expect(retry).toBeTruthy();

    // The click is a user gesture, so the browser is asked again and success reaches capture.
    await act(async () => {
      fireEvent.click(retry as Element);
    });
    await drainCaptureChain();

    expect(captureStatus()).toBe("CAPTURING");
    expect(calls.length).toBe(2);
    expect(document.querySelector("[data-capture-retry]")).toBeNull();
  });

  test("capturing renders neither the attention class nor a retry control", async () => {
    installMicrophone(async () => ({ getTracks: () => [] }) as unknown as MediaStream);
    renderCapture();
    await drainCaptureChain();

    expect(captureStatus()).toBe("CAPTURING");
    const line = document.querySelector("[data-capture-status='CAPTURING']");
    expect(line?.className).not.toContain("console-status-line--attention");
    expect(document.querySelector("[data-capture-retry]")).toBeNull();
  });

  test("ko and en locale key sets stay equal with the retry key added", () => {
    const ko = Object.keys(messages("ko")).sort();
    const en = Object.keys(messages("en")).sort();
    expect(ko).toEqual(en);
    expect(ko).toContain("captureRetry");
  });
});
