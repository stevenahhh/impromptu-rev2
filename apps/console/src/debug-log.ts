/**
 * Structured debug logging core for the Console.
 *
 * Self-contained module: no imports outside this file. Entries are kept in a
 * bounded ring buffer, carry a monotonic sequence number plus optional
 * correlation id, and never retain secret values (redacted by key name).
 */

export type DebugLogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export type DebugLogSource = "network" | "ai" | "state" | "upload" | "realtime" | "render";

export type DebugLogOutcome = "started" | "ok" | "error";

export interface DebugLogEntry {
  readonly seq: number;
  readonly level: DebugLogLevel;
  readonly source: DebugLogSource;
  readonly timestamp: string;
  readonly message: string;
  readonly correlationId: string | null;
  readonly detail: Readonly<Record<string, unknown>> | null;
  readonly durationMs: number | null;
  readonly outcome: DebugLogOutcome | null;
}

export interface DebugLogOptions {
  readonly correlationId?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface ConsoleLike {
  debug: (...data: unknown[]) => void;
  info: (...data: unknown[]) => void;
  warn: (...data: unknown[]) => void;
  error: (...data: unknown[]) => void;
}

export interface DebugLoggerOptions {
  /** Maximum number of retained entries; oldest are dropped first. */
  readonly capacity?: number;
  /** Forward entries to the browser console. Defaults to true outside production. */
  readonly forwardToConsole?: boolean;
  /** Console sink used when forwarding; defaults to globalThis.console. */
  readonly consoleSink?: ConsoleLike;
  /** Monotonic-ish clock in milliseconds; defaults to Date.now. Test seam. */
  readonly now?: () => number;
}

export interface DebugLogger {
  debug(source: DebugLogSource, message: string, options?: DebugLogOptions): void;
  info(source: DebugLogSource, message: string, options?: DebugLogOptions): void;
  warn(source: DebugLogSource, message: string, options?: DebugLogOptions): void;
  error(source: DebugLogSource, message: string, options?: DebugLogOptions): void;
  /**
   * Times an async call: emits a DEBUG "started" entry with a fresh or supplied
   * correlation id, then an INFO/ERROR completion entry with durationMs and
   * outcome. Rethrows the original error.
   */
  timed<T>(
    source: DebugLogSource,
    message: string,
    run: () => Promise<T>,
    options?: DebugLogOptions,
  ): Promise<T>;
  /** Stable snapshot reference; changes only on mutation (React-safe). */
  entries(): readonly DebugLogEntry[];
  subscribe(listener: () => void): () => void;
  clear(): void;
  readonly capacity: number;
}

const DEFAULT_CAPACITY = 500;
const REDACTED = "[redacted]";
const TRUNCATED = "[truncated]";
const MAX_DETAIL_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 100;

const SECRET_KEY_PATTERN =
  /csrf|cookie|password|passwd|authorization|bearer|secret|token|apikey|api[-_]?key|credential|session[-_]?id/i;

export const DEBUG_LOG_LEVELS: readonly DebugLogLevel[] = ["DEBUG", "INFO", "WARN", "ERROR"];

export const DEBUG_LOG_SOURCES: readonly DebugLogSource[] = [
  "network",
  "ai",
  "state",
  "upload",
  "realtime",
  "render",
];

let sequenceCounter = 0;
let correlationCounter = 0;

function isDev(): boolean {
  return typeof process === "undefined" || process.env?.NODE_ENV !== "production";
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(normalizeKey(key));
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null) {
    return null;
  }
  if (value === undefined) {
    return "[undefined]";
  }
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") {
    return value;
  }
  if (type === "bigint" || type === "symbol" || type === "function") {
    return String(value);
  }
  if (depth >= MAX_DETAIL_DEPTH) {
    return TRUNCATED;
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, depth + 1));
  }
  if (type === "object") {
    const source = value as Readonly<Record<string, unknown>>;
    const result: Record<string, unknown> = {};
    let seen = 0;
    for (const [key, item] of Object.entries(source)) {
      if (seen >= MAX_OBJECT_KEYS) {
        break;
      }
      seen += 1;
      result[key] = isSecretKey(key) ? REDACTED : sanitizeValue(item, depth + 1);
    }
    return result;
  }
  return String(value);
}

