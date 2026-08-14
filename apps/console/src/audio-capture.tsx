import { Button, Panel } from "@impromptu/ui";
import { useState } from "react";

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
  | "GRANT_REVOKED";

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
  ) {}

  async start(grant: CaptureGrantView | undefined): Promise<void> {
    if (grant === undefined) throw new BrowserCaptureError("CONSENT_REQUIRED");
    if (this.now() >= grant.expiresAtMs) throw new BrowserCaptureError("GRANT_EXPIRED");
    if (this.#active !== undefined) throw new BrowserCaptureError("CONSENT_REQUIRED");

    const stream = await this.mediaDevices.getUserMedia({ audio: true, video: false });
    try {
      await this.uploader.start(grant, stream);
      this.#active = { grant, stream };
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
    this.#active = undefined;
    try {
      this.uploader.cancel();
    } finally {
      stopTracks(active.stream);
    }
    return "GRANT_REVOKED";
  }
}

export interface AudioConsentControlProps {
  readonly controller?: BrowserCaptureController;
  readonly notice: AudioConsentNoticeView;
  readonly requestGrant?: () => Promise<CaptureGrantView>;
}

export function AudioConsentControl({
  controller,
  notice,
  requestGrant,
}: AudioConsentControlProps) {
  const [accepted, setAccepted] = useState(false);
  const [grant, setGrant] = useState<CaptureGrantView>();
  const [status, setStatus] = useState(
    requestGrant === undefined ? "Create a presentation session before enabling capture." : "Off",
  );
  const [pending, setPending] = useState(false);

  async function start() {
    if (!accepted || controller === undefined || requestGrant === undefined) return;
    setPending(true);
    try {
      const issued = await requestGrant();
      await controller.start(issued);
      setGrant(issued);
      setStatus("Capturing with a short-lived session grant.");
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : "Capture could not start.");
    } finally {
      setPending(false);
    }
  }

  function revoke() {
    if (grant !== undefined) controller?.revoke(grant.captureGrantId);
    setGrant(undefined);
    setAccepted(false);
    setStatus("Consent revoked. Capture stopped.");
  }

  return (
    <Panel title="Microphone consent" tone="inset">
      <dl className="console-consent-notice">
        <div>
          <dt>Purpose</dt>
          <dd>{notice.purpose}</dd>
        </div>
        <div>
          <dt>Service</dt>
          <dd>{notice.vendors.join(", ")}</dd>
        </div>
        <div>
          <dt>Region</dt>
          <dd>{notice.region}</dd>
        </div>
        <div>
          <dt>Retention</dt>
          <dd>{notice.retention}</dd>
        </div>
        <div>
          <dt>Deletion</dt>
          <dd>{notice.deletion}</dd>
        </div>
      </dl>
      <label className="console-consent-check">
        <input
          type="checkbox"
          checked={accepted}
          disabled={grant !== undefined}
          onChange={(event) => setAccepted(event.currentTarget.checked)}
        />
        I consent to microphone capture for the stated purpose.
      </label>
      {grant === undefined ? (
        <Button
          disabled={!accepted || pending || controller === undefined || requestGrant === undefined}
          onClick={() => void start()}
        >
          {pending ? "Starting..." : "Start microphone"}
        </Button>
      ) : (
        <Button variant="quiet" onClick={revoke}>
          Revoke consent
        </Button>
      )}
      <p className="console-caption" aria-live="polite">
        {status}
      </p>
    </Panel>
  );
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}
