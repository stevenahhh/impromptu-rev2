import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());
const { act, cleanup, fireEvent, render, within } = await import("@testing-library/react");
const { AudioConsentControl, BrowserCaptureController } = await import("./audio-capture");
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

function runtime() {
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
      return stream;
    },
  } as unknown as MediaDevices;
  return { events, controller: new BrowserCaptureController(mediaDevices, uploader, () => 2_000) };
}

describe("browser audio consent", () => {
  test("does not request a microphone or grant before explicit acceptance", async () => {
    const { events, controller } = runtime();
    let grants = 0;
    render(
      <AudioConsentControl
        controller={controller}
        notice={{
          purpose: "실시간 자막",
          vendors: ["selected service"],
          region: "Korea",
          retention: "Memory only, up to 30 seconds",
          deletion: "Deleted when capture stops",
        }}
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

  test("revoking mid-session cancels upload and stops every track", async () => {
    const { events, controller } = runtime();
    render(
      <AudioConsentControl
        controller={controller}
        notice={{
          purpose: "Captions",
          vendors: ["selected service"],
          region: "Korea",
          retention: "Memory only",
          deletion: "On stop",
        }}
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
});
