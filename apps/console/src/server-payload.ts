export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function coachingEventFromServer(input: unknown, sessionOffsetMs: number): unknown {
  const envelope = record(input);
  if (envelope?.kind !== "TRANSCRIPT") return null;
  const event = record(envelope.event);
  if (event === null) return null;
  const base = {
    sessionGeneration: event.sessionGeneration,
    sequence: event.sequence,
    segmentId: event.segmentId,
  };
  const transcript = record(event.transcript);
  if (event.kind === "PARTIAL") {
    return { ...base, kind: "PARTIAL", preview: transcript?.text };
  }
  if (event.kind === "REPLACE") {
    return {
      ...base,
      kind: "REPLACE",
      replacesSequence: event.replacesSequence,
      preview: transcript?.text,
    };
  }
  if (event.kind !== "FINAL" || transcript === null || !Array.isArray(transcript.words)) {
    return null;
  }
  const durationMs = transcript.durationMs;
  if (typeof durationMs !== "number") return null;
  return {
    ...base,
    kind: "FINAL",
    finalSegmentId: event.finalSegmentId,
    finalizedAtSessionMs: sessionOffsetMs + durationMs,
    words: transcript.words.map((value) => {
      const word = record(value);
      return {
        text: word?.text,
        startSessionMs:
          typeof word?.startMs === "number" ? sessionOffsetMs + word.startMs : word?.startMs,
        endSessionMs: typeof word?.endMs === "number" ? sessionOffsetMs + word.endMs : word?.endMs,
      };
    }),
  };
}
