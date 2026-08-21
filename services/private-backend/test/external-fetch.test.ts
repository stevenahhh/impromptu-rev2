import { describe, expect, test } from "bun:test";
import {
  isPublicIpAddress,
  type PinnedHttpsResponse,
  SafeExternalEvidenceFetcher,
} from "../src/retrieval/external-fetch.ts";
import { KeylessFirstExternalSearchBoundary } from "../src/retrieval/external-search.ts";

const encoder = new TextEncoder();
const manifestHash = "a".repeat(64);
const context = () => ({
  deckVersion: "deck_v1",
  manifestHash,
  deadlineAtMs: 5_000,
  signal: new AbortController().signal,
});

function response(
  status: number,
  headers: Record<string, string>,
  chunks: readonly string[],
): PinnedHttpsResponse {
  return {
    status,
    headers,
    body: {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield encoder.encode(chunk);
      },
    },
  };
}

describe("SSRF-safe external evidence fetch", () => {
  test("blocks non-public address ranges", () => {
    for (const address of [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "198.18.0.1",
      "224.0.0.1",
      "::1",
      "fc00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "2001:db8::1",
    ])
      expect(isPublicIpAddress(address)).toBe(false);
    expect(isPublicIpAddress("93.184.216.34")).toBe(true);
    expect(isPublicIpAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(true);
  });

  test("revalidates DNS redirects for a provider candidate before pinned transport access", async () => {
    const search = new KeylessFirstExternalSearchBoundary({
      fetch: async () =>
        new Response('<a class="result__a" href="https://safe.example/start">result</a>'),
    });
    const candidates = await search.search("revenue", new AbortController().signal);
    const candidate = candidates[0];
    if (candidate === undefined) throw new Error("expected search candidate");
    const transportCalls: string[] = [];
    const fetcher = new SafeExternalEvidenceFetcher({
      dns: {
        async resolve(host) {
          return host === "safe.example" ? ["93.184.216.34"] : ["169.254.169.254"];
        },
      },
      transport: {
        async request(input) {
          transportCalls.push(input.url);
          return response(302, { location: "https://metadata.example/latest" }, []);
        },
      },
      now: () => 0,
    });
    expect(await fetcher.fetchCandidate(candidate, context())).toEqual({
      outcome: "REJECTED",
      reason: "UNSAFE_URL",
    });
    expect(transportCalls).toEqual(["https://safe.example/start"]);
  });

  test("keeps provider title and snippet sentinels out of fetched evidence", async () => {
    const html =
      '<html><head><title>Report &amp; Notes</title></head><body><script>ignore me</script><time datetime="2025-03-04"></time><p>Revenue was 42 million USD.</p></body></html>';
    const search = new KeylessFirstExternalSearchBoundary({
      fetch: async () =>
        new Response(
          '<a class="result__a" href="https://evidence.example/report#search">SEARCH_TITLE_SENTINEL</a><a class="result__snippet">SEARCH_SNIPPET_SENTINEL</a>',
        ),
    });
    const candidates = await search.search("revenue", new AbortController().signal);
    expect(candidates).toEqual([
      { url: "https://evidence.example/report", sourceId: "external-search:duckduckgo-html" },
    ]);
    const candidate = candidates[0];
    if (candidate === undefined) throw new Error("expected search candidate");
    const calls: unknown[] = [];
    const fetcher = new SafeExternalEvidenceFetcher({
      dns: {
        async resolve() {
          return ["93.184.216.34"];
        },
      },
      transport: {
        async request(input) {
          calls.push(input);
          return response(200, { "content-type": "text/html; charset=utf-8" }, [html]);
        },
      },
      now: () => 100,
    });
    const result = await fetcher.fetchCandidate(candidate, context());
    expect(result.outcome).toBe("FETCHED");
    if (result.outcome !== "FETCHED") throw new Error("expected fetched evidence");
    expect(result.evidence.canonicalUrl).toBe("https://evidence.example/report");
    expect(result.evidence.title).toBe("Report & Notes");
    expect(result.evidence.content).toBe("Report & Notes Revenue was 42 million USD.");
    expect(result.evidence.content).not.toContain("SEARCH_TITLE_SENTINEL");
    expect(result.evidence.content).not.toContain("SEARCH_SNIPPET_SENTINEL");
    expect(result.evidence.sourceDate).toBe("2025-03-04T00:00:00.000Z");
    expect(result.evidence.anchor).toContain("#sha256=");
    expect(result.evidence.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(calls).toHaveLength(1);
  });

  test("returns typed terminals for malformed UTF-8 and pending DNS at the local deadline", async () => {
    const malformed = new SafeExternalEvidenceFetcher({
      dns: {
        async resolve() {
          return ["93.184.216.34"];
        },
      },
      transport: {
        async request() {
          return {
            status: 200,
            headers: { "content-type": "text/plain" },
            body: {
              async *[Symbol.asyncIterator]() {
                yield new Uint8Array([0xc3, 0x28]);
              },
            },
          };
        },
      },
      now: () => 0,
    });
    expect(
      await malformed.fetchCandidate({ url: "https://example.com", sourceId: "s" }, context()),
    ).toEqual({ outcome: "REJECTED", reason: "TYPE" });

    const startedAtMs = Date.now();
    const pendingDns = new SafeExternalEvidenceFetcher({
      dns: {
        async resolve() {
          return await new Promise<readonly string[]>(() => undefined);
        },
      },
      transport: {
        async request() {
          throw new Error("must not connect");
        },
      },
    });
    expect(
      await pendingDns.fetchCandidate(
        { url: "https://example.com", sourceId: "s" },
        {
          deckVersion: "deck_v1",
          manifestHash,
          deadlineAtMs: startedAtMs + 10,
          signal: new AbortController().signal,
        },
      ),
    ).toEqual({ outcome: "REJECTED", reason: "TIMEOUT" });
    expect(Date.now() - startedAtMs).toBeLessThan(80);
  });

  test("enforces HTTPS, credentials, type, byte, redirect, and deadline limits", async () => {
    const base = {
      dns: {
        async resolve() {
          return ["93.184.216.34"];
        },
      },
      now: () => 0,
    };
    const unused = {
      async request() {
        throw new Error("must not fetch");
      },
    };
    const safe = new SafeExternalEvidenceFetcher({ ...base, transport: unused });
    for (const url of [
      "http://example.com",
      "https://user@example.com",
      "https://example.com:444/",
    ]) {
      expect((await safe.fetchCandidate({ url, sourceId: "s" }, context())).outcome).toBe(
        "REJECTED",
      );
    }

    const wrongType = new SafeExternalEvidenceFetcher({
      ...base,
      transport: {
        async request() {
          return response(200, { "content-type": "application/pdf" }, ["pdf"]);
        },
      },
    });
    expect(
      await wrongType.fetchCandidate({ url: "https://example.com", sourceId: "s" }, context()),
    ).toEqual({ outcome: "REJECTED", reason: "TYPE" });

    const oversized = new SafeExternalEvidenceFetcher({
      ...base,
      maxBytes: 4,
      transport: {
        async request() {
          return response(200, { "content-type": "text/plain" }, ["123", "45"]);
        },
      },
    });
    expect(
      await oversized.fetchCandidate({ url: "https://example.com", sourceId: "s" }, context()),
    ).toEqual({ outcome: "REJECTED", reason: "SIZE" });

    let now = 0;
    const deadline = new SafeExternalEvidenceFetcher({
      dns: {
        async resolve() {
          return ["93.184.216.34"];
        },
      },
      now: () => now,
      transport: {
        async request() {
          now = 5_000;
          return response(200, { "content-type": "text/plain" }, ["late"]);
        },
      },
    });
    expect(
      await deadline.fetchCandidate({ url: "https://example.com", sourceId: "s" }, context()),
    ).toEqual({ outcome: "REJECTED", reason: "TIMEOUT" });
  });
});

describe("keyless-first external search", () => {
  test("falls back from DuckDuckGo 403 through configured providers and canonically deduplicates URLs", async () => {
    const requests: URL[] = [];
    const diagnostics: Array<{ provider: string; failure: string }> = [];
    const search = new KeylessFirstExternalSearchBoundary({
      googleCse: { apiKey: "google-key", searchEngineId: "engine-id" },
      braveApiKey: "brave-key",
      diagnostics: {
        observe(diagnostic) {
          diagnostics.push(diagnostic);
        },
      },
      fetch: async (input) => {
        const url = toUrl(input);
        requests.push(url);
        if (url.hostname === "ddg.test") return new Response("blocked", { status: 403 });
        if (url.hostname === "google.test") return new Response("limited", { status: 429 });
        return Response.json({
          web: {
            results: [
              {
                title: "SEARCH_TITLE_SENTINEL",
                description: "SEARCH_SNIPPET_SENTINEL",
                url: "https://origin.example/article#search",
              },
              { title: "duplicate", url: "https://origin.example/article" },
              { title: "unsafe", url: "http://origin.example/unsafe" },
            ],
          },
        });
      },
      endpoints: {
        duckDuckGoHtml: "https://ddg.test/html/",
        googleCse: "https://google.test/search",
        brave: "https://brave.test/search",
      },
    });

    expect(await search.search("revenue", new AbortController().signal)).toEqual([
      { url: "https://origin.example/article", sourceId: "external-search:brave" },
    ]);
    expect(requests.map((url) => url.hostname)).toEqual(["ddg.test", "google.test", "brave.test"]);
    expect(diagnostics).toEqual([
      { provider: "duckduckgo-html", failure: "HTTP_403" },
      { provider: "google-cse", failure: "HTTP_429" },
    ]);
  });

  test("degrades parse errors and empty results without a candidate", async () => {
    const diagnostics: Array<{ provider: string; failure: string }> = [];
    const search = new KeylessFirstExternalSearchBoundary({
      googleCse: { apiKey: "google-key", searchEngineId: "engine-id" },
      braveApiKey: "brave-key",
      diagnostics: {
        observe(diagnostic) {
          diagnostics.push(diagnostic);
        },
      },
      fetch: async (input) => {
        const url = toUrl(input);
        if (url.hostname === "ddg.test") return new Response("<html>no results</html>");
        if (url.hostname === "google.test") return new Response("not json");
        return Response.json({ web: { results: [] } });
      },
      endpoints: {
        duckDuckGoHtml: "https://ddg.test/html/",
        googleCse: "https://google.test/search",
        brave: "https://brave.test/search",
      },
    });

    expect(await search.search("revenue", new AbortController().signal)).toEqual([]);
    expect(diagnostics).toEqual([
      { provider: "duckduckgo-html", failure: "EMPTY" },
      { provider: "google-cse", failure: "PARSE_ERROR" },
      { provider: "brave", failure: "EMPTY" },
    ]);
  });

  test("stops on the shared aborted signal as a timeout degradation", async () => {
    const diagnostics: Array<{ provider: string; failure: string }> = [];
    let requestedResolve: () => void = () => undefined;
    const requested = new Promise<void>((resolve) => {
      requestedResolve = resolve;
    });
    const search = new KeylessFirstExternalSearchBoundary({
      diagnostics: {
        observe(diagnostic) {
          diagnostics.push(diagnostic);
        },
      },
      fetch: async (_input, init) => {
        requestedResolve();
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      },
    });
    const controller = new AbortController();
    const result = search.search("revenue", controller.signal);
    await requested;
    controller.abort("deadline");
    expect(await result).toEqual([]);
    expect(diagnostics).toEqual([{ provider: "duckduckgo-html", failure: "TIMEOUT" }]);
  });
});

function toUrl(input: RequestInfo | URL): URL {
  return new URL(
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
  );
}
