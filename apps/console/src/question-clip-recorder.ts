// Push-to-talk capture of ONE audience question on the Q&A defense surface. Mirrors the
// established BrowserCaptureController pattern (getUserMedia gate, explicit teardown, no
// always-on microphone) but is deliberately grant-free: a question clip is seconds long,
// ends on the presenter's own stop press, and leaves the microphone the moment it does.

export const QUESTION_CLIP_MIME_TYPE = "audio/webm;codecs=opus" as const;
const TIMESLICE_MS = 1_000;

export type QuestionClipStartRejection = "MICROPHONE_DENIED" | "UNSUPPORTED_CODEC" | "UNAVAILABLE";

export class QuestionClipError extends Error {
  constructor(readonly code: QuestionClipStartRejection) {
    super(code);
    this.name = "QuestionClipError";
  }
}

export interface QuestionClipRecorderMediaRecorder {
  readonly state: RecordingState;
  start(timeslice?: number): void;
  stop(): void;
  addEventListener(type: "dataavailable" | "stop", listener: EventListener): void;
  removeEventListener(type: "dataavailable" | "stop", listener: EventListener): void;
}

export interface RecordedQuestionClip {
  readonly audio: Blob;
  /** Wall-clock length of the recording, sent so the backend can bound duration honestly. */
  readonly durationMs: number;
}

export interface QuestionClipRecorderOptions {
  readonly mediaDevices: Pick<MediaDevices, "getUserMedia">;
  readonly createRecorder?: (stream: MediaStream) => QuestionClipRecorderMediaRecorder;
  readonly isTypeSupported?: (mimeType: string) => boolean;
}

interface ActiveClip {
  readonly stream: MediaStream;
  readonly recorder: QuestionClipRecorderMediaRecorder;
  readonly chunks: Blob[];
  readonly startedAtMs: number;
  readonly onDataAvailable: EventListener;
}

export class QuestionClipRecorder {
  #active: ActiveClip | undefined;

  constructor(readonly options: QuestionClipRecorderOptions) {}

  async start(): Promise<void> {
    if (this.#active !== undefined) throw new Error("A question clip is already recording");
    const isTypeSupported =
      this.options.isTypeSupported ??
      ((mimeType: string) =>
        typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mimeType));
    if (!isTypeSupported(QUESTION_CLIP_MIME_TYPE)) {
      throw new QuestionClipError("UNSUPPORTED_CODEC");
    }

    let stream: MediaStream;
    try {
      stream = await this.options.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "NotAllowedError") {
        throw new QuestionClipError("MICROPHONE_DENIED");
      }
      throw new QuestionClipError("UNAVAILABLE");
    }

    try {
      const recorder = (this.options.createRecorder ?? defaultCreateRecorder)(stream);
      const chunks: Blob[] = [];
      const onDataAvailable: EventListener = (event) => {
        const data = "data" in event ? event.data : undefined;
        if (data instanceof Blob && data.size > 0) chunks.push(data);
      };
      recorder.addEventListener("dataavailable", onDataAvailable);
      recorder.start(TIMESLICE_MS);
      this.#active = { stream, recorder, chunks, startedAtMs: Date.now(), onDataAvailable };
    } catch (caught) {
      // Never hold an open stream because recorder construction failed.
      for (const track of stream.getTracks()) track.stop();
      console.error("REC-INNER", caught);
      throw caught instanceof QuestionClipError ? caught : new QuestionClipError("UNAVAILABLE");
    }
  }

  async stop(): Promise<RecordedQuestionClip> {
    const active = this.#active;
    if (active === undefined) throw new Error("No question clip is recording");
    this.#active = undefined;
    const stopped = once(active.recorder, "stop");
    active.recorder.removeEventListener("dataavailable", active.onDataAvailable);
    active.recorder.stop();
    await stopped;
    for (const track of active.stream.getTracks()) track.stop();
    return {
      audio: new Blob(active.chunks, { type: QUESTION_CLIP_MIME_TYPE }),
      durationMs: Math.max(TIMESLICE_MS, Date.now() - active.startedAtMs),
    };
  }

  dispose(): void {
    const active = this.#active;
    if (active === undefined) return;
    this.#active = undefined;
    try {
      if (active.recorder.state !== "inactive") active.recorder.stop();
    } catch {
      // An already-dead recorder must not block track teardown below.
    }
    for (const track of active.stream.getTracks()) track.stop();
  }
}

function defaultCreateRecorder(stream: MediaStream): QuestionClipRecorderMediaRecorder {
  return new MediaRecorder(stream, { mimeType: QUESTION_CLIP_MIME_TYPE });
}

function once(
  recorder: QuestionClipRecorderMediaRecorder,
  type: "dataavailable" | "stop",
): Promise<void> {
  return new Promise((resolve) => {
    const listener = () => {
      recorder.removeEventListener(type, listener);
      resolve();
    };
    recorder.addEventListener(type, listener);
  });
}
