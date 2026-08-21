import { useEffect, useState } from "react";
import {
  AudioConsentControl,
  type AudioConsentNoticeView,
  BrowserCaptureController,
  type CaptureGrantView,
} from "./audio-capture";
import { createCaptureGrantRequester, WebmOpusCaptureUploader } from "./webm-opus-capture";

export interface CockpitAudioCaptureProps {
  readonly csrfToken: string;
  readonly presentationSessionId: string;
  readonly presentationSessionEpoch: string;
  readonly actorId: string;
  readonly notice: AudioConsentNoticeView;
  readonly baseUrl?: string;
}

type CaptureRuntime = Readonly<{
  controller: BrowserCaptureController;
  requestGrant: () => Promise<CaptureGrantView>;
}>;

export function CockpitAudioCapture({
  actorId,
  baseUrl,
  csrfToken,
  notice,
  presentationSessionEpoch,
  presentationSessionId,
}: CockpitAudioCaptureProps) {
  const [runtime, setRuntime] = useState<CaptureRuntime>();

  useEffect(() => {
    const uploader = new WebmOpusCaptureUploader({
      csrfToken,
      ...(baseUrl === undefined ? {} : { baseUrl }),
    });
    const controller = new BrowserCaptureController(navigator.mediaDevices, uploader);
    const captureDeviceId = `device_${crypto.randomUUID()}`;
    const consentRecordId = `consent_${crypto.randomUUID()}`;
    const requestGrant = () =>
      createCaptureGrantRequester({
        csrfToken,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        input: {
          presentationSessionId,
          presentationSessionEpoch,
          actorId,
          captureDeviceId,
          consentRecordId,
          notice,
          acceptedAtMs: Date.now(),
        },
      })();
    setRuntime({ controller, requestGrant });
    return () => controller.dispose();
  }, [actorId, baseUrl, csrfToken, notice, presentationSessionEpoch, presentationSessionId]);

  return (
    <AudioConsentControl
      notice={notice}
      {...(runtime === undefined
        ? {}
        : { controller: runtime.controller, requestGrant: runtime.requestGrant })}
    />
  );
}
