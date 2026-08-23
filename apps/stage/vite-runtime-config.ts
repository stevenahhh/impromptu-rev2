const DEFAULT_GATEWAY_PROXY_TARGET = "http://127.0.0.1:3002";

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The origin the Stage bundle addresses from the browser. An empty string means "the origin the
 * page itself was served from", which is the supported deployment shape: the surface serving
 * Stage also proxies `/v1` to the projection gateway.
 *
 * Same-origin is not a convenience here, it is what makes the audience display work on every
 * browser. The gateway hands the display its session as a `SameSite=Strict` cookie, and a browser
 * discards such a cookie when it arrives on a cross-site response — so a cross-origin Stage loses
 * its session the moment it is issued and every later snapshot/event request is rejected. Neither
 * `EventSource` nor `WebSocket` can carry a header instead, and putting the session in a query
 * string would leak it into access logs and history, so relocating the credential is not an
 * escape either.
 *
 * An explicit override remains parseable for operators who terminate both surfaces on one origin
 * by other means, and is still validated as an absolute origin.
 */
export function stagePublicApiOrigin(
  environment: Environment = process.env,
  production = environment.NODE_ENV === "production",
): string {
  const configured = environment.STAGE_PUBLIC_API_ORIGIN?.trim();
  if (configured === undefined || configured.length === 0) return "";

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("STAGE_PUBLIC_API_ORIGIN must be an absolute HTTP(S) origin");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.origin !== configured
  ) {
    throw new Error("STAGE_PUBLIC_API_ORIGIN must be an absolute HTTP(S) origin");
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (production && parsed.protocol !== "https:" && !loopback) {
    throw new Error("STAGE_PUBLIC_API_ORIGIN must use https for a production build");
  }
  return configured;
}

/**
 * Where the dev/preview server forwards `/v1`. This is a server-side hop that never reaches the
 * browser, so it is deliberately separate from the browser-visible origin above: the browser must
 * keep addressing its own origin even though the gateway listens somewhere else.
 */
export function stageGatewayProxyTarget(environment: Environment = process.env): string {
  const configured =
    environment.PROJECTION_GATEWAY_ORIGIN?.trim() ?? environment.STAGE_PUBLIC_API_ORIGIN?.trim();
  return configured === undefined || configured.length === 0
    ? DEFAULT_GATEWAY_PROXY_TARGET
    : configured;
}

/**
 * The realtime origin to declare in `connect-src`. Same-origin Stage returns an empty string
 * because CSP `'self'` already covers a `ws:`/`wss:` connection back to the page's own host.
 */
export function stageWebSocketOrigin(publicApiOrigin: string): string {
  if (publicApiOrigin === "") return "";
  const origin = new URL(publicApiOrigin);
  origin.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  return origin.origin;
}
