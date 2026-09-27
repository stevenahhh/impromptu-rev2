import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerDom } from "@impromptu/test-harness";

registerDom();

// Testing Library only registers the act environment under the suite that imports it
// first, so files sharing the happy-dom global must assert it for themselves and
// restore whatever the surrounding suite had (pattern proven in
// cockpit-audio-capture.test.tsx; without it these suites fail non-deterministically
// depending on file order).
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

const { act, cleanup, fireEvent, render, within } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");

const { AuthProvider } = await import("./auth-session");
const { messages } = await import("./i18n");
const { QaDefensePanel, QA_CLIP_ASKABLE_MS } = await import("./qa-defense-panel");
const { QaDefenseNotOpenError } = await import("./session-client");

import type { QuestionClipRecorderMediaRecorder } from "./question-clip-recorder";
import type {
  ConsoleDeckUploadClient,
  QaDefenseAnswer,
  SpokenQuestionTranscription,
} from "./session-client";

afterEach(cleanup);

const ko = messages("ko");

function baseClient(overrides: Partial<ConsoleDeckUploadClient> = {}): ConsoleDeckUploadClient {
  return {
    async signUp() {
      throw new Error("not used");
    },
    async signIn() {
      throw new Error("not used");
    },
    async readSession() {
      return null;
    },
    async signOut() {},
    async createPresentation() {
      throw new Error("not used");
    },
    async recommend() {
      throw new Error("not used");
    },
    async readLiveCandidates() {
      throw new Error("not used");
    },
    async approveLiveCandidate() {
      throw new Error("not used");
    },
    async approveDisplay() {
      throw new Error("not used");
    },
    async setSlide() {
      throw new Error("not used");
    },
    async uploadDeck() {
      throw new Error("not used");
    },
    async openQaDefense(_csrfToken, sessionId) {
      return {
        presentationSessionId: sessionId,
        presentationSessionEpoch: "pse_1",
        deckVersion: "deck_done",
        status: "ENDED",
        qaWindow: { status: "LIVE", askableUntilMs: Date.now() + 300_000 },
      };
    },
    submitQaDefenseQuestion() {
      return new Promise<QaDefenseAnswer>(() => {});
    },
    async transcribeQuestionClip() {
      throw new Error("not used");
    },
    ...overrides,
  };
}

interface MicTrackProbe {
  stopped: boolean;
  stop(): void;
}

interface FakeRecorderHandle {
  readonly state: RecordingState;
  readonly startedTimeslices: number[];
  readonly stoppedEvents: number;
}

class FakeQuestionClipRecorder extends EventTarget {
  state: RecordingState = "inactive";
  readonly startedTimeslices: number[] = [];
  stoppedEvents = 0;

  start(timeslice?: number) {
    this.state = "recording";
    this.startedTimeslices.push(timeslice ?? 0);
    const dataEvent = new Event("dataavailable");
    Object.defineProperty(dataEvent, "data", { value: new Blob([new Uint8Array([1])]) });
    this.dispatchEvent(dataEvent);
  }

  stop() {
    this.state = "inactive";
    this.stoppedEvents += 1;
    this.dispatchEvent(new Event("stop"));
  }
}

interface Seams {
  readonly tracks: MicTrackProbe[];
  readonly recorders: FakeRecorderHandle[];
  mediaDevices: Pick<MediaDevices, "getUserMedia">;
}

function seams(options: { readonly denied?: boolean } = {}): Seams {
  const probe: Seams = {
    tracks: [],
    recorders: [],
    mediaDevices: undefined as unknown as Pick<MediaDevices, "getUserMedia">,
  };
  const stream = {
    getTracks: () => probe.tracks,
  } as unknown as MediaStream;
  probe.mediaDevices = {
    async getUserMedia() {
      if (options.denied) throw new DOMException("denied", "NotAllowedError");
      return stream;
    },
  };
  return probe;
}

