import { afterEach, describe, expect, test } from "bun:test";
import { registerDom } from "@impromptu/test-harness";

registerDom();

const { createCorrelationId, createDebugLogger, installGlobalErrorCapture } = await import(
  "./debug-log"
);

interface FakeConsoleCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

function fakeConsole() {
  const calls: FakeConsoleCall[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };
  return {
    calls,
    sink: {
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    },
  };
}

afterEach(() => {});

describe("debug logger core", () => {
  test("records level, source, message, monotonic seq, and ISO timestamp", () => {
    const logger = createDebugLogger({ forwardToConsole: false });
    logger.debug("state", "first");
    logger.info("network", "second");
    logger.warn("upload", "third");
    logger.error("ai", "fourth");
    const entries = logger.entries();
    expect(entries.length).toBe(4);
    expect(entries.map((entry) => entry.level)).toEqual(["DEBUG", "INFO", "WARN", "ERROR"]);
    expect(entries.map((entry) => entry.source)).toEqual(["state", "network", "upload", "ai"]);
    const seqs = entries.map((entry) => entry.seq);
    expect(seqs[0]).toBeGreaterThan(0);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBe((seqs[i - 1] ?? 0) + 1);
    }
    for (const entry of entries) {
      expect(Number.isNaN(Date.parse(entry.timestamp))).toBe(false);
      new Date(entry.timestamp).toISOString();
    }
  });

  test("keeps sequence numbers strictly increasing across logger instances", () => {
    const a = createDebugLogger({ forwardToConsole: false });
    a.info("state", "a1");
    const b = createDebugLogger({ forwardToConsole: false });
    b.info("state", "b1");
    a.info("state", "a2");
    const a1 = a.entries()[0]?.seq ?? 0;
    const b1 = b.entries()[0]?.seq ?? 0;
    const a2 = a.entries()[1]?.seq ?? 0;
    expect(a2).toBeGreaterThan(b1);
    expect(b1).toBeGreaterThan(a1);
  });

  test("carries structured detail and correlation id on the entry", () => {
    const logger = createDebugLogger({ forwardToConsole: false });
    const correlationId = createCorrelationId();
    logger.info("network", "request.sent", {
      correlationId,
      detail: { method: "POST", path: "/v1/session" },
    });
    const entry = logger.entries()[0];
    expect(entry?.correlationId).toBe(correlationId);
    expect(entry?.detail).toEqual({ method: "POST", path: "/v1/session" });
    expect(entry?.durationMs).toBeNull();
    expect(entry?.outcome).toBeNull();
  });

  test("ring buffer caps stored entries and drops oldest first", () => {
    const logger = createDebugLogger({ capacity: 3, forwardToConsole: false });
    for (const message of ["one", "two", "three", "four", "five"]) {
      logger.info("state", message);
    }
    const entries = logger.entries();
    expect(entries.length).toBe(3);
    expect(entries.map((entry) => entry.message)).toEqual(["three", "four", "five"]);
  });
});

describe("secret redaction", () => {
  test("redacts secret keys by name in stored entries at any depth", () => {
    const logger = createDebugLogger({ forwardToConsole: false });
    logger.info("network", "request", {
      detail: {
        csrfToken: "s3cr3t",
        CSRF_HEADER: "s3cr3t",
        password: "hunter2",
        Authorization: "Bearer abc",
        headers: { cookie: "session=abc", "x-csrf-token": "t", contentType: "application/json" },
        sessionCookie: "sid=1",
        apiKey: "k-123",
        accessToken: "at",
        keepMe: "visible",
      },
    });
    const detail = logger.entries()[0]?.detail;
    expect(detail?.csrfToken).toBe("[redacted]");
    expect(detail?.CSRF_HEADER).toBe("[redacted]");
    expect(detail?.password).toBe("[redacted]");
    expect(detail?.Authorization).toBe("[redacted]");
    const headers = detail?.headers as Readonly<Record<string, unknown>>;
    expect(headers.cookie).toBe("[redacted]");
    expect(headers["x-csrf-token"]).toBe("[redacted]");
    expect(headers.contentType).toBe("application/json");
    expect(detail?.sessionCookie).toBe("[redacted]");
    expect(detail?.apiKey).toBe("[redacted]");
    expect(detail?.accessToken).toBe("[redacted]");
    expect(detail?.keepMe).toBe("visible");
  });

  test("forwards sanitized entries to the injected console in development only when enabled", () => {
    const dev = fakeConsole();
    const logger = createDebugLogger({
      forwardToConsole: true,
      consoleSink: dev.sink,
    });
    logger.warn("upload", "chunk.retry", { detail: { password: "nope", attempt: 2 } });
    expect(dev.calls.length).toBe(1);
    const call = dev.calls[0];
    expect(call?.method).toBe("warn");
    const flattened = JSON.stringify(call?.args ?? []);
    expect(flattened).toContain("chunk.retry");
    expect(flattened).toContain("attempt");
    expect(flattened).not.toContain("nope");

    const prod = fakeConsole();
    const silent = createDebugLogger({
      forwardToConsole: false,
      consoleSink: prod.sink,
    });
    silent.error("render", "silent");
    expect(prod.calls.length).toBe(0);
  });
});

