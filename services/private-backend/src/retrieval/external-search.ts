import type { SearchCandidate } from "./external-fetch.ts";

const DEFAULT_MAX_RESULTS = 10;
const DUCKDUCKGO_HTML_ENDPOINT = "https://html.duckduckgo.com/html/";
const GOOGLE_CSE_ENDPOINT = "https://customsearch.googleapis.com/customsearch/v1";
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

export interface ExternalSearchBoundary {
  search(query: string, signal: AbortSignal): Promise<readonly SearchCandidate[]>;
}

export type ExternalSearchProvider = "duckduckgo-html" | "google-cse" | "brave";
export type ExternalSearchFailure =
  | "HTTP_403"
  | "HTTP_429"
  | "EMPTY"
  | "PARSE_ERROR"
  | "TIMEOUT"
  | "NETWORK";

export interface ExternalSearchDiagnostic {
  readonly provider: ExternalSearchProvider;
  readonly failure: ExternalSearchFailure;
}

export interface ExternalSearchDiagnosticObserver {
  observe(diagnostic: ExternalSearchDiagnostic): void;
}

export interface GoogleCseCredentials {
  readonly apiKey: string;
  readonly searchEngineId: string;
}

export interface ExternalSearchEndpoints {
  readonly duckDuckGoHtml: string;
  readonly googleCse: string;
  readonly brave: string;
}

interface ProviderSearchFailure {
  readonly failure: ExternalSearchFailure;
}

type ExternalSearchFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class KeylessFirstExternalSearchBoundary implements ExternalSearchBoundary {
  readonly #fetch: ExternalSearchFetch;
  readonly #googleCse: GoogleCseCredentials | undefined;
  readonly #braveApiKey: string | undefined;
  readonly #maxResults: number;
  readonly #endpoints: ExternalSearchEndpoints;
  readonly #diagnostics: ExternalSearchDiagnosticObserver | undefined;

  constructor(
    dependencies: {
      readonly googleCse?: GoogleCseCredentials;
      readonly braveApiKey?: string;
      readonly fetch?: ExternalSearchFetch;
      readonly maxResults?: number;
      readonly endpoints?: ExternalSearchEndpoints;
      readonly diagnostics?: ExternalSearchDiagnosticObserver;
    } = {},
  ) {
    this.#fetch = dependencies.fetch ?? fetch;
    this.#googleCse = configuredGoogleCse(dependencies.googleCse);
    this.#braveApiKey = configuredSecret(dependencies.braveApiKey);
    this.#maxResults = Math.max(
      1,
      Math.min(DEFAULT_MAX_RESULTS, dependencies.maxResults ?? DEFAULT_MAX_RESULTS),
    );
    this.#endpoints = dependencies.endpoints ?? {
      duckDuckGoHtml: DUCKDUCKGO_HTML_ENDPOINT,
      googleCse: GOOGLE_CSE_ENDPOINT,
      brave: BRAVE_ENDPOINT,
    };
    this.#diagnostics = dependencies.diagnostics;
  }

  async search(query: string, signal: AbortSignal): Promise<readonly SearchCandidate[]> {
    const providers: readonly ExternalSearchProvider[] = ["duckduckgo-html"];
    const configured = [
      ...providers,
      ...(this.#googleCse === undefined ? [] : (["google-cse"] as const)),
      ...(this.#braveApiKey === undefined ? [] : (["brave"] as const)),
    ];
    for (const provider of configured) {
      if (signal.aborted) {
        this.#observe(provider, "TIMEOUT");
        return [];
      }
      let urls: readonly string[];
      try {
        urls = await this.#searchProvider(provider, query, signal);
      } catch (error) {
        this.#observe(provider, signal.aborted ? "TIMEOUT" : failureFrom(error));
        continue;
      }
      const candidates = candidatesFor(provider, urls, this.#maxResults);
      if (candidates.length > 0) return candidates;
      this.#observe(provider, "EMPTY");
    }
    return [];
  }

  async #searchProvider(
    provider: ExternalSearchProvider,
    query: string,
    signal: AbortSignal,
  ): Promise<readonly string[]> {
    if (provider === "duckduckgo-html") {
      const url = new URL(this.#endpoints.duckDuckGoHtml);
      url.searchParams.set("q", query);
      const body = await this.#request(url, { accept: "text/html" }, signal);
      return parseDuckDuckGoHtml(body);
    }
    if (provider === "google-cse") {
      const credentials = this.#googleCse;
      if (credentials === undefined) return [];
      const url = new URL(this.#endpoints.googleCse);
      url.searchParams.set("q", query);
      url.searchParams.set("key", credentials.apiKey);
      url.searchParams.set("cx", credentials.searchEngineId);
      url.searchParams.set("num", String(this.#maxResults));
      return parseGoogleCse(await this.#request(url, { accept: "application/json" }, signal));
    }
    const apiKey = this.#braveApiKey;
    if (apiKey === undefined) return [];
    const url = new URL(this.#endpoints.brave);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(this.#maxResults));
    return parseBrave(
      await this.#request(
        url,
        { accept: "application/json", "x-subscription-token": apiKey },
        signal,
      ),
    );
  }

  async #request(
    url: URL,
    headers: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<string> {
    const response = await this.#fetch(url, { method: "GET", headers, signal });
    if (response.status === 403) throw { failure: "HTTP_403" } satisfies ProviderSearchFailure;
    if (response.status === 429) throw { failure: "HTTP_429" } satisfies ProviderSearchFailure;
    if (!response.ok) throw { failure: "NETWORK" } satisfies ProviderSearchFailure;
    return await response.text();
  }

  #observe(provider: ExternalSearchProvider, failure: ExternalSearchFailure): void {
    this.#diagnostics?.observe({ provider, failure });
  }
}

export function externalSearchCredentialsFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<{ googleCse?: GoogleCseCredentials; braveApiKey?: string }> {
  const googleCse = configuredGoogleCse({
    apiKey: environment.GOOGLE_CSE_API_KEY ?? "",
    searchEngineId: environment.GOOGLE_CSE_SEARCH_ENGINE_ID ?? "",
  });
  const braveApiKey = configuredSecret(environment.BRAVE_SEARCH_API_KEY);
  return {
    ...(googleCse === undefined ? {} : { googleCse }),
    ...(braveApiKey === undefined ? {} : { braveApiKey }),
  };
}

function candidatesFor(
  provider: ExternalSearchProvider,
  urls: readonly string[],
  maxResults: number,
): readonly SearchCandidate[] {
  const seen = new Set<string>();
  const candidates: SearchCandidate[] = [];
  for (const value of urls) {
    const url = canonicalExternalUrl(value);
    if (url === null || seen.has(url)) continue;
    seen.add(url);
    candidates.push({ url, sourceId: `external-search:${provider}` });
    if (candidates.length === maxResults) break;
  }
  return candidates;
}

function canonicalExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== ""
    ) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function parseDuckDuckGoHtml(body: string): readonly string[] {
  const urls: string[] = [];
  for (const tag of body.match(/<a\b[^>]*>/gi) ?? []) {
    const className = attribute(tag, "class");
    const href = attribute(tag, "href");
    if (className === null || href === null || !className.split(/\s+/).includes("result__a"))
      continue;
    const destination = duckDuckGoDestination(href);
    if (destination !== null) urls.push(destination);
  }
  return urls;
}

function duckDuckGoDestination(value: string): string | null {
  const href = decodeHtml(value);
  try {
    const url = new URL(href.startsWith("//") ? `https:${href}` : href);
    return url.searchParams.get("uddg") ?? href;
  } catch {
    return null;
  }
}

function parseGoogleCse(body: string): readonly string[] {
  const payload = parseJson(body);
  if (!isRecord(payload) || !Array.isArray(payload.items)) return [];
  return payload.items.flatMap((item) =>
    isRecord(item) && typeof item.link === "string" ? [item.link] : [],
  );
}

function parseBrave(body: string): readonly string[] {
  const payload = parseJson(body);
  if (!isRecord(payload) || !isRecord(payload.web) || !Array.isArray(payload.web.results))
    return [];
  return payload.web.results.flatMap((item) =>
    isRecord(item) && typeof item.url === "string" ? [item.url] : [],
  );
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw { failure: "PARSE_ERROR" } satisfies ProviderSearchFailure;
  }
}

function attribute(tag: string, name: string): string | null {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i");
  return pattern.exec(tag)?.[2] ?? null;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function configuredGoogleCse(
  value: GoogleCseCredentials | undefined,
): GoogleCseCredentials | undefined {
  return value !== undefined && value.apiKey.length > 0 && value.searchEngineId.length > 0
    ? value
    : undefined;
}

function configuredSecret(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

function failureFrom(value: unknown): ExternalSearchFailure {
  if (isRecord(value) && isFailure(value.failure)) return value.failure;
  return "NETWORK";
}

function isFailure(value: unknown): value is ExternalSearchFailure {
  return (
    value === "HTTP_403" ||
    value === "HTTP_429" ||
    value === "EMPTY" ||
    value === "PARSE_ERROR" ||
    value === "TIMEOUT" ||
    value === "NETWORK"
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
