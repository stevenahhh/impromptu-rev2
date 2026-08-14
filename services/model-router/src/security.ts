import type { TrustedModelContext } from "./context.ts";
import { ModelRouterError } from "./errors.ts";
import {
  type ProviderTransport,
  type ProviderTransportResponse,
  providerTransportRequestSchema,
  providerTransportResponseSchema,
} from "./ports.ts";

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
  authorize(request: ExactEgressRequest, context: TrustedModelContext): Promise<ExactEgressGrant>;
}

export interface ProviderEgressTransportRequest {
  readonly adapterId: string;
  readonly url: string;
  readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly credential: string;
  readonly signal: AbortSignal;
}

export interface ProviderEgressTransport {
  send(request: ProviderEgressTransportRequest): Promise<ProviderTransportResponse>;
}

export interface PolicyMediatedTransportOptions {
  readonly adapterId: string;
  readonly origin: string;
  readonly credential: string;
  readonly context: TrustedModelContext;
  readonly signal: AbortSignal;
  readonly egressPolicy: ExactEgressPolicy;
  readonly providerTransport: ProviderEgressTransport;
  readonly checkpoint: () => void;
}

export class StaticExactEgressPolicy implements ExactEgressPolicy {
  readonly #allowed = new Set<string>();

  constructor(allowed: readonly ExactEgressRequest[]) {
    for (const entry of allowed) {
      this.#allowed.add(key(entry.adapterId, parseExactHttpsOrigin(entry.origin)));
    }
  }

  async authorize(
    request: ExactEgressRequest,
    _context: TrustedModelContext,
  ): Promise<ExactEgressGrant> {
    let origin: string;
    try {
      origin = parseExactHttpsOrigin(request.origin);
    } catch {
      throw denied(request.adapterId);
    }
    if (!this.#allowed.has(key(request.adapterId, origin))) throw denied(request.adapterId);
    return Object.freeze({ adapterId: request.adapterId, origin });
  }
}

export function createPolicyMediatedTransport(
  options: PolicyMediatedTransportOptions,
): ProviderTransport {
  return Object.freeze({
    async request(untrustedRequest: unknown): Promise<ProviderTransportResponse> {
      options.checkpoint();
      const request = providerTransportRequestSchema.parse(untrustedRequest);
      assertSafeAdapterHeaders(request.headers ?? {});
      const url = resolveProviderUrl(options.origin, request.path, options.adapterId);
      try {
        await options.egressPolicy.authorize(
          { adapterId: options.adapterId, origin: options.origin },
          options.context,
        );
      } catch (caught) {
        if (caught instanceof ModelRouterError) throw caught;
        throw denied(options.adapterId);
      }
      options.checkpoint();
      let response: ProviderTransportResponse;
      try {
        response = await options.providerTransport.send({
          adapterId: options.adapterId,
          url,
          method: request.method,
          headers: Object.freeze({ ...(request.headers ?? {}) }),
          ...(request.body === undefined ? {} : { body: request.body.slice() }),
          credential: options.credential,
          signal: options.signal,
        });
      } catch (caught) {
        if (caught instanceof ModelRouterError) throw caught;
        throw new ModelRouterError("transport_error", "Provider transport failed", true);
      }
      options.checkpoint();
      const parsed = providerTransportResponseSchema.parse(response);
      return Object.freeze({
        status: parsed.status,
        headers: Object.freeze({ ...parsed.headers }),
        body: parsed.body.slice(),
      });
    },
  });
}

function resolveProviderUrl(origin: string, path: string, adapterId: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) throw denied(adapterId);
  let url: URL;
  try {
    url = new URL(path, `${origin}/`);
  } catch {
    throw denied(adapterId);
  }
  if (url.origin !== origin || `${url.pathname}${url.search}${url.hash}` !== path) {
    throw denied(adapterId);
  }
  return url.href;
}

function assertSafeAdapterHeaders(headers: Readonly<Record<string, string>>): void {
  for (const name of Object.keys(headers)) {
    const normalized = name.toLowerCase();
    if (
      normalized === "authorization" ||
      normalized === "proxy-authorization" ||
      normalized === "x-api-key"
    ) {
      throw new ModelRouterError(
        "policy_denied",
        "Provider credentials are applied only by the egress transport",
        false,
      );
    }
  }
}

function denied(adapterId: string): ModelRouterError {
  return new ModelRouterError(
    "policy_denied",
    `Egress is not allowed for adapter ${adapterId}`,
    false,
  );
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