// Both lanes of the fixture share one MediaStream, so extra probes assert per-track teardown.
function withTracks(seam: Seams, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const track: MicTrackProbe = {
      stopped: false,
      stop() {
        this.stopped = true;
      },
    };
    seam.tracks.push(track);
  }
}

function recorderFactory(seam: Seams) {
  return (_stream: MediaStream): QuestionClipRecorderMediaRecorder => makeFakeRecorder(seam);
}

function makeFakeRecorder(seam: Seams): QuestionClipRecorderMediaRecorder {
  const handle = new FakeQuestionClipRecorder();
  seam.recorders.push(handle);
  return handle as unknown as QuestionClipRecorderMediaRecorder;
}

interface CapturedAsk {
  readonly request: {
    readonly presentationSessionId: string;
    readonly questionText: string;
    readonly origin: "TYPED" | "SPOKEN";
  };
}

/** Manual clock: `schedule` queues callbacks by delay so a test fires the exact timer it means
    to (1_000 ms expiry tick vs the ask deadline), never a wall-clock sleep. */
function manualClock(startMs: number) {
  const timers: Array<{ callback: () => void; delayMs: number }> = [];
  const state = { current: startMs };
  return {
    state,
    timers,
    clock: {
      now: () => state.current,
      schedule: (callback: () => void, delayMs: number) => {
        timers.push({ callback, delayMs });
        return () => {
          const index = timers.findIndex((timer) => timer.callback === callback);
          if (index >= 0) timers.splice(index, 1);
        };
      },
    },
    /** Fires every queued timer with the given delay once, in schedule order. */
    fire(delayMs: number) {
      for (const timer of timers.splice(0).filter((timer) => timer.delayMs === delayMs)) {
        timer.callback();
      }
    },
  };
}

async function openQa(client: ConsoleDeckUploadClient, seam?: Seams) {
  const screen = render(
    <MemoryRouter>
      <AuthProvider initialAuthenticated client={client}>
        <QaDefensePanel
          presentationSessionId="ps_spoken"
          {...(seam === undefined
            ? {}
            : {
                recorderSeams: {
                  mediaDevices: seam.mediaDevices,
                  createRecorder: recorderFactory(seam),
                  isTypeSupported: () => true,
                },
              })}
        />
      </AuthProvider>
    </MemoryRouter>,
  );
  await act(async () => {
    fireEvent.click(within(document.body).getByRole("button", { name: ko.qaOpen }));
  });
  return screen;
}