function sanitizeDetail(
  detail: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | null {
  if (detail === undefined) {
    return null;
  }
  return Object.freeze(sanitizeValue(detail, 0)) as Readonly<Record<string, unknown>>;
}

function levelMethod(level: DebugLogLevel): keyof ConsoleLike {
  switch (level) {
    case "DEBUG":
      return "debug";
    case "INFO":
      return "info";
    case "WARN":
      return "warn";
    case "ERROR":
      return "error";
  }
}

export function createCorrelationId(): string {
  const globalCrypto = typeof crypto !== "undefined" ? crypto : undefined;
  if (globalCrypto && typeof globalCrypto.randomUUID === "function") {
    return globalCrypto.randomUUID();
  }
  correlationCounter += 1;
  return `corr-${Date.now().toString(36)}-${correlationCounter}`;
}

export function createDebugLogger(options: DebugLoggerOptions = {}): DebugLogger {
  const capacity = Math.max(1, Math.floor(options.capacity ?? DEFAULT_CAPACITY));
  const forwardToConsole = options.forwardToConsole ?? isDev();
  const sink: ConsoleLike = options.consoleSink ?? console;
  const now = options.now ?? (() => Date.now());
  let buffer: readonly DebugLogEntry[] = Object.freeze([]);
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of [...listeners]) {
      listener();
    }
  }

  function append(entry: DebugLogEntry): void {
    const next =
      buffer.length < capacity
        ? [...buffer, entry]
        : [...buffer.slice(buffer.length - capacity + 1), entry];
    buffer = Object.freeze(next);
    if (forwardToConsole) {
      sink[levelMethod(entry.level)](
        `[#${entry.seq} ${entry.level}][${entry.source}] ${entry.message}`,
        entry.correlationId ?? undefined,
        entry.detail ?? undefined,
      );
    }
    notify();
  }

  function log(
    level: DebugLogLevel,
    source: DebugLogSource,
    message: string,
    logOptions?: DebugLogOptions,
    extra?: {
      readonly correlationId?: string | null;
      readonly durationMs?: number | null;
      readonly outcome?: DebugLogOutcome | null;
    },
  ): void {
    sequenceCounter += 1;
    append({
      seq: sequenceCounter,
      level,
      source,
      timestamp: new Date(now()).toISOString(),
      message,
      correlationId:
        extra?.correlationId !== undefined
          ? extra.correlationId
          : (logOptions?.correlationId ?? null),
      detail: sanitizeDetail(logOptions?.detail),
      durationMs: extra?.durationMs ?? null,
      outcome: extra?.outcome ?? null,
    });
  }

  return {
    debug: (source, message, logOptions) => log("DEBUG", source, message, logOptions),
    info: (source, message, logOptions) => log("INFO", source, message, logOptions),
    warn: (source, message, logOptions) => log("WARN", source, message, logOptions),
    error: (source, message, logOptions) => log("ERROR", source, message, logOptions),
    async timed<T>(
      source: DebugLogSource,
      message: string,
      run: () => Promise<T>,
      timedOptions?: DebugLogOptions,
    ): Promise<T> {
      const correlationId = timedOptions?.correlationId ?? createCorrelationId();
      log("DEBUG", source, `${message}.start`, timedOptions, {
        correlationId,
        outcome: "started",
        durationMs: null,
      });
      const startedAtMs = now();
      try {
        const result = await run();
        log("INFO", source, `${message}.ok`, timedOptions, {
          correlationId,
          outcome: "ok",
          durationMs: now() - startedAtMs,
        });
        return result;
      } catch (error) {
        log(
          "ERROR",
          source,
          `${message}.error`,
          {
            ...timedOptions,
            detail: {
              ...timedOptions?.detail,
              error: error instanceof Error ? error : String(error),
            },
          },
          { correlationId, outcome: "error", durationMs: now() - startedAtMs },
        );
        throw error;
      }
    },
    entries: () => buffer,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear: () => {
      buffer = Object.freeze([]);
      notify();
    },
    capacity,
  };
}

interface CaptureRegistry {
  readonly loggers: WeakSet<object>;
}

const captureRegistry: CaptureRegistry = { loggers: new WeakSet() };

/**
 * Installs window-level listeners that turn uncaught errors and unhandled
 * promise rejections into ERROR entries. Idempotent per logger. Returns a
 * cleanup function.
 */
export function installGlobalErrorCapture(logger: DebugLogger): () => void {
  if (typeof window === "undefined" || captureRegistry.loggers.has(logger)) {
    return () => {};
  }
  captureRegistry.loggers.add(logger);
  const onError = (event: ErrorEvent): void => {
    logger.error("render", event.message.length > 0 ? event.message : "Uncaught error", {
      detail: { error: event.error ?? null },
    });
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    const reason: unknown = event.reason;
    logger.error("render", reason instanceof Error ? reason.message : "Unhandled rejection", {
      detail: { reason: reason instanceof Error ? reason : String(reason) },
    });
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    captureRegistry.loggers.delete(logger);
  };
}

let sharedLogger: DebugLogger | null = null;

/** Process-wide logger singleton; installs global error capture on first use. */
export function getDebugLogger(): DebugLogger {
  sharedLogger ??= createDebugLogger({ capacity: DEFAULT_CAPACITY });
  installGlobalErrorCapture(sharedLogger);
  return sharedLogger;
}
