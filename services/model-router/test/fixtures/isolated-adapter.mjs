import dns from "node:dns/promises";

export async function invoke(input, { configuration, transport }) {
  const fetchBlocked = typeof globalThis.fetch === "undefined";
  const webSocketBlocked = typeof globalThis.WebSocket === "undefined";
  let dnsBlocked = false;
  try {
    await dns.lookup("localhost");
  } catch (error) {
    dnsBlocked = error?.code === "ERR_ACCESS_DENIED";
  }
  const response = await transport.request({
    method: "POST",
    path: `/v1/${input.id}?model=${configuration.model}`,
  });
  if (input.pending === true) await new Promise(() => undefined);
  return {
    id: input.id,
    fetchBlocked,
    webSocketBlocked,
    dnsBlocked,
    status: response.status,
  };
}

export function exitWithoutResult() {
  process.exit(0);
}

export function emitDuplicateResults() {
  process.stdout.write(`${JSON.stringify({ type: "result", output: { duplicate: 1 } })}\n`);
  return { duplicate: 2 };
}

export async function* transcribe(chunks) {
  let sequence = 0;
  for await (const chunk of chunks) {
    yield {
      kind: chunk.sequence === 0 ? "partial" : "final",
      sequence,
      transcript: {
        text: `chunk-${chunk.sequence}`,
        language: "ko",
        durationMs: chunk.sequence * 100,
      },
    };
    sequence += 1;
  }
}
