// Shared transport primitives for the private console client: credentialed request
// defaults, CSRF mutation headers, closed response-body reads, and the small field
// readers reused by every closed response parser.

export interface ReportEventSource {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  close(): void;
}

export interface PrivateClientContext {
  readonly baseUrl: string;
  readonly createReportEventSource: (url: string) => ReportEventSource;
  readonly reportReadyTimeoutMs: number;
}

export function mutationHeaders(csrfToken?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(csrfToken === undefined ? {} : { "x-csrf-token": csrfToken }),
  };
}

export async function responseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function stringField(value: unknown, field: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" ? candidate : null;
}

export function externalSourceUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === ""
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function optionalUrl(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  try {
    return new URL(value).toString();
  } catch {
    return undefined;
  }
}
