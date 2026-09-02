import { Button } from "@impromptu/ui";
import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import type { Messages } from "./i18n";
import type { SpokenQuestionTranscription } from "./qa-defense";
import type { QuestionClipRecorderMediaRecorder } from "./question-clip-recorder";
import { QuestionClipError, QuestionClipRecorder } from "./question-clip-recorder";

type RecordState = "IDLE" | "RECORDING" | "TRANSCRIBING" | "FAILED";
type FailureKind = "MICROPHONE_DENIED" | "UNAVAILABLE" | "TRANSCRIPTION";

export interface QuestionClipSeams {
  readonly mediaDevices?: Pick<MediaDevices, "getUserMedia">;
  readonly createRecorder?: (stream: MediaStream) => QuestionClipRecorderMediaRecorder;
  readonly isTypeSupported?: (mimeType: string) => boolean;
}

export interface SpokenQuestionControlProps {
  readonly text: Messages;
  readonly disabled?: boolean;
  readonly transcribe: (audio: Blob, durationMs: number) => Promise<SpokenQuestionTranscription>;
  readonly onTranscript: (text: string) => void;
  /** Test seams mirroring audio-capture's injected runtime; defaults use real browser APIs. */
  readonly seams?: QuestionClipSeams;
}

/**
 * Push-to-talk control for one audience question. The transcript NEVER auto-submits: room
 * Q&A acoustics plus an STT path tuned for continuous presenter speech will fragment and
 * mishear, so silently firing a misheard question at the evidence pipeline would waste the
 * presenter's time in front of an audience and pollute the audit ledger. The human reads
 * the editable transcript and confirms before it is asked.
 */
export function SpokenQuestionControl({
  disabled = false,
  onTranscript,
  seams,
  text,
  transcribe,
}: SpokenQuestionControlProps) {
  const [state, setState] = useState<RecordState>("IDLE");
  const [failure, setFailure] = useState<FailureKind | null>(null);
  const recorderRef = useRef<QuestionClipRecorder | null>(null);
  const mountedRef = useRef(true);
  // Snapshotted inside the async toggle so a pending start cannot double-fire after unmount.
  const stateRef = useRef<RecordState>("IDLE");
  stateRef.current = state;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      // Teardown IS the feature: unmount mid-recording must stop every track synchronously
      // in this cleanup, never depend on an async continuation that may never run.
      mountedRef.current = false;
      recorderRef.current?.dispose();
      recorderRef.current = null;
    };
  }, []);

  const toggle = async () => {
    if (disabled || stateRef.current === "TRANSCRIBING") return;
    if (stateRef.current === "IDLE" || stateRef.current === "FAILED") {
      setFailure(null);
      const recorder = mountedRecorder(recorderRef, seams);
      try {
        await recorder.start();
        if (!mountedRef.current) {
          recorder.dispose();
          return;
        }
        setState("RECORDING");
      } catch (caught) {
        if (!mountedRef.current) return;
        setState("FAILED");
        setFailure(
          caught instanceof QuestionClipError && caught.code === "MICROPHONE_DENIED"
            ? "MICROPHONE_DENIED"
            : "UNAVAILABLE",
        );
      }
      return;
    }

    // RECORDING -> TRANSCRIBING on the explicit stop press.
    const recorder = recorderRef.current;
    if (recorder === null) return;
    setState("TRANSCRIBING");
    try {
      const clip = await recorder.stop();
      const outcome = await transcribe(clip.audio, clip.durationMs);
      if (!mountedRef.current) return;
      if (outcome.outcome === "REJECTED" || outcome.text.trim().length === 0) {
        setState("FAILED");
        setFailure("TRANSCRIPTION");
        return;
      }
      onTranscript(outcome.text);
      setState("IDLE");
    } catch {
      if (!mountedRef.current) return;
      setState("FAILED");
      setFailure("TRANSCRIPTION");
    }
  };

  return (
    <div className="console-qa__spoken">
      <Button
        data-qa-record-button
        data-qa-record-state={state}
        disabled={disabled || state === "TRANSCRIBING"}
        onClick={() => void toggle()}
        variant={state === "RECORDING" ? "danger" : "primary"}
      >
        {state === "RECORDING"
          ? text.qaRecordStop
          : state === "TRANSCRIBING"
            ? text.qaRecordTranscribing
            : text.qaRecordStart}
      </Button>
      {failure === null ? null : (
        <output aria-live="polite" className="console-status-line console-status-line--attention">
          {failure === "MICROPHONE_DENIED"
            ? text.qaRecordDenied
            : failure === "TRANSCRIPTION"
              ? text.qaRecordFailed
              : text.qaRecordUnavailable}
        </output>
      )}
    </div>
  );
}

function mountedRecorder(
  store: RefObject<QuestionClipRecorder | null>,
  seams: QuestionClipSeams | undefined,
): QuestionClipRecorder {
  let recorder = store.current;
  if (recorder === null) {
    recorder = new QuestionClipRecorder({
      mediaDevices:
        seams?.mediaDevices ??
        (navigator.mediaDevices as unknown as Pick<MediaDevices, "getUserMedia">),
      ...(seams?.createRecorder === undefined ? {} : { createRecorder: seams.createRecorder }),
      ...(seams?.isTypeSupported === undefined ? {} : { isTypeSupported: seams.isTypeSupported }),
    });
    store.current = recorder;
  }
  return recorder;
}
