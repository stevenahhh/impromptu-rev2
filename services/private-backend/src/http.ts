import type { PrivateDeckContext } from "@impromptu/contracts/private";
import type { PublishedDeckArtifact } from "@impromptu/contracts/public";
import type { RecommendationOutcome } from "@impromptu/contracts/retrieval";
import type { ExactOrigin, PrivateBackendConfig } from "./config.ts";
import { type ParsedDeckMultipart, parseDeckUploadMultipart } from "./deck-upload-multipart.ts";
import { DeckUploadRejectedError } from "./deck-upload-service.ts";
import type { DeckUploadRejectionCode } from "./deck-upload-worker.ts";
import { createPreparedDeckArtifacts } from "./prepared-deck-upload.ts";
import type { ControllerSocket, PreparedEvidenceCoordinator } from "./prepared-evidence.ts";
import { renderedDeckArtifacts } from "./rendered-deck-artifacts.ts";

export type PrivateBackendHandler = (request: Request) => Response | Promise<Response>;

export interface AccountIdentityVerifier {
  exchangeAuthorizationCode(code: string): Promise<{
    readonly accountId: string;
    readonly actorId: string;
  } | null>;
}

export type DeckUploadContentType =
  | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  | "application/pdf";

export interface RawDeckUpload {
  readonly filename: string;
  readonly contentType: DeckUploadContentType;
  readonly byteLength?: number;
  readonly body: ReadableStream<Uint8Array>;
}

export interface DeckUploadReceipt {
  readonly privateDeck: PrivateDeckContext;
  readonly publicDeck: PublishedDeckArtifact;
  readonly sourceHash: string;
}

export interface DeckUploadAccepted extends DeckUploadReceipt {
  readonly presentationSessionId: string;
  readonly deckVersion: string;
}

export type DeckUploadRejectedResponse = Readonly<{
  error: "deck_upload_rejected";
  code: DeckUploadRejectionCode;
}>;

const DECK_UPLOAD_REJECTION_STATUS = {
  empty_input: 400,
  unsupported_extension: 400,
  malformed_input: 400,
  input_too_large: 413,
  unsafe_filename: 400,
  size_mismatch: 400,
} as const satisfies Record<DeckUploadRejectionCode, 400 | 413>;

export interface DeckUploadService {
  acceptRawDeck(input: {
    readonly accountId: string;
    readonly actorId: string;
    readonly upload: RawDeckUpload;
  }): Promise<DeckUploadReceipt>;
}

export interface PrivateBackendHttpDependencies {
  readonly coordinator: PreparedEvidenceCoordinator;
  readonly identityVerifier: AccountIdentityVerifier;
  readonly internalAuthToken: string;
  readonly now: () => number;
  readonly recommendations?: {
    recommend(accountSessionId: string, input: unknown): Promise<RecommendationOutcome>;
  };
  readonly persist?: () => Promise<void>;
  readonly uploads?: DeckUploadService;
}

function json(body: unknown, status: number, headers?: Headers): Response {
  const responseHeaders = headers ?? new Headers();
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("content-type", "application/json; charset=utf-8");

  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

function deckUploadRejected(code: DeckUploadRejectionCode, headers: Headers): Response {
  return json(
    { error: "deck_upload_rejected", code } satisfies DeckUploadRejectedResponse,
    DECK_UPLOAD_REJECTION_STATUS[code],
    headers,
  );
}

function browserOriginHeaders(request: Request, allowedOrigin: ExactOrigin): Headers | Response {
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin === null) {
    return new Headers();
  }

  if (requestOrigin !== allowedOrigin) {
    return json({ error: "origin_forbidden" }, 403);
  }

  const headers = new Headers();
  headers.set("access-control-allow-origin", allowedOrigin);
  headers.set("access-control-allow-credentials", "true");
  headers.set("vary", "Origin");
  return headers;
}

function accountCookie(request: Request): string | null {
  const cookie = request.headers.get("cookie");
  if (cookie === null) return null;
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === "__Host-account") return value.join("=") || null;
  }
  return null;
}

