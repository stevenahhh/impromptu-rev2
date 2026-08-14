import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

for (const name of ["fetch", "WebSocket", "EventSource", "XMLHttpRequest"]) {
  Object.defineProperty(globalThis, name, {
    value: undefined,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

const [modulePath, exportName, mode] = process.argv.slice(2);
if (
  modulePath === undefined ||
  exportName === undefined ||
  (mode !== "unary" && mode !== "stream")
) {
  throw new Error("Invalid isolate arguments");
}

const pendingTransport = new Map();
let chunks;
let nextTransportId = 1;
let initialized = false;

const transport = Object.freeze({
  request(request) {
    const id = nextTransportId;
    nextTransportId += 1;
    send({ type: "transport", id, request: encodeRpc(request) });
    return new Promise((resolve, reject) => pendingTransport.set(id, { resolve, reject }));
  },
});

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  void receive(line);
});

async function receive(line) {
  const message = JSON.parse(line);
  if (message.type === "transport-result") {
    const pending = pendingTransport.get(message.id);
    pendingTransport.delete(message.id);
    pending?.resolve(decodeRpc(message.response));
    return;
  }
  if (message.type === "transport-error") {
    const pending = pendingTransport.get(message.id);
    pendingTransport.delete(message.id);
    pending?.reject(new Error("Parent transport rejected request"));
    return;
  }
  if (message.type === "chunk") {
    chunks.push(decodeRpc(message.chunk));
    return;
  }
  if (message.type === "chunks-complete") {
    chunks.end();
    return;
  }
  if (message.type !== "init" || initialized) return;
  initialized = true;
  try {
    const adapterModule = await import(pathToFileURL(modulePath).href);
    const adapter = adapterModule[exportName];
    if (typeof adapter !== "function") throw new Error("Adapter export must be a function");
    const api = Object.freeze({
      context: Object.freeze(message.context ?? {}),
      transport,
    });
    if (mode === "unary") {
      const output = await adapter(decodeRpc(message.input), api);
      send({ type: "result", output: encodeRpc(output) });
    } else {
      for await (const event of adapter(chunks, api)) {
        send({ type: "event", event: encodeRpc(event) });
      }
      send({ type: "complete" });
    }
  } catch {
    send({ type: "error", message: "Adapter execution failed" });
    process.exitCode = 1;
  } finally {
    lines.close();
  }
}

class AsyncQueue {
  #values = [];
  #waiters = [];
  #ended = false;

  [Symbol.asyncIterator]() {
    return { next: () => this.#next() };
  }

  push(value) {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#values.push(value);
    else waiter({ done: false, value });
  }

  end() {
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  async #next() {
    const value = this.#values.shift();
    if (value !== undefined) return { done: false, value };
    if (this.#ended) return { done: true, value: undefined };
    return await new Promise((resolve) => this.#waiters.push(resolve));
  }
}

chunks = new AsyncQueue();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function encodeRpc(value) {
  if (value instanceof Uint8Array) {
    return { $bytes: Buffer.from(value).toString("base64") };
  }
  if (Array.isArray(value)) return value.map(encodeRpc);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encodeRpc(entry)]));
  }
  return value;
}

function decodeRpc(value) {
  if (isRecord(value) && typeof value.$bytes === "string" && Object.keys(value).length === 1) {
    return new Uint8Array(Buffer.from(value.$bytes, "base64"));
  }
  if (Array.isArray(value)) return value.map(decodeRpc);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decodeRpc(entry)]));
  }
  return value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
