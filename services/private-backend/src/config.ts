export type Environment = Readonly<Record<string, string | undefined>>;

declare const exactOriginBrand: unique symbol;
export type ExactOrigin = string & { readonly [exactOriginBrand]: true };

export interface PrivateBackendConfig {
  readonly host: string;
  readonly port: number;
  readonly allowedOrigin: ExactOrigin;
}

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 3001;

function parsePort(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_PORT;
  }

  const port = Number(value);
  if (!/^[1-9]\d{0,4}$/.test(value) || port > 65_535) {
    throw new Error("PRIVATE_BACKEND_PORT must be an integer between 1 and 65535");
  }

  return port;
}

function parseExactOrigin(value: string | undefined): ExactOrigin {
  if (value === undefined || value.length === 0) {
    throw new Error("CONSOLE_ORIGIN is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("CONSOLE_ORIGIN must be an exact origin");
  }

  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== value) {
    throw new Error("CONSOLE_ORIGIN must be an exact origin");
  }

  return value as ExactOrigin;
}

export function parsePrivateBackendConfig(environment: Environment): PrivateBackendConfig {
  const host = environment.PRIVATE_BACKEND_HOST ?? DEFAULT_HOST;
  if (host.length === 0) {
    throw new Error("PRIVATE_BACKEND_HOST must not be empty");
  }
  if (/\s/.test(host)) {
    throw new Error("PRIVATE_BACKEND_HOST must not contain whitespace");
  }

  return {
    host,
    port: parsePort(environment.PRIVATE_BACKEND_PORT),
    allowedOrigin: parseExactOrigin(environment.CONSOLE_ORIGIN),
  };
}
