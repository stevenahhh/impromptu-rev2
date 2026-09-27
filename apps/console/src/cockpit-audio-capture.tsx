import { Button } from "@impromptu/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AudioConsentNoticeView,
  BrowserCaptureController,
  BrowserCaptureError,
  type CaptureGrantView,
} from "./audio-capture";
import { useAuth } from "./auth-session";
import { messages } from "./i18n";
import { createCaptureGrantRequester, WebmOpusCaptureUploader } from "./webm-opus-capture";

export interface CockpitAudioCaptureProps {
  readonly csrfToken: string;
  readonly presentationSessionId: string;
  readonly presentationSessionEpoch: string;
  readonly actorId: string;
  readonly notice: AudioConsentNoticeView;
  readonly text: CockpitAudioCaptureText;
  readonly onServerEvent?: (event: unknown) => void;
  readonly baseUrl?: string;
}

export interface CockpitAudioCaptureText {
  readonly capturing: string;
  readonly denied: string;
  readonly unavailable: string;
}

type CaptureState = "STARTING" | "CAPTURING" | "MICROPHONE_DENIED" | "UNAVAILABLE";

/**
 * The browser's own microphone prompt is the consent gate. Asking a second time inside the app
 * only delayed the same decision, so capture starts as soon as the session exists and a refusal
 * simply leaves it off - the grant is requested after the microphone is answered, never before,
 * so a refusal reaches no network at all.
 */
export function CockpitAudioCapture({
  actorId,
  baseUrl,
  csrfToken,
  notice,
  onServerEvent,
  presentationSessionEpoch,
  presentationSessionId,
  text,
}: CockpitAudioCaptureProps) {
  const [state, setState] = useState<CaptureState>("STARTING");
  const { locale } = useAuth();
  const identity = `${presentationSessionId}:${presentationSessionEpoch}`;
  // A capture grant belongs to the session rather than to one effect run. React re-runs effects
  // on remount, and issuing a second grant retires the first one server-side, which leaves the
  // stream that is actually recording without an accepted grant.
  const startedFor = useRef<string | null>(null);
  const controller = useRef<BrowserCaptureController | null>(null);

  // One start path for both the automatic first attempt and a presenter retry. A retry runs
  // inside a click handler, which is a user gesture, so the browser may present its microphone
  // prompt again instead of silently re-refusing.
  const startCapture = useCallback(() => {
    const uploader = new WebmOpusCaptureUploader({
      csrfToken,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(onServerEvent === undefined ? {} : { onServerEvent }),
    });
    const capture = new BrowserCaptureController(navigator.mediaDevices, uploader);
    controller.current = capture;
    const captureDeviceId = `device_${crypto.randomUUID()}`;
    const consentRecordId = `consent_${crypto.randomUUID()}`;
    const requestGrant = (): Promise<CaptureGrantView> =>
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

    setState("STARTING");
    void capture
      .start(requestGrant)
      .then(() => setState("CAPTURING"))
      .catch((caught: unknown) => {
        setState(
          caught instanceof BrowserCaptureError && caught.code === "MICROPHONE_DENIED"
            ? "MICROPHONE_DENIED"
            : "UNAVAILABLE",
        );
      });
  }, [
    actorId,
    baseUrl,
    csrfToken,
    notice,
    onServerEvent,
    presentationSessionEpoch,
    presentationSessionId,
  ]);

  useEffect(() => {
    if (startedFor.current === identity) return;
    startedFor.current = identity;
    startCapture();
  }, [identity, startCapture]);

  // Releasing the microphone belongs to leaving the surface, never to a re-run of the effect
  // above, which would revoke a grant the live stream is still using.
  useEffect(() => () => controller.current?.dispose(), []);

  // A refused or dead microphone is the presenter's problem to fix, so it earns the attention
  // modifier and a quiet retry; neutral progress never asks for a click.
  const failure = state === "MICROPHONE_DENIED" || state === "UNAVAILABLE";
  return (
    <p
      className={
        failure ? "console-status-line console-status-line--attention" : "console-status-line"
      }
      aria-live="polite"
      data-capture-status={state}
    >
      {state === "CAPTURING"
        ? text.capturing
        : state === "MICROPHONE_DENIED"
          ? text.denied
          : state === "UNAVAILABLE"
            ? text.unavailable
            : ""}
      {failure ? (
        <Button type="button" variant="quiet" data-capture-retry onClick={startCapture}>
          {messages(locale).captureRetry}
        </Button>
      ) : null}
    </p>
  );
}
