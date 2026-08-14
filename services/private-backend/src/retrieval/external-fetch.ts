import { type RetrievedEvidence, RetrievedEvidenceSchema } from "@impromptu/contracts/retrieval";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_TYPES = new Set(["text/html", "application/xhtml+xml", "text/plain"]);

export interface SearchCandidate {
  readonly url: string;
  readonly snippet: string;
  readonly sourceId: string;
}

export interface ExternalFetchContext {
  readonly deckVersion: string;
  readonly manifestHash: string;
  readonly deadlineAtMs: number;
  readonly signal: AbortSignal;
}

export interface PublicDnsResolver {
  resolve(hostname: string, signal: AbortSignal): Promise<readonly string[]>;
}

export interface PinnedHttpsResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: AsyncIterable<Uint8Array>;
}

/** The transport must connect only to one of addresses and must not follow redirects itself. */
export interface PinnedHttpsTransport {
  request(input: {
    readonly url: string;
    readonly addresses: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<PinnedHttpsResponse>;
}

export type ExternalFetchResult =
  | Readonly<{ outcome: "FETCHED"; evidence: RetrievedEvidence }>
  | Readonly<{
      outcome: "REJECTED";
      reason: "UNSAFE_URL" | "NETWORK" | "TIMEOUT" | "TYPE" | "SIZE" | "REDIRECT";
    }>;

export class SafeExternalEvidenceFetcher {
  readonly #dns: PublicDnsResolver;
  readonly #transport: PinnedHttpsTransport;
  readonly #now: () => number;
  readonly #maxBytes: number;
  readonly #maxRedirects: number;
  readonly #scheduleDeadline: (deadlineAtMs: number, run: () => void) => () => void;

  constructor(dependencies: {
    readonly dns: PublicDnsResolver;
    readonly transport: PinnedHttpsTransport;
    readonly now?: () => number;
    readonly maxBytes?: number;
    readonly maxRedirects?: number;
    readonly scheduleDeadline?: (deadlineAtMs: number, run: () => void) => () => void;
  }) {
    this.#dns = dependencies.dns;
    this.#transport = dependencies.transport;
    this.#now = dependencies.now ?? Date.now;
    this.#maxBytes = dependencies.maxBytes ?? 1_000_000;
    this.#maxRedirects = dependencies.maxRedirects ?? 5;
    this.#scheduleDeadline =
      dependencies.scheduleDeadline ??
      ((deadlineAtMs, run) => {
        const timer = setTimeout(run, Math.max(0, deadlineAtMs - this.#now()));
        return () => clearTimeout(timer);
      });
  }

  async fetchCandidate(
    candidate: SearchCandidate,
    context: ExternalFetchContext,
  ): Promise<ExternalFetchResult> {
    const controller = new AbortController();
    let resolveDeadline: (result: ExternalFetchResult) => void = () => undefined;
    const deadline = new Promise<ExternalFetchResult>((resolve) => {
      resolveDeadline = resolve;
    });
    const onAbort = () => {
      controller.abort(context.signal.reason);
      resolveDeadline({ outcome: "REJECTED", reason: "TIMEOUT" });
    };
    context.signal.addEventListener("abort", onAbort, { once: true });
    const removeDeadline = this.#scheduleDeadline(context.deadlineAtMs, () => {
      controller.abort("external fetch deadline exceeded");
      resolveDeadline({ outcome: "REJECTED", reason: "TIMEOUT" });
    });
    if (context.signal.aborted) onAbort();
    try {
      return await Promise.race([
        this.#fetchCandidate(candidate, { ...context, signal: controller.signal }).catch(() => ({
          outcome: "REJECTED" as const,
          reason: "TYPE" as const,
        })),
        deadline,
      ]);
    } finally {
      removeDeadline();
      context.signal.removeEventListener("abort", onAbort);
      controller.abort("external fetch complete");
    }
  }

  async #fetchCandidate(
    candidate: SearchCandidate,
    context: ExternalFetchContext,
  ): Promise<ExternalFetchResult> {
    // candidate.snippet is deliberately never copied into evidence; only fetched origin bytes qualify.
    let url: URL;
    try {
      url = safeHttpsUrl(candidate.url);
    } catch {
      return { outcome: "REJECTED", reason: "UNSAFE_URL" };
    }
    const visited = new Set<string>();
    for (let redirects = 0; redirects <= this.#maxRedirects; redirects += 1) {
      if (context.signal.aborted || this.#now() >= context.deadlineAtMs) {
        return { outcome: "REJECTED", reason: "TIMEOUT" };
      }
      const canonicalRequestUrl = url.toString();
      if (visited.has(canonicalRequestUrl)) return { outcome: "REJECTED", reason: "REDIRECT" };
      visited.add(canonicalRequestUrl);
      let addresses: readonly string[];
      let response: PinnedHttpsResponse;
      try {
        addresses = await this.#dns.resolve(url.hostname, context.signal);
        if (addresses.length === 0 || addresses.some((address) => !isPublicIpAddress(address))) {
          return { outcome: "REJECTED", reason: "UNSAFE_URL" };
        }
        response = await this.#transport.request({
          url: canonicalRequestUrl,
          addresses: Object.freeze([...addresses]),
          signal: context.signal,
        });
      } catch {
        return context.signal.aborted || this.#now() >= context.deadlineAtMs
          ? { outcome: "REJECTED", reason: "TIMEOUT" }
          : { outcome: "REJECTED", reason: "NETWORK" };
      }
      if (REDIRECT_STATUSES.has(response.status)) {
        if (redirects === this.#maxRedirects) return { outcome: "REJECTED", reason: "REDIRECT" };
        const location = header(response.headers, "location");
        if (location === null) return { outcome: "REJECTED", reason: "REDIRECT" };
        try {
          url = safeHttpsUrl(new URL(location, url).toString());
        } catch {
          return { outcome: "REJECTED", reason: "UNSAFE_URL" };
        }
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        return { outcome: "REJECTED", reason: "NETWORK" };
      }
      const mediaType = (header(response.headers, "content-type") ?? "")
        .split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (mediaType === undefined || !ALLOWED_TYPES.has(mediaType)) {
        return { outcome: "REJECTED", reason: "TYPE" };
      }
      const declaredLength = Number(header(response.headers, "content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > this.#maxBytes) {
        return { outcome: "REJECTED", reason: "SIZE" };
      }
      const chunks: Uint8Array[] = [];
      let byteLength = 0;
      try {
        for await (const chunk of response.body) {
          if (context.signal.aborted || this.#now() >= context.deadlineAtMs) {
            return { outcome: "REJECTED", reason: "TIMEOUT" };
          }
          byteLength += chunk.byteLength;
          if (byteLength > this.#maxBytes) return { outcome: "REJECTED", reason: "SIZE" };
          chunks.push(chunk);
        }
      } catch {
        return { outcome: "REJECTED", reason: "NETWORK" };
      }
      const bytes = concatenate(chunks, byteLength);
      let decoded: string;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return { outcome: "REJECTED", reason: "TYPE" };
      }
      const extracted = extractText(decoded, mediaType);
      if (extracted.length === 0) return { outcome: "REJECTED", reason: "TYPE" };
      const hash = await sha256(bytes);
      const finalUrl = new URL(url);
      finalUrl.hash = "";
      const sourceDate = extractDate(decoded, response.headers);
      return {
        outcome: "FETCHED",
        evidence: RetrievedEvidenceSchema.parse({
          evidenceId: `external:${hash}`,
          sourceId: candidate.sourceId,
          sourceRevision: hash,
          sourceHash: hash,
          deckVersion: context.deckVersion,
          manifestHash: context.manifestHash,
          title: extractTitle(decoded, mediaType) ?? finalUrl.hostname,
          content: extracted,
          quote: extracted.slice(0, 2_000),
          anchor: `${finalUrl.toString()}#sha256=${hash}`,
          canonicalUrl: finalUrl.toString(),
          sourceDate,
          rights: "UNKNOWN",
          containsPii: false,
          authorizationVersion: "external-fetch-v1",
        }),
      };
    }
    return { outcome: "REJECTED", reason: "REDIRECT" };
  }
}

