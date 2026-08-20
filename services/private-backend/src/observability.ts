export interface JsonLogger {
  request(
    event: Readonly<{
      requestId: string;
      method: string;
      path: string;
      status: number;
      durationMs: number;
      outcome: string;
    }>,
  ): void;
  error(event: Readonly<{ requestId: string; path: string; errorType: string }>): void;
}

export function createJsonLogger(
  options: { readonly write?: (line: string) => void; readonly now?: () => number } = {},
): JsonLogger {
  const write = options.write ?? ((line: string) => console.log(line));
  const now = options.now ?? Date.now;
  return {
    request(event) {
      write(JSON.stringify({ timestampMs: now(), level: "info", event: "http_request", ...event }));
    },
    error(event) {
      write(JSON.stringify({ timestampMs: now(), level: "error", event: "http_error", ...event }));
    },
  };
}

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] as const;

function labels(values: Record<string, string>): string {
  return Object.entries(values)
    .map(
      ([key, value]) =>
        `${key}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`,
    )
    .join(",");
}

export interface MetricsRegistry {
  observeHttp(
    method: string,
    path: string,
    status: number,
    durationMs: number,
    outcome: string,
  ): void;
  addRealtimeConnections(delta: 1 | -1): void;
  render(): string;
}

export function createMetricsRegistry(prefix: string): MetricsRegistry {
  const requests = new Map<string, number>();
  const errors = new Map<string, number>();
  const histograms = new Map<string, { count: number; sum: number; buckets: number[] }>();
  let realtimeConnections = 0;
  return {
    observeHttp(method, path, status, durationMs, outcome) {
      const requestLabels = labels({ method, path, status: String(status), outcome });
      requests.set(requestLabels, (requests.get(requestLabels) ?? 0) + 1);
      if (status >= 400) {
        const errorLabels = labels({ path, status: String(status) });
        errors.set(errorLabels, (errors.get(errorLabels) ?? 0) + 1);
      }
      const histogramLabels = labels({ method, path });
      const histogram = histograms.get(histogramLabels) ?? {
        count: 0,
        sum: 0,
        buckets: BUCKETS.map(() => 0),
      };
      const seconds = durationMs / 1_000;
      histogram.count += 1;
      histogram.sum += seconds;
      for (let index = 0; index < BUCKETS.length; index += 1) {
        if (seconds <= (BUCKETS[index] ?? 0))
          histogram.buckets[index] = (histogram.buckets[index] ?? 0) + 1;
      }
      histograms.set(histogramLabels, histogram);
    },
    addRealtimeConnections(delta) {
      realtimeConnections = Math.max(0, realtimeConnections + delta);
    },
    render() {
      const lines = [
        `# HELP ${prefix}_http_requests_total HTTP requests processed.`,
        `# TYPE ${prefix}_http_requests_total counter`,
      ];
      for (const [key, value] of requests)
        lines.push(`${prefix}_http_requests_total{${key}} ${value}`);
      lines.push(
        `# HELP ${prefix}_http_request_duration_seconds HTTP request duration.`,
        `# TYPE ${prefix}_http_request_duration_seconds histogram`,
      );
      for (const [key, histogram] of histograms) {
        for (let index = 0; index < BUCKETS.length; index += 1)
          lines.push(
            `${prefix}_http_request_duration_seconds_bucket{${key},le="${BUCKETS[index]}"} ${histogram.buckets[index]}`,
          );
        lines.push(
          `${prefix}_http_request_duration_seconds_bucket{${key},le="+Inf"} ${histogram.count}`,
        );
        lines.push(`${prefix}_http_request_duration_seconds_sum{${key}} ${histogram.sum}`);
        lines.push(`${prefix}_http_request_duration_seconds_count{${key}} ${histogram.count}`);
      }
      lines.push(
        `# HELP ${prefix}_http_errors_total HTTP error responses.`,
        `# TYPE ${prefix}_http_errors_total counter`,
      );
      for (const [key, value] of errors) lines.push(`${prefix}_http_errors_total{${key}} ${value}`);
      lines.push(
        `# HELP ${prefix}_realtime_connections Current realtime connections.`,
        `# TYPE ${prefix}_realtime_connections gauge`,
        `${prefix}_realtime_connections ${realtimeConnections}`,
      );
      return `${lines.join("\n")}\n`;
    },
  };
}

export function httpOutcome(status: number): string {
  if (status < 400) return "SUCCESS";
  if (status < 500) return "REJECTED";
  return "ERROR";
}
