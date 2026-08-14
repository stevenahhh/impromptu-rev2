import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ModelRouterError } from "./errors.ts";
import { type ModelInvocationContext, providerTransportRequestSchema } from "./ports.ts";
import type { SttAudioChunk, SttStreamEvent } from "./stt.ts";

export const isolatedAdapterModuleSchema = z
  .object({
    modulePath: z.string().refine((value) => isAbsolute(value) && value.endsWith(".mjs"), {
      message: "modulePath must be an absolute .mjs file path",
    }),
    exportName: z.string().min(1),
    allowedReadPaths: z
      .array(z.string().refine((value) => isAbsolute(value), "read paths must be absolute"))
      .default([]),
  })
  .strict();
export type IsolatedAdapterModule = z.infer<typeof isolatedAdapterModuleSchema>;

export interface AdapterIsolate {
  invoke(
    module: IsolatedAdapterModule,
    input: unknown,
    context: ModelInvocationContext,
  ): Promise<unknown>;
  streamStt(
    module: IsolatedAdapterModule,
    chunks: AsyncIterable<SttAudioChunk>,
    context: ModelInvocationContext,
  ): AsyncIterable<SttStreamEvent>;
}

interface RpcRecord {
  readonly [key: string]: unknown;
}

interface TransportRpcMessage {
  readonly type: "transport";
  readonly id: number;
  readonly request: unknown;
}

interface ResultRpcMessage {
  readonly type: "result";
  readonly output: unknown;
}

interface EventRpcMessage {
  readonly type: "event";
  readonly event: unknown;
}

interface CompleteRpcMessage {
  readonly type: "complete";
}

interface ErrorRpcMessage {
  readonly type: "error";
  readonly message: string;
}

type ChildRpcMessage =
  | CompleteRpcMessage
  | ErrorRpcMessage
  | EventRpcMessage
  | ResultRpcMessage
  | TransportRpcMessage;

export interface NodePermissionAdapterIsolateOptions {
  readonly nodeExecutable?: string;
  readonly runnerPath?: string;
}

export class NodePermissionAdapterIsolate implements AdapterIsolate {
  readonly #nodeExecutable: string;
  readonly #runnerPath: string;
  #activeIsolates = 0;

  constructor(options: NodePermissionAdapterIsolateOptions = {}) {
    this.#nodeExecutable = options.nodeExecutable ?? "node";
    this.#runnerPath =
      options.runnerPath ?? fileURLToPath(new URL("./isolate-runner.mjs", import.meta.url));
  }

  get activeIsolates(): number {
    return this.#activeIsolates;
  }

  async invoke(
    untrustedModule: IsolatedAdapterModule,
    input: unknown,
    context: ModelInvocationContext,
  ): Promise<unknown> {
    const module = isolatedAdapterModuleSchema.parse(untrustedModule);
    const session = this.#spawn(module, "unary", context);
    try {
      session.send({ type: "init", input: encodeRpc(input), context: publicContext(context) });
      return await session.unaryResult;
    } finally {
      await session.close();
    }
  }

  async *streamStt(
    untrustedModule: IsolatedAdapterModule,
    chunks: AsyncIterable<SttAudioChunk>,
    context: ModelInvocationContext,
  ): AsyncIterable<SttStreamEvent> {
    const module = isolatedAdapterModuleSchema.parse(untrustedModule);
    const session = this.#spawn(module, "stream", context);
    void session.unaryResult.catch(() => undefined);
    const iterator = chunks[Symbol.asyncIterator]();
    const pump = (async () => {
      try {
        while (true) {
          const next = await iterator.next();
          if (next.done) break;
          session.send({ type: "chunk", chunk: encodeRpc(next.value) });
        }
        session.send({ type: "chunks-complete" });
      } catch (caught) {
        session.fail(caught);
      }
    })();
    session.send({ type: "init", context: publicContext(context) });
    try {
      for await (const event of session.events) yield event;
      await pump;
    } finally {
      if (iterator.return !== undefined) await iterator.return();
      await session.close();
    }
  }

