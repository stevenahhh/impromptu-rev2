import type { ActorId } from "@impromptu/contracts/control";
import type { AccountId } from "@impromptu/contracts/private";
import type { PrivateBackendConfig } from "../config.ts";
import type { PrivateBackendHttpDependencies } from "./types.ts";

/**
 * Shared per-request inputs for the post-authentication route groups. Handlers return null to
 * decline a match so the pipeline can try the next group in the original dispatch order.
 */
export interface AuthedRouteContext {
  readonly request: Request;
  readonly url: URL;
  readonly origin: Headers;
  readonly config: PrivateBackendConfig;
  readonly dependencies: PrivateBackendHttpDependencies;
  readonly accountSessionId: string;
  readonly accountId: AccountId;
  readonly actorId: ActorId;
  readonly sessionExpiresAtMs: number;
}
