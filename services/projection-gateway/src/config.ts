export type Environment = Readonly<Record<string, string | undefined>>;

declare const exactOriginBrand: unique symbol;
export type ExactOrigin = string & { readonly [exactOriginBrand]: true };

export interface ProjectionGatewayConfig {
  readonly host: string;
  readonly port: number;
  readonly allowedOrigin: ExactOrigin;
}

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 3002;

function parsePort(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_PORT;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PROJECTION_GATEWAY_PORT must be an integer between 1 and 65535");
  }

  return port;
}

function parseExactOrigin(value: string | undefined): ExactOrigin {
  if (value === undefined || value.length === 0) {
    throw new Error("STAGE_ORIGIN is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("STAGE_ORIGIN must be an exact origin");
  }

  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== value) {
    throw new Error("STAGE_ORIGIN must be an exact origin");
  }

  return value as ExactOrigin;
}

export function parseProjectionGatewayConfig(environment: Environment): ProjectionGatewayConfig {
  const host = environment.PROJECTION_GATEWAY_HOST ?? DEFAULT_HOST;
  if (host.length === 0) {
    throw new Error("PROJECTION_GATEWAY_HOST must not be empty");
  }

  return {
    host,
    port: parsePort(environment.PROJECTION_GATEWAY_PORT),
    allowedOrigin: parseExactOrigin(environment.STAGE_ORIGIN),
  };
}