  #spawn(
    module: IsolatedAdapterModule,
    mode: "stream" | "unary",
    context: ModelInvocationContext,
  ): IsolateSession {
    const readPaths = [this.#runnerPath, module.modulePath, ...module.allowedReadPaths];
    const args = [
      "--permission",
      ...readPaths.map((path) => `--allow-fs-read=${path}`),
      this.#runnerPath,
      module.modulePath,
      module.exportName,
      mode,
    ];
    const child = spawn(this.#nodeExecutable, args, {
      env: isolatedEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#activeIsolates += 1;
    return new IsolateSession(child, mode, context, () => {
      this.#activeIsolates -= 1;
    });
  }
}

class IsolateSession {
  readonly events = new AsyncEventQueue<SttStreamEvent>();
  readonly unaryResult: Promise<unknown>;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #readline: ReadlineInterface;
  readonly #mode: "stream" | "unary";
  readonly #context: ModelInvocationContext;
  readonly #onAbort: () => void;
  readonly #onClosed: () => void;
  readonly #closed: Promise<void>;
  #resolveUnary: (value: unknown) => void = () => undefined;
  #rejectUnary: (reason: unknown) => void = () => undefined;
  #result: unknown;
  #resultReceived = false;
  #settled = false;
  #closedNotified = false;

  constructor(
    child: ChildProcessWithoutNullStreams,
    mode: "stream" | "unary",
    context: ModelInvocationContext,
    onClosed: () => void,
  ) {
    this.#child = child;
    this.#mode = mode;
    this.#context = context;
    this.#onAbort = () => this.fail(context.signal.reason);
    this.#onClosed = onClosed;
    this.unaryResult = new Promise<unknown>((resolve, reject) => {
      this.#resolveUnary = resolve;
      this.#rejectUnary = reject;
    });
    this.#readline = createInterface({ input: child.stdout });
    this.#readline.on("line", (line) => this.#onLine(line));
    child.stderr.resume();
    child.on("error", (error) => this.fail(error));
    this.#closed = new Promise<void>((resolve) => {
      child.once("close", (code) => {
        this.#notifyClosed();
        if (!this.#settled) {
          if (code !== 0) {
            this.fail(new Error(`Adapter isolate exited with code ${code ?? "unknown"}`));
          } else if (this.#mode === "unary" && this.#resultReceived) {
            this.#settled = true;
            this.#resolveUnary(this.#result);
          } else if (this.#mode === "unary") {
            this.fail(new Error("Adapter isolate exited without one result"));
          } else {
            this.#settled = true;
            this.events.end();
          }
        }
        resolve();
      });
    });
    context.signal.addEventListener("abort", this.#onAbort, { once: true });
  }

  send(message: RpcRecord): void {
    if (this.#settled || this.#child.stdin.destroyed) return;
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  fail(caught: unknown): void {
    if (this.#settled) return;
    this.#settled = true;
    const error =
      caught instanceof ModelRouterError
        ? caught
        : new ModelRouterError("provider_error", "Isolated model adapter failed", true);
    this.#rejectUnary(error);
    this.events.fail(error);
    this.#child.kill();
  }

  async close(): Promise<void> {
    if (!this.#child.killed && this.#child.exitCode === null) {
      this.#child.stdin.end();
      this.#child.kill();
    }
    await this.#closed;
    this.#readline.close();
  }

  #onLine(line: string): void {
    let message: ChildRpcMessage;
    try {
      message = parseChildMessage(JSON.parse(line));
    } catch {
      this.fail(new Error("Invalid adapter isolate message"));
      return;
    }
    if (message.type === "transport") {
      void this.#handleTransport(message);
    } else if (message.type === "event" && this.#mode === "stream") {
      this.events.push(decodeRpc(message.event) as SttStreamEvent);
    } else if (message.type === "complete" && this.#mode === "stream") {
      this.#settled = true;
      this.events.end();
    } else if (message.type === "result" && this.#mode === "unary" && !this.#resultReceived) {
      this.#result = decodeRpc(message.output);
      this.#resultReceived = true;
    } else if (message.type === "error") {
      this.fail(new Error(message.message));
    } else {
      this.fail(new Error("Unexpected adapter isolate message"));
    }
  }

  async #handleTransport(message: TransportRpcMessage): Promise<void> {
    if (this.#context.transport === undefined) {
      this.send({ type: "transport-error", id: message.id, message: "Transport unavailable" });
      return;
    }
    try {
      const request = providerTransportRequestSchema.parse(decodeRpc(message.request));
      const response = await this.#context.transport.request(request);
      this.send({ type: "transport-result", id: message.id, response: encodeRpc(response) });
    } catch {
      this.send({ type: "transport-error", id: message.id, message: "Transport request failed" });
    }
  }

  #notifyClosed(): void {
    if (this.#closedNotified) return;
    this.#closedNotified = true;
    this.#context.signal.removeEventListener("abort", this.#onAbort);
    this.#onClosed();
  }
}

class AsyncEventQueue<Value> implements AsyncIterable<Value> {
  readonly #values: Value[] = [];
  readonly #waiters: Array<{
    readonly resolve: (result: IteratorResult<Value>) => void;
    readonly reject: (reason: unknown) => void;
  }> = [];
  #ended = false;
  #error: unknown;

  [Symbol.asyncIterator](): AsyncIterator<Value> {
    return {
      next: () => this.#next(),
      return: async () => {
        this.end();
        return { done: true, value: undefined };
      },
    };
  }

  push(value: Value): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#values.push(value);
    else waiter.resolve({ done: false, value });
  }

  end(): void {
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  fail(error: unknown): void {
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  async #next(): Promise<IteratorResult<Value>> {
    const value = this.#values.shift();
    if (value !== undefined) return { done: false, value };
    if (this.#error !== undefined) throw this.#error;
    if (this.#ended) return { done: true, value: undefined };
    return await new Promise<IteratorResult<Value>>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }
}

function parseChildMessage(value: unknown): ChildRpcMessage {
  if (!isRecord(value) || typeof value.type !== "string") throw new TypeError("Invalid RPC");
  if (value.type === "transport" && Number.isInteger(value.id)) {
    return { type: "transport", id: value.id as number, request: value.request };
  }
  if (value.type === "result") return { type: "result", output: value.output };
  if (value.type === "event") return { type: "event", event: value.event };
  if (value.type === "complete") return { type: "complete" };
  if (value.type === "error" && typeof value.message === "string") {
    return { type: "error", message: value.message };
  }
  throw new TypeError("Invalid RPC");
}

function publicContext(context: ModelInvocationContext): RpcRecord {
  return {
    tenantId: context.trustedContext.tenantId,
    requestId: context.trustedContext.requestId,
    traceId: context.trustedContext.traceId,
    policyVersion: context.trustedContext.policyVersion,
  };
}

function encodeRpc(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { $bytes: Buffer.from(value).toString("base64") };
  }
  if (Array.isArray(value)) return value.map(encodeRpc);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encodeRpc(entry)]));
  }
  return value;
}

function decodeRpc(value: unknown): unknown {
  if (isRecord(value) && typeof value.$bytes === "string" && Object.keys(value).length === 1) {
    return new Uint8Array(Buffer.from(value.$bytes, "base64"));
  }
  if (Array.isArray(value)) return value.map(decodeRpc);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decodeRpc(entry)]));
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isolatedEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "WINDIR"];
  return Object.fromEntries(
    allowed.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}
