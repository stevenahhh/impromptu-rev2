const DEFAULT_PUBLIC_API_ORIGIN = "http://127.0.0.1:3002";

type Environment = Readonly<Record<string, string | undefined>>;

export function stagePublicApiOrigin(
  environment: Environment = process.env,
  production = environment.NODE_ENV === "production",
): string {
  const configured = environment.STAGE_PUBLIC_API_ORIGIN?.trim();
  if (configured === undefined || configured.length === 0) {
    if (production) {
      throw new Error("STAGE_PUBLIC_API_ORIGIN is required for a production build");
    }
    return DEFAULT_PUBLIC_API_ORIGIN;
  }

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

export function stageWebSocketOrigin(publicApiOrigin: string): string {
  const origin = new URL(publicApiOrigin);
  origin.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  return origin.origin;
}
