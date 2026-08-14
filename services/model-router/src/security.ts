import type { TrustedModelContext } from "./context.ts";
import { ModelRouterError } from "./errors.ts";

export interface SecretMaterial {
  readonly value: string;
}

export interface SecretStore {
  read(secretId: string, context: TrustedModelContext): Promise<SecretMaterial>;
}

export interface ExactEgressRequest {
  readonly adapterId: string;
  readonly origin: string;
}

export interface ExactEgressGrant extends ExactEgressRequest {}

export interface ExactEgressPolicy {
  authorize(request: ExactEgressRequest, context: TrustedModelContext): ExactEgressGrant;
}

export class StaticExactEgressPolicy implements ExactEgressPolicy {
  readonly #allowed = new Set<string>();

  constructor(allowed: readonly ExactEgressRequest[]) {
    for (const entry of allowed) {
      this.#allowed.add(key(entry.adapterId, parseExactHttpsOrigin(entry.origin)));
    }
  }

  authorize(request: ExactEgressRequest, _context: TrustedModelContext): ExactEgressGrant {
    let origin: string;
    try {
      origin = parseExactHttpsOrigin(request.origin);
    } catch {
      throw new ModelRouterError(
        "policy_denied",
        `Egress is not allowed for adapter ${request.adapterId}`,
        false,
      );
    }
    if (!this.#allowed.has(key(request.adapterId, origin))) {
      throw new ModelRouterError(
        "policy_denied",
        `Egress is not allowed for adapter ${request.adapterId}`,
        false,
      );
    }
    return Object.freeze({ adapterId: request.adapterId, origin });
  }
}

function parseExactHttpsOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Egress entries must be an exact URL origin");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.includes("*") ||
    value !== url.origin ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new TypeError("Egress entries must be an exact URL origin");
  }
  return url.origin;
}

function key(adapterId: string, origin: string): string {
  return `${adapterId}\u0000${origin}`;
}
