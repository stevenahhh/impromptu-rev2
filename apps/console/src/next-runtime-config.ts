const DEFAULT_PRIVATE_API_ORIGIN = "http://127.0.0.1:3001";
const DEFAULT_DECK_ASSET_ORIGIN = "http://127.0.0.1:3002";

type Environment = Readonly<Record<string, string | undefined>>;

function exactHttpOrigin(name: string, value: string, requireHttps: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) origin`);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== value) {
    throw new Error(`${name} must be an absolute HTTP(S) origin`);
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (requireHttps && parsed.protocol !== "https:" && !loopback) {
    throw new Error(`${name} must use https in production`);
  }
  return value;
}

export function consolePrivateApiOrigin(environment: Environment = process.env): string {
  const production = environment.NODE_ENV === "production";
  const configured = environment.CONSOLE_PRIVATE_API_ORIGIN?.trim();
  if (configured === undefined || configured.length === 0) {
    if (production) {
      throw new Error("CONSOLE_PRIVATE_API_ORIGIN is required when NODE_ENV=production");
    }
    return DEFAULT_PRIVATE_API_ORIGIN;
  }
  return exactHttpOrigin("CONSOLE_PRIVATE_API_ORIGIN", configured, production);
}

export function consoleDeckAssetOrigin(environment: Environment = process.env): string {
  const configured = environment.CONSOLE_DECK_ASSET_ORIGIN?.trim();
  if (configured === undefined || configured.length === 0) return DEFAULT_DECK_ASSET_ORIGIN;
  // This is a server-to-server hop and may use an internal HTTP network in production.
  return exactHttpOrigin("CONSOLE_DECK_ASSET_ORIGIN", configured, false);
}
