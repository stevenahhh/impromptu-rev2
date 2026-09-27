/**
 * The public Stage resolves its canonical entry for a deck through the landing
 * URL (`/?deck=<version>`, see apps/stage/src/App.tsx). The origin is the stage
 * dev server by default and can be overridden with VITE_STAGE_ORIGIN for
 * deployed rehearsal topologies.
 */
// Runtime override wins over the build-time constant so a rotating public tunnel
// URL never needs an image rebuild. The server injects window.__STAGE_ORIGIN from
// the STAGE_ORIGIN env var in the layout; the build-time NEXT_PUBLIC_STAGE_ORIGIN
// is the fallback.
declare const window: { __STAGE_ORIGIN?: string } | undefined;

const STAGE_ORIGIN_FALLBACK = "http://localhost:4174";

/**
 * Fail-closed origin resolution. An unset or blank override must never reach stageUrl():
 * `${""}/?deck=...` would silently collapse onto the console's own origin, and a non-URL value
 * would throw later inside `new URL(STAGE_ORIGIN)` in workspace-page. Only absolute http(s)
 * inputs are honoured, and the canonical URL origin is what survives so a configured path or
 * trailing slash cannot leak into deck URLs or the postMessage targetOrigin comparison in
 * audience-screen.ts.
 */
export function resolveStageOrigin(runtimeOrigin: unknown, buildTimeOrigin: unknown): string {
  for (const candidate of [runtimeOrigin, buildTimeOrigin]) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed === "" || !URL.canParse(trimmed)) continue;
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    return url.origin;
  }
  return STAGE_ORIGIN_FALLBACK;
}

const runtime = typeof window !== "undefined" ? window.__STAGE_ORIGIN : undefined;

export const STAGE_ORIGIN = resolveStageOrigin(runtime, process.env.NEXT_PUBLIC_STAGE_ORIGIN);

export function stageUrl(deckVersion: string): string {
  return `${STAGE_ORIGIN}/?deck=${encodeURIComponent(deckVersion)}`;
}