function mutationAllowed(request: Request, allowedOrigin: ExactOrigin): boolean {
  if (request.headers.get("origin") !== allowedOrigin) return false;
  const referer = request.headers.get("referer");
  if (referer === null) return false;
  try {
    return new URL(referer).origin === allowedOrigin;
  } catch {
    return false;
  }
}

async function requestBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMultipartFormData(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "multipart/form-data";
}

function controllerEventStream(
  coordinator: PreparedEvidenceCoordinator,
  accountSessionId: string,
  presentationSessionId: string,
  nowMs: number,
  headers: Headers,
): Response {
  let socket: ControllerSocket | null = null;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const connected = coordinator.connectPlaybackController(
        accountSessionId,
        presentationSessionId,
        nowMs,
        (reason) => {
          if (!cancelled) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ kind: "CLOSE", payload: { reason } })}\n\n`,
              ),
            );
            controller.close();
          }
        },
      );
      if (connected.outcome === "REJECTED") {
        controller.error(new Error(connected.reason));
        return;
      }
      socket = connected.value;
      controller.enqueue(new TextEncoder().encode(": ready\n\n"));
    },
    cancel() {
      cancelled = true;
      socket?.close();
    },
  });
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(body, { status: socket === null ? 409 : 200, headers });
}

function csrfToken(internalAuthToken: string, accountSessionId: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(`account-csrf:${internalAuthToken}:${accountSessionId}`)
    .digest("hex")
    .slice(0, 48);
}

export function createPrivateBackendHandler(
  config: PrivateBackendConfig,
  dependencies?: PrivateBackendHttpDependencies,
): PrivateBackendHandler {
  return async (request) => {
    const origin = browserOriginHeaders(request, config.allowedOrigin);
    if (origin instanceof Response) return origin;

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ service: "private-backend", status: "ok" }, 200, origin);
    }
    if (dependencies === undefined) return json({ error: "not_found" }, 404, origin);

    if (request.method === "POST" && url.pathname === "/internal/stage-applied") {
      if (request.headers.get("authorization") !== `Bearer ${dependencies.internalAuthToken}`) {
        return json({ error: "internal_unauthorized" }, 401);
      }
      const body = await requestBody(request);
      if (!isRecord(body)) return json({ error: "invalid_request" }, 400);
      const result = await dependencies.coordinator.recordStageApplied({
        audienceDisplaySessionId: String(body.audienceDisplaySessionId ?? ""),
        commandId: String(body.commandId ?? ""),
        displayBindingEpoch: String(body.displayBindingEpoch ?? ""),
      });
      if (result.outcome === "APPLIED") await dependencies.persist?.();
      return json(
        result.outcome === "APPLIED" ? result.value : { error: result.reason },
        result.outcome === "APPLIED" ? 200 : 409,
      );
    }

    if (request.method !== "GET" && !mutationAllowed(request, config.allowedOrigin)) {
      return json({ error: "mutation_origin_forbidden" }, 403, origin);
    }

    if (request.method === "POST" && url.pathname === "/v1/account-sessions") {
      const body = await requestBody(request);
      if (
        !isRecord(body) ||
        Object.keys(body).length !== 1 ||
        typeof body.authorizationCode !== "string"
      ) {
        return json({ error: "invalid_request" }, 400, origin);
      }
      const identity = await dependencies.identityVerifier.exchangeAuthorizationCode(
        body.authorizationCode,
      );
      if (identity === null) return json({ error: "authentication_failed" }, 401, origin);
      const session = dependencies.coordinator.createAccountSession(identity, dependencies.now());
      const sessionCsrfToken = csrfToken(dependencies.internalAuthToken, session.accountSessionId);
      await dependencies.persist?.();
      origin.append(
        "set-cookie",
        `__Host-account=${session.accountSessionId}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((session.expiresAtMs - dependencies.now()) / 1_000))}`,
      );
      return json(
        {
          account: { accountId: session.accountId, actorId: session.actorId },
          expiresAtMs: session.expiresAtMs,
          csrfToken: sessionCsrfToken,
        },
        201,
        origin,
      );
    }

    const accountSessionId = accountCookie(request);
    if (accountSessionId === null) return json({ error: "account_session_required" }, 401, origin);
    const account = dependencies.coordinator.readAccountSession(
      accountSessionId,
      dependencies.now(),
    );
    if (account.outcome === "REJECTED") {
      return json({ error: account.reason }, 401, origin);
    }
    if (request.method !== "GET") {
      const expectedCsrf = csrfToken(dependencies.internalAuthToken, accountSessionId);
      if (request.headers.get("x-csrf-token") !== expectedCsrf) {
        return json({ error: "csrf_rejected" }, 403, origin);
      }
    }

    if (request.method === "GET" && url.pathname === "/v1/account-session") {
      return json(
        {
          account: { accountId: account.value.accountId, actorId: account.value.actorId },
          expiresAtMs: account.value.expiresAtMs,
          csrfToken: csrfToken(dependencies.internalAuthToken, accountSessionId),
        },
        200,
        origin,
      );
    }
    if (request.method === "GET" && url.pathname === "/v1/playback/controller-events") {
      const presentationSessionId = url.searchParams.get("presentationSessionId");
      return presentationSessionId === null
        ? json({ error: "presentation_session_required" }, 400, origin)
        : controllerEventStream(
            dependencies.coordinator,
            accountSessionId,
            presentationSessionId,
            dependencies.now(),
            origin,
          );
    }
    if (request.method === "GET" && url.pathname === "/v1/publications/live-candidates") {
      const presentationSessionId = url.searchParams.get("presentationSessionId");
      if (presentationSessionId === null) {
        return json({ error: "presentation_session_required" }, 400, origin);
      }
      const result = dependencies.coordinator.readLiveCandidateSnapshot(
        accountSessionId,
        presentationSessionId,
        dependencies.now(),
      );
      return json(
        result.outcome === "APPLIED" ? result.value : { error: result.reason },
        result.outcome === "APPLIED" ? 200 : 403,
        origin,
      );
    }
    if (request.method === "DELETE" && url.pathname === "/v1/account-session") {
      const result = dependencies.coordinator.revokeAccountSession(
        accountSessionId,
        dependencies.now(),
      );
      if (result.outcome === "APPLIED") await dependencies.persist?.();
      origin.append(
        "set-cookie",
        "__Host-account=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
      );
      return json(
        result.outcome === "APPLIED" ? { status: "revoked" } : { error: result.reason },
        result.outcome === "APPLIED" ? 200 : 401,
        origin,
      );
    }

    if (request.method === "POST" && url.pathname === "/v1/deck-uploads") {
      if (dependencies.uploads === undefined) {
        return json({ error: "uploads_unavailable" }, 503, origin);
      }
      if (!isMultipartFormData(request.headers.get("content-type"))) {
        return json({ error: "unsupported_content_type" }, 400, origin);
      }
      let parsed: ParsedDeckMultipart | undefined;
      let receipt: DeckUploadReceipt;
      try {
        parsed = await parseDeckUploadMultipart(request);
        receipt = await dependencies.uploads.acceptRawDeck({
          accountId: account.value.accountId,
          actorId: account.value.actorId,
          upload: parsed.upload,
        });
        await parsed.finished;
      } catch (error) {
        let rejection = error;
        if (parsed !== undefined) {
          await parsed.cancel(error);
          try {
            await parsed.finished;
          } catch (parserError) {
            if (
              parserError instanceof DeckUploadRejectedError &&
              (!(rejection instanceof DeckUploadRejectedError) ||
                parserError.code === "input_too_large")
            ) {
              rejection = parserError;
            }
          }
        }
        if (rejection instanceof DeckUploadRejectedError) {
          return deckUploadRejected(rejection.code, origin);
        }
        return json({ error: "deck_upload_rejected" }, 400, origin);
      }
      const presentation = dependencies.coordinator.createPresentation(
        accountSessionId,
        { privateDeck: receipt.privateDeck, publicDeck: receipt.publicDeck },
        dependencies.now(),
      );
      if (presentation.outcome === "REJECTED") {
        return json({ error: presentation.reason }, 400, origin);
      }
      await dependencies.persist?.();
      return json(
        {
          presentationSessionId: presentation.value.lifecycle.presentationSessionId,
          deckVersion: receipt.privateDeck.deckVersion,
          ...receipt,
        } satisfies DeckUploadAccepted,
        201,
        origin,
      );
    }

    const body = await requestBody(request);
    if (!isRecord(body)) return json({ error: "invalid_request" }, 400, origin);
    if (request.method === "POST" && url.pathname === "/v1/recommendations") {
      if (dependencies.recommendations === undefined) {
        return json({ error: "recommendations_unavailable" }, 503, origin);
      }
      return json(
        await dependencies.recommendations.recommend(accountSessionId, body),
        200,
        origin,
      );
    }
    if (request.method === "POST" && url.pathname === "/v1/candidates/live") {
      const result = await dependencies.coordinator.addLiveCandidate(
        accountSessionId,
        body,
        dependencies.now(),
      );
      if (result.outcome === "APPLIED") await dependencies.persist?.();
      return json(
        result.outcome === "APPLIED" ? result.value : { error: result.reason },
        result.outcome === "APPLIED" ? 201 : 409,
        origin,
      );
    }
    if (request.method === "POST" && url.pathname === "/v1/deck-artifacts") {
      if (typeof body.title !== "string") {
        return json({ error: "invalid_request" }, 400, origin);
      }
      try {
        if (body.renderManifest !== undefined || body.publicBaseUrl !== undefined) {
          return json(
            renderedDeckArtifacts(account.value.accountId, {
              title: body.title,
              manifest: body.renderManifest,
              publicBaseUrl: body.publicBaseUrl,
            }),
            201,
            origin,
          );
        }
        if (typeof body.content !== "string") {
          return json({ error: "invalid_request" }, 400, origin);
        }
        return json(
          createPreparedDeckArtifacts(account.value.accountId, {
            title: body.title,
            content: body.content,
          }),
          201,
          origin,
        );
      } catch {
        return json({ error: "invalid_deck_upload" }, 400, origin);
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/presentation-sessions") {
      const result = dependencies.coordinator.createPresentation(
        accountSessionId,
        { privateDeck: body.privateDeck, publicDeck: body.publicDeck },
        dependencies.now(),
      );
      if (result.outcome === "APPLIED") await dependencies.persist?.();
      return json(
        result.outcome === "APPLIED" ? result.value : { error: result.reason },
        result.outcome === "APPLIED" ? 201 : 409,
        origin,
      );
    }
    if (request.method === "POST" && url.pathname === "/v1/display-bindings") {
      const result = await dependencies.coordinator.approveDisplay(
        accountSessionId,
        body,
        dependencies.now(),
      );
      if (result.outcome === "APPLIED") await dependencies.persist?.();
      return json(
        result.outcome === "APPLIED" ? result.value : { error: result.reason },
        result.outcome === "APPLIED" ? 201 : 409,
        origin,
      );
    }
    if (request.method === "POST" && url.pathname === "/v1/playback/lease-takeover") {
      const result = dependencies.coordinator.takeoverPlaybackLease(
        accountSessionId,
        body,
        dependencies.now(),
      );
      if (result.outcome === "APPLIED") await dependencies.persist?.();
      return json(
        result.outcome === "APPLIED" ? result.value : { error: result.reason },
        result.outcome === "APPLIED" ? 200 : 409,
        origin,
      );
    }
    if (request.method === "POST" && url.pathname === "/v1/playback/slide-set") {
      const result = await dependencies.coordinator.setSlide(
        accountSessionId,
        {
          presentationSessionId: String(body.presentationSessionId ?? ""),
          commandId: String(body.commandId ?? ""),
          publicSlideKey: String(body.publicSlideKey ?? ""),
          displayBindingEpoch: String(body.displayBindingEpoch ?? ""),
          baseRevision: String(body.baseRevision ?? ""),
        },
        dependencies.now(),
      );
      if (result.outcome === "APPLIED") await dependencies.persist?.();
      return json(
        result.outcome === "APPLIED" ? result.value : { error: result.reason },
        result.outcome === "APPLIED" ? 202 : 409,
        origin,
      );
    }
    if (request.method === "POST" && url.pathname === "/v1/candidates/curated") {
      const result = dependencies.coordinator.addCuratedCandidate(
        accountSessionId,
        body,
        dependencies.now(),
      );
      if (result.outcome === "APPLIED") await dependencies.persist?.();
      return json(
        result.outcome === "APPLIED" ? result.value : { error: result.reason },
        result.outcome === "APPLIED" ? 201 : 409,
        origin,
      );
    }
    if (request.method === "POST" && url.pathname === "/v1/publications/teammates") {
      const result = dependencies.coordinator.approvePublicationTeammate(
        accountSessionId,
        String(body.presentationSessionId ?? ""),
        String(body.actorId ?? ""),
        dependencies.now(),
      );
      if (result.outcome === "APPLIED") await dependencies.persist?.();
      return json(
        result.outcome === "APPLIED" ? { status: "approved" } : { error: result.reason },
        result.outcome === "APPLIED" ? 200 : 403,
        origin,
      );
    }
    if (request.method === "POST" && url.pathname === "/v1/publications/approve") {
      const result = await dependencies.coordinator.approveCandidate(
        accountSessionId,
        {
          presentationSessionId: String(body.presentationSessionId ?? ""),
          candidateId: String(body.candidateId ?? ""),
          ...(typeof body.candidateVersion === "string"
            ? { candidateVersion: body.candidateVersion }
            : {}),
          expectedCandidateRevision: String(body.expectedCandidateRevision ?? ""),
          expectedPublicCardRevision: String(body.expectedPublicCardRevision ?? ""),
          authorityId: String(body.authorityId ?? ""),
          ...(typeof body.approvalId === "string" ? { approvalId: body.approvalId } : {}),
          ...(typeof body.authoritativeSnapshotHash === "string"
            ? { authoritativeSnapshotHash: body.authoritativeSnapshotHash }
            : {}),
          expiresAtMs: typeof body.expiresAtMs === "number" ? body.expiresAtMs : null,
        },
        dependencies.now(),
      );
      if (result.outcome === "APPLIED") await dependencies.persist?.();
      return json(
        result.outcome === "APPLIED" ? result.value : { error: result.reason },
        result.outcome === "APPLIED" ? 201 : 409,
        origin,
      );
    }
    if (request.method === "POST" && url.pathname === "/v1/publications/terminate") {
      const status = body.status;
      if (status !== "RETRACTED" && status !== "EXPIRED") {
        return json({ error: "invalid_request" }, 400, origin);
      }
      const result = await dependencies.coordinator.terminateCard(
        accountSessionId,
        {
          presentationSessionId: String(body.presentationSessionId ?? ""),
          projectionId: String(body.projectionId ?? ""),
          expectedPublicCardRevision: String(body.expectedPublicCardRevision ?? ""),
          authorityId: String(body.authorityId ?? ""),
          ...(typeof body.operationId === "string" ? { operationId: body.operationId } : {}),
          status,
        },
        dependencies.now(),
      );
      if (result.outcome === "APPLIED") await dependencies.persist?.();
      return json(
        result.outcome === "APPLIED" ? result.value : { error: result.reason },
        result.outcome === "APPLIED" ? 200 : 409,
        origin,
      );
    }

    return json({ error: "not_found" }, 404, origin);
  };
}
