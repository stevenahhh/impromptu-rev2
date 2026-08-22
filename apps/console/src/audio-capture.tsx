const WEBM_OPUS_MIME_TYPE = "audio/webm;codecs=opus";

export interface CaptureGrantView {
  readonly captureGrantId: string;
  readonly presentationSessionId: string;
  readonly presentationSessionEpoch: string;
  readonly actorId: string;
  readonly captureDeviceId: string;
  readonly consentRecordId: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export interface AudioConsentNoticeView {
  readonly purpose: string;
  readonly vendors: readonly string[];
  readonly region: string;
  readonly retention: string;
  readonly deletion: string;
}

export interface CaptureUploader {
  start(grant: CaptureGrantView, stream: MediaStream): Promise<void>;
  finish(): Promise<void>;
  cancel(): void;
}

export type BrowserCaptureTerminal =
  | "CAPTURE_STOPPED"
  | "CONSENT_REQUIRED"
  | "GRANT_EXPIRED"
  | "GRANT_REVOKED"
  | "MICROPHONE_DENIED"
  | "UNSUPPORTED_CODEC";

export class BrowserCaptureError extends Error {
  constructor(readonly code: BrowserCaptureTerminal) {
    super(code);
    this.name = "BrowserCaptureError";
  }
}

export class BrowserCaptureController {
  #active: Readonly<{ grant: CaptureGrantView; stream: MediaStream }> | undefined;

  constructor(
    readonly mediaDevices: Pick<MediaDevices, "getUserMedia">,
    readonly uploader: CaptureUploader,
    readonly now: () => number = Date.now,
    readonly isTypeSupported: (mimeType: string) => boolean = (mimeType) =>
      MediaRecorder.isTypeSupported(mimeType),
  ) {}

  async start(
    requestGrant: (() => Promise<CaptureGrantView>) | undefined,
  ): Promise<CaptureGrantView> {
    if (requestGrant === undefined) throw new BrowserCaptureError("CONSENT_REQUIRED");
    if (this.#active !== undefined) throw new BrowserCaptureError("CONSENT_REQUIRED");
    if (!this.isTypeSupported(WEBM_OPUS_MIME_TYPE)) {
      throw new BrowserCaptureError("UNSUPPORTED_CODEC");
    }

    let stream: MediaStream;
    try {
      stream = await this.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "NotAllowedError") {
        throw new BrowserCaptureError("MICROPHONE_DENIED");
      }
      throw caught;
    }

    try {
      const grant = await requestGrant();
      if (this.now() >= grant.expiresAtMs) throw new BrowserCaptureError("GRANT_EXPIRED");
      await this.uploader.start(grant, stream);
      this.#active = { grant, stream };
      return grant;
    } catch (caught) {
      stopTracks(stream);
      throw caught;
    }
  }

  async stop(): Promise<BrowserCaptureTerminal> {
    const active = this.#active;
    if (active === undefined) return "CAPTURE_STOPPED";
    this.#active = undefined;
    try {
      await this.uploader.finish();
    } finally {
      stopTracks(active.stream);
    }
    return "CAPTURE_STOPPED";
  }

  revoke(grantId: string): BrowserCaptureTerminal {
    const active = this.#active;
    if (active === undefined || active.grant.captureGrantId !== grantId) return "GRANT_REVOKED";
    this.#cancelActive(active);
    return "GRANT_REVOKED";
  }

  dispose(): void {
    const active = this.#active;
    if (active !== undefined) this.#cancelActive(active);
  }

  #cancelActive(active: Readonly<{ grant: CaptureGrantView; stream: MediaStream }>): void {
    this.#active = undefined;
    try {
      this.uploader.cancel();
    } finally {
      stopTracks(active.stream);
    }
  }
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}