describe("global error capture", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  test("captures uncaught errors as ERROR entries", () => {
    const logger = createDebugLogger({ forwardToConsole: false });
    cleanups.push(installGlobalErrorCapture(logger));
    window.dispatchEvent(
      new ErrorEvent("error", { message: "boom", error: new Error("boom"), cancelable: true }),
    );
    const entry = logger.entries().at(-1);
    expect(entry?.level).toBe("ERROR");
    expect(entry?.message).toContain("boom");
  });

  test("captures unhandled promise rejections as ERROR entries", () => {
    const logger = createDebugLogger({ forwardToConsole: false });
    cleanups.push(installGlobalErrorCapture(logger));
    window.dispatchEvent(
      Object.assign(new Event("unhandledrejection"), { reason: new Error("async-broke") }),
    );
    const entry = logger.entries().at(-1);
    expect(entry?.level).toBe("ERROR");
    expect(entry?.message).toContain("async-broke");
  });

  test("installing twice for the same logger does not duplicate entries", () => {
    const logger = createDebugLogger({ forwardToConsole: false });
    const removeFirst = installGlobalErrorCapture(logger);
    cleanups.push(removeFirst);
    const removeSecond = installGlobalErrorCapture(logger);
    removeSecond();
    window.dispatchEvent(new ErrorEvent("error", { message: "once-only", cancelable: true }));
    const errorEntries = logger.entries().filter((entry) => entry.message === "once-only");
    expect(errorEntries.length).toBe(1);
  });
});

describe("timed async helper", () => {
  test("records start and success with duration and outcome", async () => {
    const logger = createDebugLogger({ forwardToConsole: false });
    let ticks = 0;
    const clocked = createDebugLogger({
      forwardToConsole: false,
      now: () => {
        ticks += 25;
        return ticks;
      },
    });
    const correlationId = createCorrelationId();
    const result = await clocked.timed("ai", "model.request", async () => "payload", {
      correlationId,
      detail: { model: "local-router" },
    });
    expect(result).toBe("payload");
    const entries = clocked.entries();
    expect(entries.length).toBe(2);
    const start = entries[0];
    const end = entries[1];
    expect(start?.level).toBe("DEBUG");
    expect(start?.correlationId).toBe(correlationId);
    expect(start?.outcome).toBe("started");
    expect(end?.level).toBe("INFO");
    expect(end?.source).toBe("ai");
    expect(end?.correlationId).toBe(correlationId);
    expect(end?.outcome).toBe("ok");
    expect(end?.durationMs).toBe(25);
    expect(end?.detail).toEqual({ model: "local-router" });
    void logger;
  });

  test("records failure outcome and rethrows the original error", async () => {
    const clocked = createDebugLogger({
      forwardToConsole: false,
      now: () => 42_000,
    });
    const failure = new Error("model timeout");
    let caught: unknown = null;
    try {
      await clocked.timed("ai", "model.request", async () => {
        throw failure;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    const end = clocked.entries().at(-1);
    expect(end?.level).toBe("ERROR");
    expect(end?.outcome).toBe("error");
    expect(end?.message).toBe("model.request.error");
    expect(typeof end?.durationMs).toBe("number");
  });
});

describe("subscription API", () => {
  test("notifies subscribers on append and clear, stops after unsubscribe", () => {
    const logger = createDebugLogger({ forwardToConsole: false });
    let notifications = 0;
    const unsubscribe = logger.subscribe(() => {
      notifications += 1;
    });
    logger.info("state", "one");
    expect(notifications).toBe(1);
    const before = logger.entries();
    logger.info("state", "two");
    expect(logger.entries()).not.toBe(before);
    unsubscribe();
    logger.info("state", "three");
    logger.clear();
    expect(notifications).toBe(2);
    expect(logger.entries().length).toBe(0);
  });
});