export function isPublicIpAddress(input: string): boolean {
  const address = input
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  const ipv4 = parseIpv4(address);
  if (ipv4 !== null) return isPublicIpv4(ipv4);
  const mapped = address.match(/(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped !== undefined) {
    const parsed = parseIpv4(mapped);
    return parsed !== null && isPublicIpv4(parsed);
  }
  if (!/^[0-9a-f:]+$/.test(address) || !address.includes(":")) return false;
  if (address === "::" || address === "::1") return false;
  const first = Number.parseInt(address.split(":", 1)[0] || "0", 16);
  if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff) return false;
  if (address.startsWith("2001:db8:") || address === "2001:db8::") return false;
  return true;
}

function parseIpv4(input: string): readonly number[] | null {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(input)) return null;
  const parts = input.split(".").map(Number);
  return parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

function isPublicIpv4(parts: readonly number[]): boolean {
  const [a = 0, b = 0, c = 0] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100)) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function safeHttpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") {
    throw new TypeError("Only credential-free HTTPS origins on the default port are allowed");
  }
  return url;
}

function header(headers: Readonly<Record<string, string>>, name: string): string | null {
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return match?.[1] ?? null;
}

function concatenate(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function extractText(document: string, mediaType: string): string {
  if (mediaType === "text/plain") return normalizeText(document);
  return normalizeText(
    decodeEntities(
      document
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, " ")
        .replace(/<[^>]+>/g, " "),
    ),
  );
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function extractTitle(document: string, mediaType: string): string | null {
  if (mediaType === "text/plain") return null;
  const title = document.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return title === undefined ? null : normalizeText(decodeEntities(title)).slice(0, 500) || null;
}

function extractDate(document: string, headers: Readonly<Record<string, string>>): string | null {
  const candidate =
    document.match(/<time\b[^>]*datetime=["']([^"']+)["']/i)?.[1] ??
    document.match(
      /<meta\b[^>]*(?:property|name)=["'](?:article:published_time|date)["'][^>]*content=["']([^"']+)["']/i,
    )?.[1] ??
    header(headers, "last-modified");
  if (candidate === undefined || candidate === null) return null;
  const timestamp = Date.parse(candidate);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