describe("spoken questions in the Q&A defense panel", () => {
  test("a pressed-and-stopped recording fills the question field and never auto-submits", async () => {
    const seam = seams();
    withTracks(seam, 1);
    const transcriptions: Array<(outcome: SpokenQuestionTranscription) => void> = [];
    const transcriptionCalls: string[] = [];
    const asks: CapturedAsk[] = [];
    let spillCount = 0;
    await openQa(
      baseClient({
        transcribeQuestionClip(_csrf, _audio, durationMs) {
          transcriptionCalls.push(String(durationMs));
          return new Promise((resolve) => {
            transcriptions.push(resolve);
          });
        },
        submitQaDefenseQuestion(_csrf, request) {
          asks.push({ request });
          spillCount += 1;
          return Promise.resolve({
            outcome: "ANSWERED",
            answer: "근거 답변",
            citations: [
              {
                kind: "DECK_SLIDE",
                evidenceId: "ev_1",
                slideOrdinal: 2,
                title: "매출",
                quote: "q",
              },
            ],
            latencyMs: 10,
            completedAtMs: 100,
            askableUntilMs: Date.now() + 300_000,
          });
        },
      }),
      seam,
    );

    const recordButton = () =>
      document.querySelector("[data-qa-record-button]") as HTMLButtonElement;

    // IDLE -> RECORDING on an explicit press; the mic seam is asked exactly once.
    expect(recordButton().getAttribute("data-qa-record-state")).toBe("IDLE");
    await act(async () => {
      fireEvent.click(recordButton());
    });
    expect(recordButton().getAttribute("data-qa-record-state")).toBe("RECORDING");

    // RECORDING -> TRANSCRIBING on the explicit stop; the transcription settles afterwards.
    await act(async () => {
      fireEvent.click(recordButton());
    });
    expect(recordButton().getAttribute("data-qa-record-state")).toBe("TRANSCRIBING");
    expect(transcriptionCalls.length).toBe(1);

    const input = document.querySelector("[data-qa-question-input]") as HTMLInputElement;
    const spokenText = "2분기 매출이 왜 하락했나요?";
    await act(async () => {
      transcriptions[0]?.({ outcome: "TRANSCRIBED", text: spokenText, askableUntilMs: null });
    });

    // The transcript lands in the editable field for review — and NOTHING was submitted.
    expect(recordButton().getAttribute("data-qa-record-state")).toBe("IDLE");
    expect(input.value).toBe(spokenText);
    expect(asks.length).toBe(0);
    expect(document.querySelector("[data-qa-answer='ANSWERED']")).toBeNull();
    expect(document.querySelector("[data-qa-abstained]")).toBeNull();

    // Only the presenter's own submit click reaches the evidence pipeline.
    await act(async () => {
      fireEvent.click(document.querySelector("[data-qa-submit]") as Element);
    });
    expect(spillCount).toBe(1);
    expect(trackStops(seam)).toBe(1);
  });

  test("a spoken question records origin SPOKEN and a typed one still records TYPED", async () => {
    const seam = seams();
    withTracks(seam, 1);
    const asks: CapturedAsk[] = [];
    const resolutions: Array<(outcome: SpokenQuestionTranscription) => void> = [];
    const client = baseClient({
      transcribeQuestionClip() {
        return new Promise<SpokenQuestionTranscription>((resolve) => {
          resolutions.push(resolve);
        });
      },
      async submitQaDefenseQuestion(_csrf, request) {
        asks.push({ request });
        return {
          outcome: "ANSWERED",
          answer: "답변",
          citations: [
            {
              kind: "DECK_SLIDE",
              evidenceId: "ev_1",
              slideOrdinal: 1,
              title: "t",
              quote: "q",
            },
          ],
          latencyMs: 10,
          completedAtMs: 100,
          askableUntilMs: Date.now() + 300_000,
        };
      },
    });
    await openQa(client, seam);
    const recordButton = () =>
      document.querySelector("[data-qa-record-button]") as HTMLButtonElement;

    // Spoken path.
    await act(async () => {
      fireEvent.click(recordButton());
    });
    await act(async () => {
      fireEvent.click(recordButton());
    });
    await act(async () => {
      resolutions[0]?.({
        outcome: "TRANSCRIBED",
        text: "음성으로 물어본 질문입니다.",
        askableUntilMs: null,
      });
    });
    await act(async () => {
      fireEvent.click(document.querySelector("[data-qa-submit]") as Element);
    });

    // Hand-editing the transcript afterwards must NOT retag it as typed: origin records how
    // the question entered, not how it was last touched.
    const input = document.querySelector("[data-qa-question-input]") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "음성으로 물어본 질문입니다. (수정)" } });
    await act(async () => {
      fireEvent.click(document.querySelector("[data-qa-submit]") as Element);
    });

    // Typed path in a fresh panel.
    cleanup();
    const asksTyped: CapturedAsk[] = [];
    await openQa(
      baseClient({
        async submitQaDefenseQuestion(_csrf, request) {
          asksTyped.push({ request });
          return {
            outcome: "ANSWERED",
            answer: "답변",
            citations: [
              {
                kind: "DECK_SLIDE",
                evidenceId: "ev_2",
                slideOrdinal: 1,
                title: "t",
                quote: "q",
              },
            ],
            latencyMs: 10,
            completedAtMs: 100,
            askableUntilMs: Date.now() + 300_000,
          };
        },
      }),
    );
    const inputTyped = document.querySelector("[data-qa-question-input]") as HTMLInputElement;
    fireEvent.change(inputTyped, { target: { value: "직접 입력한 질문입니다." } });
    await act(async () => {
      fireEvent.click(document.querySelector("[data-qa-submit]") as Element);
    });

    expect(asks.map((entry) => entry.request.origin)).toEqual(["SPOKEN", "SPOKEN"]);
    expect(asks[0]?.request.questionText).toBe("음성으로 물어본 질문입니다.");
    expect(asks[1]?.request.questionText).toBe("음성으로 물어본 질문입니다. (수정)");
    expect(asksTyped.map((entry) => entry.request.origin)).toEqual(["TYPED"]);
  });

  test("microphone permission denial shows honest locale copy and typing keeps working", async () => {
    const seam = seams({ denied: true });
    const asks: CapturedAsk[] = [];
    await openQa(
      baseClient({
        async submitQaDefenseQuestion(_csrf, request) {
          asks.push({ request });
          return {
            outcome: "ANSWERED",
            answer: "답변",
            citations: [
              {
                kind: "DECK_SLIDE",
                evidenceId: "ev_3",
                slideOrdinal: 1,
                title: "t",
                quote: "q",
              },
            ],
            latencyMs: 10,
            completedAtMs: 100,
            askableUntilMs: Date.now() + 300_000,
          };
        },
      }),
      seam,
    );
    const recordButton = () =>
      document.querySelector("[data-qa-record-button]") as HTMLButtonElement;

    await act(async () => {
      fireEvent.click(recordButton());
    });

    // Honest failure: locale copy explains it, the recorder leaves FAILED, and typing survives.
    expect(recordButton().getAttribute("data-qa-record-state")).toBe("FAILED");
    expect(recordButton().textContent).toContain(ko.qaRecordStart);
    expect(document.body.textContent).toContain(ko.qaRecordDenied);
    expect(document.body.textContent).not.toContain(ko.qaRecordFailed);

    const input = document.querySelector("[data-qa-question-input]") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "마이크 없이 타이핑한 질문" } });
    await act(async () => {
      fireEvent.click(document.querySelector("[data-qa-submit]") as Element);
    });
    expect(asks).toEqual([
      {
        request: {
          presentationSessionId: "ps_spoken",
          questionText: "마이크 없이 타이핑한 질문",
          origin: "TYPED",
        },
      },
    ]);
  });

  test("transcription failure renders its own copy and inserts no fabricated text", async () => {
    const seam = seams();
    withTracks(seam, 1);
    const resolutions: Array<(outcome: SpokenQuestionTranscription) => void> = [];
    const asks: CapturedAsk[] = [];
    await openQa(
      baseClient({
        transcribeQuestionClip() {
          return new Promise<SpokenQuestionTranscription>((resolve) => {
            resolutions.push(resolve);
          });
        },
        async submitQaDefenseQuestion(_csrf, request) {
          asks.push({ request });
          return {
            outcome: "ANSWERED",
            answer: "a",
            citations: [
              { kind: "DECK_SLIDE", evidenceId: "ev_4", slideOrdinal: 1, title: "t", quote: "q" },
            ],
            latencyMs: 5,
            completedAtMs: 50,
            askableUntilMs: Date.now() + 300_000,
          };
        },
      }),
      seam,
    );
    const recordButton = () =>
      document.querySelector("[data-qa-record-button]") as HTMLButtonElement;

    // Pre-existing draft: rejection must leave it intact rather than overwriting it.
    const input = document.querySelector("[data-qa-question-input]") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "미리 적어둔 질문" } });
    await act(async () => {
      fireEvent.click(recordButton());
    });
    await act(async () => {
      fireEvent.click(recordButton());
    });
    await act(async () => {
      resolutions[0]?.({ outcome: "REJECTED", reason: "TRANSCRIPTION_FAILED" });
    });

    expect(recordButton().getAttribute("data-qa-record-state")).toBe("FAILED");
    expect(document.body.textContent).toContain(ko.qaRecordFailed);
    expect(input.value).toBe("미리 적어둔 질문");
    expect(trackStops(seam)).toBe(1);
    expect(asks.length).toBe(0);
  });

  test("unmounting while recording stops every MediaStream track", async () => {
    const seam = seams();
    withTracks(seam, 2);
    await openQa(baseClient({}), seam);
    const recordButton = () =>
      document.querySelector("[data-qa-record-button]") as HTMLButtonElement;

    await act(async () => {
      fireEvent.click(recordButton());
    });
    expect(recordButton().getAttribute("data-qa-record-state")).toBe("RECORDING");
    expect(trackStops(seam)).toBe(0);

    cleanup();

    // Teardown is part of the feature: leaving the page mid-recording may not leave a live mic.
    expect(trackStops(seam)).toBe(2);
    expect(seam.recorders.every((recorder) => recorder.state === "inactive")).toBe(true);
  });

  test("a transcribed clip is a verbatim pending question with an honest expiry card", async () => {
    const seam = seams();
    withTracks(seam, 1);
    const rig = manualClock(1_000_000);
    const transcriptions: Array<(outcome: SpokenQuestionTranscription) => void> = [];
    render(
      <MemoryRouter>
        <AuthProvider
          initialAuthenticated
          client={baseClient({
            transcribeQuestionClip() {
              return new Promise((resolve) => {
                transcriptions.push(resolve);
              });
            },
          })}
        >
          <QaDefensePanel
            presentationSessionId="ps_spoken"
            clock={rig.clock}
            recorderSeams={{
              mediaDevices: seam.mediaDevices,
              createRecorder: recorderFactory(seam),
              isTypeSupported: () => true,
            }}
          />
        </AuthProvider>
      </MemoryRouter>,
    );
    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: ko.qaOpen }));
    });
    const recordButton = () =>
      document.querySelector("[data-qa-record-button]") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(recordButton());
    });
    await act(async () => {
      fireEvent.click(recordButton());
    });

    // Verbatim: the transcript element carries the STT text byte-for-byte — spacing included —
    // and the editable field holds the same text for review.
    const transcript = "  2분기 매출이 왜 하락했나요?  ";
    await act(async () => {
      transcriptions[0]?.({ outcome: "TRANSCRIBED", text: transcript, askableUntilMs: null });
    });

    const card = document.querySelector("[data-qa-clip-state='LIVE']");
    expect(card).toBeTruthy();
    expect(card?.querySelector("[data-qa-clip-transcript]")?.textContent).toBe(transcript);
    const input = document.querySelector("[data-qa-question-input]") as HTMLInputElement;
    expect(input.value).toBe(transcript);

    // Expiry is present and honest: without a server askableUntil the console's own bound
    // applies, so the card never pretends a deadline the wire did not carry.
    const expiry = card?.querySelector("[data-qa-clip-expiry]");
    expect(expiry).toBeTruthy();
    expect(expiry?.getAttribute("data-qa-clip-deadline")).toBe(
      String(1_000_000 + QA_CLIP_ASKABLE_MS),
    );
  });

  test("a server-provided askableUntil replaces the console expiry bound", async () => {
    const seam = seams();
    withTracks(seam, 1);
    const rig = manualClock(1_000_000);
    const transcriptions: Array<(outcome: SpokenQuestionTranscription) => void> = [];
    render(
      <MemoryRouter>
        <AuthProvider
          initialAuthenticated
          client={baseClient({
            transcribeQuestionClip() {
              return new Promise((resolve) => {
                transcriptions.push(resolve);
              });
            },
          })}
        >
          <QaDefensePanel
            presentationSessionId="ps_spoken"
            clock={rig.clock}
            recorderSeams={{
              mediaDevices: seam.mediaDevices,
              createRecorder: recorderFactory(seam),
              isTypeSupported: () => true,
            }}
          />
        </AuthProvider>
      </MemoryRouter>,
    );
    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: ko.qaOpen }));
    });
    const recordButton = () =>
      document.querySelector("[data-qa-record-button]") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(recordButton());
    });
    await act(async () => {
      fireEvent.click(recordButton());
    });
    await act(async () => {
      transcriptions[0]?.({
        outcome: "TRANSCRIBED",
        text: "서버 시한이 붙은 질문",
        askableUntilMs: 1_234_567,
      });
    });
    const expiry = document.querySelector("[data-qa-clip-expiry]");
    expect(expiry?.getAttribute("data-qa-clip-deadline")).toBe("1234567");
  });

  test("a clip that expires while pending exposes no ask action and cannot be submitted", async () => {
    const seam = seams();
    withTracks(seam, 1);
    const rig = manualClock(1_000_000);
    const transcriptions: Array<(outcome: SpokenQuestionTranscription) => void> = [];
    const asks: CapturedAsk[] = [];
    render(
      <MemoryRouter>
        <AuthProvider
          initialAuthenticated
          client={baseClient({
            transcribeQuestionClip() {
              return new Promise((resolve) => {
                transcriptions.push(resolve);
              });
            },
            submitQaDefenseQuestion(_csrf, request) {
              asks.push({ request });
              return new Promise<QaDefenseAnswer>(() => {});
            },
          })}
        >
          <QaDefensePanel
            presentationSessionId="ps_spoken"
            clock={rig.clock}
            recorderSeams={{
              mediaDevices: seam.mediaDevices,
              createRecorder: recorderFactory(seam),
              isTypeSupported: () => true,
            }}
          />
        </AuthProvider>
      </MemoryRouter>,
    );
    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: ko.qaOpen }));
    });
    const recordButton = () =>
      document.querySelector("[data-qa-record-button]") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(recordButton());
    });
    await act(async () => {
      fireEvent.click(recordButton());
    });
    await act(async () => {
      transcriptions[0]?.({
        outcome: "TRANSCRIBED",
        text: "시간 안에 못 물은 질문",
        askableUntilMs: null,
      });
    });
    expect(document.querySelector("[data-qa-clip-state]")?.getAttribute("data-qa-clip-state")).toBe(
      "LIVE",
    );

    // The presenter waits past the deadline; the next tick turns the clip honestly EXPIRED.
    rig.state.current = 1_000_000 + QA_CLIP_ASKABLE_MS;
    await act(async () => {
      rig.fire(1_000);
    });

    const card = document.querySelector("[data-qa-clip-state='EXPIRED']");
    expect(card).toBeTruthy();
    expect(card?.textContent).toContain(ko.qaClipExpired);
    expect(card?.textContent).not.toContain(ko.qaSubmit);
    // The composer ask control is bound to the expired clip's question, so it is disabled —
    // no stale transcript can reach the evidence pipeline.
    const submit = document.querySelector("[data-qa-submit]") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(submit);
    });
    expect(asks.length).toBe(0);
  });

  test("discarding a pending clip ends it and leaves no ask or discard action", async () => {
    const seam = seams();
    withTracks(seam, 1);
    const rig = manualClock(5_000);
    const transcriptions: Array<(outcome: SpokenQuestionTranscription) => void> = [];
    const asks: CapturedAsk[] = [];
    render(
      <MemoryRouter>
        <AuthProvider
          initialAuthenticated
          client={baseClient({
            transcribeQuestionClip() {
              return new Promise((resolve) => {
                transcriptions.push(resolve);
              });
            },
            submitQaDefenseQuestion(_csrf, request) {
              asks.push({ request });
              return new Promise<QaDefenseAnswer>(() => {});
            },
          })}
        >
          <QaDefensePanel
            presentationSessionId="ps_spoken"
            clock={rig.clock}
            recorderSeams={{
              mediaDevices: seam.mediaDevices,
              createRecorder: recorderFactory(seam),
              isTypeSupported: () => true,
            }}
          />
        </AuthProvider>
      </MemoryRouter>,
    );
    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: ko.qaOpen }));
    });
    const recordButton = () =>
      document.querySelector("[data-qa-record-button]") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(recordButton());
    });
    await act(async () => {
      fireEvent.click(recordButton());
    });
    await act(async () => {
      transcriptions[0]?.({
        outcome: "TRANSCRIBED",
        text: "묻지 않기로 한 질문",
        askableUntilMs: null,
      });
    });

    await act(async () => {
      fireEvent.click(document.querySelector("[data-qa-discard-clip]") as Element);
    });

    const ended = document.querySelector("[data-qa-clip-state='ENDED']");
    expect(ended).toBeTruthy();
    expect(ended?.textContent).toContain(ko.qaClipEnded);
    // An ended clip keeps its verbatim transcript but exposes no way to ask or act further.
    expect(ended?.querySelector("[data-qa-clip-transcript]")?.textContent).toBe(
      "묻지 않기로 한 질문",
    );
    expect(ended?.querySelector("[data-qa-discard-clip]")).toBeNull();
    const submit = document.querySelector("[data-qa-submit]") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const input = document.querySelector("[data-qa-question-input]") as HTMLInputElement;
    expect(input.value).toBe("");

    // A fresh typed question asks as TYPED, proving the console is not stuck on the ended clip.
    fireEvent.change(input, { target: { value: "새로 입력한 질문" } });
    await act(async () => {
      fireEvent.click(submit);
    });
    expect(asks.map((entry) => entry.request.origin)).toEqual(["TYPED"]);
    expect(asks[0]?.request.questionText).toBe("새로 입력한 질문");
  });

  test("a not-open refusal ends the pending clip honestly instead of leaving it askable", async () => {
    const seam = seams();
    withTracks(seam, 1);
    const rig = manualClock(7_000);
    const transcriptions: Array<(outcome: SpokenQuestionTranscription) => void> = [];
    render(
      <MemoryRouter>
        <AuthProvider
          initialAuthenticated
          client={baseClient({
            transcribeQuestionClip() {
              return new Promise((resolve) => {
                transcriptions.push(resolve);
              });
            },
            async submitQaDefenseQuestion() {
              throw new QaDefenseNotOpenError("qa_not_open");
            },
          })}
        >
          <QaDefensePanel
            presentationSessionId="ps_spoken"
            clock={rig.clock}
            recorderSeams={{
              mediaDevices: seam.mediaDevices,
              createRecorder: recorderFactory(seam),
              isTypeSupported: () => true,
            }}
          />
        </AuthProvider>
      </MemoryRouter>,
    );
    await act(async () => {
      fireEvent.click(within(document.body).getByRole("button", { name: ko.qaOpen }));
    });
    const recordButton = () =>
      document.querySelector("[data-qa-record-button]") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(recordButton());
    });
    await act(async () => {
      fireEvent.click(recordButton());
    });
    await act(async () => {
      transcriptions[0]?.({
        outcome: "TRANSCRIBED",
        text: "세션이 닫힌 질문",
        askableUntilMs: null,
      });
    });
    await act(async () => {
      fireEvent.click(document.querySelector("[data-qa-submit]") as Element);
    });

    expect(document.querySelector("[data-qa-clip-state='ENDED']")).toBeTruthy();
    expect(document.body.textContent).toContain(ko.qaNotOpen);
  });

  test("ko and en locale catalogs keep identical key sets", async () => {
    const koJson = (await import("./locales/ko.json")).default as Record<string, string>;
    const enJson = (await import("./locales/en.json")).default as Record<string, string>;
    expect(Object.keys(koJson).sort()).toEqual(Object.keys(enJson).sort());
  });
});

function trackStops(seam: Seams): number {
  return seam.tracks.filter((track) => track.stopped).length;
}
