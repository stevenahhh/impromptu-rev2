import { describe, expect, test } from "bun:test";
import {
  SttStreamEventSchema as ContractSttStreamEventSchema,
  STT_AUDIO_MIME_TYPE,
  STT_STREAM_EVENT_KINDS,
} from "@impromptu/contracts/private";
import {
  audioEncodingSchema,
  createSttStreamEventValidator,
  SttStreamProtocolError,
  type SttStreamProtocolErrorCode,
  sttStreamEventSchema,
} from "../src/stt.ts";

const fixtureUrl = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

describe("frozen STT streaming envelope", () => {
  test("uses the private contract schema as the model-router machine-value source", () => {
    expect(STT_AUDIO_MIME_TYPE).toBe("audio/webm;codecs=opus");
    expect(audioEncodingSchema.parse(STT_AUDIO_MIME_TYPE)).toBe(STT_AUDIO_MIME_TYPE);
    expect(audioEncodingSchema.safeParse("audio/ogg;codecs=opus").success).toBe(false);
    expect(STT_STREAM_EVENT_KINDS).toEqual(["PARTIAL", "REPLACE", "FINAL", "ABORT"]);
    expect(sttStreamEventSchema).toBe(ContractSttStreamEventSchema);
    expect(sttStreamEventSchema.safeParse({ kind: "partial" }).success).toBe(false);
  });

  test("accepts the PARTIAL to REPLACE to FINAL fixture in sequence", async () => {
    const fixture = (await Bun.file(fixtureUrl("partial-before-final.json")).json()) as {
      events: unknown[];
    };
    const validate = createSttStreamEventValidator();

    expect(fixture.events.map((event) => validate(event).kind)).toEqual([
      "PARTIAL",
      "REPLACE",
      "FINAL",
    ]);
  });

  test("rejects late delivery, duplicate FINAL, and post-FINAL events with stable codes", async () => {
    const fixture = (await Bun.file(
      fixtureUrl("revoke-stops-and-blocks-late-delivery.json"),
    ).json()) as {
      scenarios: Array<{
        accepted: unknown[];
        rejected: unknown;
        expectedCode: SttStreamProtocolErrorCode;
      }>;
    };

    for (const scenario of fixture.scenarios) {
      const validate = createSttStreamEventValidator();
      for (const event of scenario.accepted) validate(event);
      try {
        validate(scenario.rejected);
        throw new Error("expected frozen STT sequence rejection");
      } catch (caught) {
        expect(caught).toBeInstanceOf(SttStreamProtocolError);
        expect((caught as SttStreamProtocolError).code).toBe(scenario.expectedCode);
      }
    }
  });

  test("requires REPLACE to target an earlier event from the same segment", () => {
    const validate = createSttStreamEventValidator();
    validate({
      kind: "PARTIAL",
      sessionGeneration: 1,
      sequence: 0,
      segmentId: "other-segment",
      transcript: { text: "초안", language: "ko", durationMs: 10, words: [] },
    });

    expect(() =>
      validate({
        kind: "REPLACE",
        sessionGeneration: 1,
        sequence: 1,
        segmentId: "segment-1",
        replacesSequence: 0,
        transcript: { text: "수정", language: "ko", durationMs: 10, words: [] },
      }),
    ).toThrow(new SttStreamProtocolError("INVALID_REPLACE_TARGET"));
  });

  test("rejects replayed event sequence with its stable protocol code", () => {
    const validate = createSttStreamEventValidator();
    const partial = {
      kind: "PARTIAL",
      sessionGeneration: 1,
      sequence: 0,
      segmentId: "segment-sequence",
      transcript: { text: "초안", language: "ko", durationMs: 10, words: [] },
    } as const;
    validate(partial);

    expect(() => validate(partial)).toThrow(new SttStreamProtocolError("NON_MONOTONIC_SEQUENCE"));
  });

  test("accepts empty FINAL words but rejects non-monotonic word timestamps", () => {
    expect(
      sttStreamEventSchema.safeParse({
        kind: "FINAL",
        sessionGeneration: 1,
        sequence: 0,
        segmentId: "segment-1",
        finalSegmentId: "final-1",
        transcript: { text: "", language: "ko", durationMs: 0, words: [] },
      }).success,
    ).toBe(true);
    expect(
      sttStreamEventSchema.safeParse({
        kind: "PARTIAL",
        sessionGeneration: 1,
        sequence: 0,
        segmentId: "segment-1",
        transcript: {
          text: "역순",
          language: "ko",
          durationMs: 100,
          words: [
            { text: "뒤", startMs: 50, endMs: 70 },
            { text: "앞", startMs: 20, endMs: 40 },
          ],
        },
      }).success,
    ).toBe(false);
  });
});
