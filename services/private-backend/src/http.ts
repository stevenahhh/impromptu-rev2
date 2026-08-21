import type { PrivateDeckContext } from "@impromptu/contracts/private";
import type { PublishedDeckArtifact } from "@impromptu/contracts/public";
import type { RecommendationOutcome } from "@impromptu/contracts/retrieval";
import type { AccountDirectory } from "./account-directory.ts";
import {
  AUDIO_CAPTURE_COOKIE_NAME,
  type AudioIngestService,
  MAX_AUDIO_FRAME_BYTES,
} from "./audio-ingest.ts";
import type { ExactOrigin, PrivateBackendConfig } from "./config.ts";
import { type ParsedDeckMultipart, parseDeckUploadMultipart } from "./deck-upload-multipart.ts";
import { DeckUploadRejectedError } from "./deck-upload-service.ts";
import { type DeckUploadRejectionCode, DeckUploadWorkerError } from "./deck-upload-worker.ts";
import { httpOutcome, type JsonLogger, type MetricsRegistry } from "./observability.ts";
import { createPreparedDeckArtifacts } from "./prepared-deck-upload.ts";
import type { PreparedEvidenceCoordinator } from "./prepared-evidence.ts";
import { clientIpKey, hashRateLimitKey, type RateLimiter } from "./rate-limit.ts";
import { renderedDeckArtifacts } from "./rendered-deck-artifacts.ts";
import type { SessionReportReadRouteHandler } from "./report/http.ts";

export type PrivateBackendHandler = (request: Request) => Response | Promise<Response>;

export interface AccountIdentityVerifier {
  verifyCredentials(
    username: string,
    password: string,
  ): Promise<{
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
  readonly presentationSessionEpoch: string;
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
  readonly audio?: AudioIngestService;
  /** Optional so deployments can explicitly leave public account creation disabled. */
  readonly accountRegistrar?: Pick<AccountDirectory, "register">;
  readonly internalAuthToken: string;
  readonly now: () => number;
  readonly recommendations?: {
    recommend(accountSessionId: string, input: unknown): Promise<RecommendationOutcome>;
  };
  readonly sessionReportRead?: SessionReportReadRouteHandler;
  readonly persist?: () => Promise<void>;
  readonly uploads?: DeckUploadService;
  readonly logger?: JsonLogger;
  readonly metrics?: MetricsRegistry;
  readonly readiness?: {
    check(): Promise<
      Readonly<{ outcome: "READY" }> | Readonly<{ outcome: "NOT_READY"; reason: string }>
    >;
  };
  readonly loginRateLimiters?: Readonly<{
    account: RateLimiter;
    ip: RateLimiter;
  }>;
}

function json(body: unknown, status: number, headers?: Headers): Response {
  const responseHeaders = headers ?? new Headers();
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("content-type", "application/json; charset=utf-8");

  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
    },
  });
}

function rateLimited(
  reason: "ACCOUNT_RATE_LIMITED" | "IP_RATE_LIMITED",
  retryAfterMs: number,
  headers: Headers,
): Response {
  headers.set("retry-after", String(Math.max(1, Math.ceil(retryAfterMs / 1_000))));
  return json({ outcome: "REJECTED", reason, retryAfterMs }, 429, headers);
}

const responseOutcomes = new WeakMap<Response, string>();

function metricPath(path: string): string {
  return path;
}

function observeResponseOutcome(response: Response, outcome: string): Response {
  responseOutcomes.set(response, outcome);
  return response;
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
  headers.set("access-control-allow-methods", "GET, POST, DELETE");
  headers.set(
    "access-control-allow-headers",
    "content-type, x-audio-duration-ms, x-audio-sequence, x-csrf-token",
  );
  headers.set("vary", "Origin");
  return headers;
}

function accountCookieName(allowedOrigin: ExactOrigin): "__Host-account" | "account" {
  return new URL(allowedOrigin).protocol === "https:" ? "__Host-account" : "account";
}

function accountCookieAttributes(allowedOrigin: ExactOrigin): string {
  const secure = new URL(allowedOrigin).protocol === "https:" ? "; Secure" : "";
  return `Path=/; HttpOnly${secure}; SameSite=Strict`;
}

function namedCookie(request: Request, expectedName: string): string | null {
  const cookie = request.headers.get("cookie");
  if (cookie === null) return null;
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === expectedName) return value.join("=") || null;
  }
  return null;
}

function accountCookie(request: Request, allowedOrigin: ExactOrigin): string | null {
  return namedCookie(request, accountCookieName(allowedOrigin));
}

function captureCookie(request: Request): string | null {
  return namedCookie(request, AUDIO_CAPTURE_COOKIE_NAME);
}

function captureCookieAttributes(): string {
  return "Path=/; HttpOnly; Secure; SameSite=Strict";
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

type AudioFrameBody =
  | Readonly<{ outcome: "READ"; bytes: Uint8Array }>
  | Readonly<{ outcome: "REJECTED"; reason: "EMPTY_FRAME" | "FRAME_TOO_LARGE" }>;

async function readAudioFrame(request: Request): Promise<AudioFrameBody> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) return { outcome: "REJECTED", reason: "FRAME_TOO_LARGE" };
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength > MAX_AUDIO_FRAME_BYTES) {
      return { outcome: "REJECTED", reason: "FRAME_TOO_LARGE" };
    }
  }
  if (request.body === null) return { outcome: "REJECTED", reason: "EMPTY_FRAME" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    byteLength += item.value.byteLength;
    if (byteLength > MAX_AUDIO_FRAME_BYTES) {
      await reader.cancel("audio frame exceeds memory boundary");
      return { outcome: "REJECTED", reason: "FRAME_TOO_LARGE" };
    }
    chunks.push(item.value);
  }
  if (byteLength === 0) return { outcome: "REJECTED", reason: "EMPTY_FRAME" };
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { outcome: "READ", bytes };
}

function boundedAudioHeader(request: Request, name: string, maximum: number): number | null {
  const value = request.headers.get(name);
  if (value === null || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
}

function audioRejection(reason: string, headers: Headers): Response {
  const status =
    reason === "CAPTURE_GRANT_REQUIRED" ? 401 : reason === "GRANT_SESSION_MISMATCH" ? 403 : 409;
  return json({ error: reason }, status, headers);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function accountCredentials(
  value: unknown,
): { readonly username: string; readonly password: string } | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    typeof value.username !== "string" ||
    typeof value.password !== "string"
  ) {
    return null;
  }
  return { username: value.username, password: value.password };
}

function isMultipartFormData(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "multipart/form-data";
}

async function controllerEventStream(
  coordinator: PreparedEvidenceCoordinator,
  accountSessionId: string,
  presentationSessionId: string,
  nowMs: number,
  headers: Headers,
  metrics?: MetricsRegistry,
): Promise<Response> {
  let cancelled = false;
  let measured = false;
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const finish = () => {
    if (measured) metrics?.addRealtimeConnections(-1);
    measured = false;
  };
  const connected = await coordinator.connectPlaybackController(
    accountSessionId,
    presentationSessionId,
    nowMs,
    (reason) => {
      finish();
      if (!cancelled && streamController !== null) {
        streamController.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ kind: "CLOSE", payload: { reason } })}\n\n`,
          ),
        );
        streamController.close();
      }
    },
  );
  if (connected.outcome === "APPLIED") {
    measured = true;
    metrics?.addRealtimeConnections(1);
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      if (connected.outcome === "REJECTED") {
        controller.error(new Error(connected.reason));
        return;
      }
      controller.enqueue(new TextEncoder().encode(": ready\n\n"));
    },
    cancel() {
      cancelled = true;
      if (connected.outcome === "APPLIED") connected.value.close();
      finish();
    },
  });
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(body, { status: connected.outcome === "REJECTED" ? 409 : 200, headers });
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
  const handle = async (request: Request): Promise<Response> => {
    const origin = browserOriginHeaders(request, config.allowedOrigin);
    if (origin instanceof Response) return origin;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: origin });

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ service: "private-backend", status: "ok" }, 200, origin);
    }
    if (dependencies === undefined) {
      return url.pathname === "/readyz"
        ? json({ outcome: "NOT_READY", reason: "DEPENDENCIES_UNAVAILABLE" }, 503, origin)
        : json({ error: "not_found" }, 404, origin);
    }
    if (request.method === "GET" && url.pathname === "/metrics") {
      if (request.headers.get("authorization") !== `Bearer ${dependencies.internalAuthToken}`) {
        return json({ error: "internal_unauthorized" }, 401);
      }
      return text(dependencies.metrics?.render() ?? "", 200);
    }
    if (request.method === "GET" && url.pathname === "/readyz") {
      if (dependencies.readiness === undefined) {
        return json({ outcome: "NOT_READY", reason: "DEPENDENCY_CHECK_UNAVAILABLE" }, 503, origin);
      }
      try {
        const readiness = await dependencies.readiness.check();
        return json(readiness, readiness.outcome === "READY" ? 200 : 503, origin);
      } catch {
        return json({ outcome: "NOT_READY", reason: "DEPENDENCY_CHECK_FAILED" }, 503, origin);
      }
    }

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

    if (request.method === "POST" && url.pathname === "/v1/accounts") {
      if (dependencies.accountRegistrar === undefined) {
        return json({ error: "account_registration_unavailable" }, 501, origin);
      }
      const credentials = accountCredentials(await requestBody(request));
      if (credentials === null) return json({ error: "invalid_request" }, 400, origin);
      const registration = await dependencies.accountRegistrar.register(
        credentials,
        dependencies.now(),
      );
      if (registration.outcome === "APPLIED") {
        return json({ account: { accountId: registration.value.accountId } }, 201, origin);
      }
      return json(
        { error: registration.reason },
        registration.reason === "USERNAME_TAKEN" ? 409 : 400,
        origin,
      );
    }

    if (request.method === "POST" && url.pathname === "/v1/account-sessions") {
      const credentials = accountCredentials(await requestBody(request));
      if (credentials === null) return json({ error: "invalid_request" }, 400, origin);
      if (dependencies.loginRateLimiters !== undefined) {
        const accountDecision = dependencies.loginRateLimiters.account.consume(
          hashRateLimitKey(`account:${credentials.username.trim().toLowerCase()}`),
        );
        if (accountDecision.outcome === "REJECTED") {
          return rateLimited("ACCOUNT_RATE_LIMITED", accountDecision.retryAfterMs, origin);
        }
        const ipDecision = dependencies.loginRateLimiters.ip.consume(clientIpKey(request));
        if (ipDecision.outcome === "REJECTED") {
          return rateLimited("IP_RATE_LIMITED", ipDecision.retryAfterMs, origin);
        }
      }
      const identity = await dependencies.identityVerifier.verifyCredentials(
        credentials.username,
        credentials.password,
      );
      if (identity === null) return json({ error: "authentication_failed" }, 401, origin);
      const session = await dependencies.coordinator.createAccountSession(
        identity,
        dependencies.now(),
      );
      const sessionCsrfToken = csrfToken(dependencies.internalAuthToken, session.accountSessionId);
      await dependencies.persist?.();
      const cookieName = accountCookieName(config.allowedOrigin);
      const cookieAttributes = accountCookieAttributes(config.allowedOrigin);
      origin.append(
        "set-cookie",
        `${cookieName}=${session.accountSessionId}; ${cookieAttributes}; Max-Age=${Math.max(0, Math.floor((session.expiresAtMs - dependencies.now()) / 1_000))}`,
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

    const accountSessionId = accountCookie(request, config.allowedOrigin);
    if (accountSessionId === null) return json({ error: "account_session_required" }, 401, origin);
    const account = await dependencies.coordinator.readAccountSession(
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

    const reportResponse = await dependencies.sessionReportRead?.(request, account.value.accountId);
    if (reportResponse !== undefined && reportResponse !== null) return reportResponse;

    if (url.pathname.startsWith("/v1/audio/") && dependencies.audio === undefined) {
      return json({ error: "audio_ingest_unavailable" }, 503, origin);
    }

    if (request.method === "POST" && url.pathname === "/v1/audio/grants") {
      const result = dependencies.audio?.issueGrant(
        accountSessionId,
        account.value.accountId,
        account.value.actorId,
        await requestBody(request),
        dependencies.now(),
      );
      if (result === undefined) return json({ error: "audio_ingest_unavailable" }, 503, origin);
      if (result.outcome === "REJECTED") {
        return json(
          { error: result.reason },
          result.reason === "ACTOR_MISMATCH" ? 403 : 400,
          origin,
        );
      }
      origin.append(
        "set-cookie",
        `${AUDIO_CAPTURE_COOKIE_NAME}=${result.grantId}; ${captureCookieAttributes()}; Max-Age=${Math.max(0, Math.floor((result.expiresAtMs - dependencies.now()) / 1_000))}`,
      );
      return json(
        { mimeType: "audio/webm;codecs=opus", expiresAtMs: result.expiresAtMs },
        201,
        origin,
      );
    }

    if (request.method === "GET" && url.pathname === "/v1/audio/events") {
      const grantId = captureCookie(request);
      if (grantId === null) return json({ error: "capture_grant_required" }, 401, origin);
      const opened = dependencies.audio?.openEvents(accountSessionId, grantId, dependencies.now());
      if (opened === undefined) return json({ error: "audio_ingest_unavailable" }, 503, origin);
      if (opened.outcome === "REJECTED") return audioRejection(opened.reason, origin);
      origin.set("content-type", "text/event-stream; charset=utf-8");
      origin.set("cache-control", "no-store");
      origin.set("x-accel-buffering", "no");
      return new Response(opened.stream, { status: 200, headers: origin });
    }

    if (request.method === "POST" && url.pathname === "/v1/audio/stream/start") {
      const grantId = captureCookie(request);
      if (grantId === null) return json({ error: "capture_grant_required" }, 401, origin);
      const started = dependencies.audio?.startStream(
        accountSessionId,
        grantId,
        dependencies.now(),
      );
      if (started === undefined) return json({ error: "audio_ingest_unavailable" }, 503, origin);
      return started.outcome === "STARTED"
        ? json({ status: "started" }, 202, origin)
        : audioRejection(started.reason, origin);
    }

    if (request.method === "POST" && url.pathname === "/v1/audio/frames") {
      const grantId = captureCookie(request);
      if (grantId === null) return json({ error: "capture_grant_required" }, 401, origin);
      const authorized = dependencies.audio?.authorizeFrame(
        accountSessionId,
        grantId,
        dependencies.now(),
      );
      if (authorized === undefined) return json({ error: "audio_ingest_unavailable" }, 503, origin);
      if (authorized.outcome === "REJECTED") return audioRejection(authorized.reason, origin);
      if (request.headers.get("content-type")?.toLowerCase() !== "application/octet-stream") {
        return json({ error: "unsupported_content_type" }, 415, origin);
      }
      const sequence = boundedAudioHeader(request, "x-audio-sequence", Number.MAX_SAFE_INTEGER);
      const durationMs = boundedAudioHeader(request, "x-audio-duration-ms", 30_000);
      if (sequence === null || durationMs === null) {
        return json({ error: "invalid_audio_frame_headers" }, 400, origin);
      }
      const frame = await readAudioFrame(request);
      if (frame.outcome === "REJECTED") {
        return json(
          { error: frame.reason },
          frame.reason === "FRAME_TOO_LARGE" ? 413 : 400,
          origin,
        );
      }
      const accepted = dependencies.audio?.pushFrame(
        accountSessionId,
        grantId,
        sequence,
        frame.bytes,
        durationMs,
        dependencies.now(),
      );
      if (accepted === undefined) return json({ error: "audio_ingest_unavailable" }, 503, origin);
      return accepted.outcome === "ACCEPTED"
        ? json({ status: "accepted" }, 202, origin)
        : audioRejection(accepted.reason, origin);
    }

    if (request.method === "POST" && url.pathname === "/v1/audio/stream/stop") {
      const grantId = captureCookie(request);
      if (grantId === null) return json({ error: "capture_grant_required" }, 401, origin);
      const stopped = dependencies.audio?.stopStream(accountSessionId, grantId, dependencies.now());
      if (stopped === undefined) return json({ error: "audio_ingest_unavailable" }, 503, origin);
      return stopped.outcome === "STOPPED"
        ? json({ status: "stopped" }, 202, origin)
        : audioRejection(stopped.reason, origin);
    }

    if (request.method === "DELETE" && url.pathname === "/v1/audio/grant") {
      const grantId = captureCookie(request);
      if (grantId === null) return json({ error: "capture_grant_required" }, 401, origin);
      const revoked = dependencies.audio?.revokeGrant(
        accountSessionId,
        grantId,
        dependencies.now(),
      );
      origin.append(
        "set-cookie",
        `${AUDIO_CAPTURE_COOKIE_NAME}=; ${captureCookieAttributes()}; Max-Age=0`,
      );
      if (revoked === undefined) return json({ error: "audio_ingest_unavailable" }, 503, origin);
      return revoked.outcome === "REVOKED"
        ? json({ status: "revoked" }, 200, origin)
        : audioRejection(revoked.reason, origin);
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/v1/publications/approve" || url.pathname === "/v1/publications/terminate")
    ) {
      return json({ error: "stage_cards_disabled" }, 410, origin);
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
        : await controllerEventStream(
            dependencies.coordinator,
            accountSessionId,
            presentationSessionId,
            dependencies.now(),
            origin,
            dependencies.metrics,
          );
    }
    if (request.method === "GET" && url.pathname === "/v1/publications/live-candidates") {
      const presentationSessionId = url.searchParams.get("presentationSessionId");
      if (presentationSessionId === null) {
        return json({ error: "presentation_session_required" }, 400, origin);
      }
      const result = await dependencies.coordinator.readLiveCandidateSnapshot(
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
      dependencies.audio?.accountLoggedOut(
        accountSessionId,
        account.value.actorId,
        dependencies.now(),
      );
      const result = await dependencies.coordinator.revokeAccountSession(
        accountSessionId,
        dependencies.now(),
      );
      if (result.outcome === "APPLIED") await dependencies.persist?.();
      const cookieName = accountCookieName(config.allowedOrigin);
      const cookieAttributes = accountCookieAttributes(config.allowedOrigin);
      origin.append("set-cookie", `${cookieName}=; ${cookieAttributes}; Max-Age=0`);
      origin.append(
        "set-cookie",
        `${AUDIO_CAPTURE_COOKIE_NAME}=; ${captureCookieAttributes()}; Max-Age=0`,
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
        if (rejection instanceof DeckUploadWorkerError && rejection.code === "ocr_unavailable") {
          return json({ error: "OCR_UNAVAILABLE" }, 422, origin);
        }
        return json({ error: "deck_upload_rejected" }, 400, origin);
      }
      const presentation = await dependencies.coordinator.createPresentation(
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
          presentationSessionEpoch: presentation.value.lifecycle.presentationSessionEpoch,
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
      const recommendation = await dependencies.recommendations.recommend(accountSessionId, body);
      const outcome =
        recommendation.outcome === "ABSTAIN"
          ? `${recommendation.outcome}:${recommendation.reason}`
          : recommendation.outcome;
      return observeResponseOutcome(json(recommendation, 200, origin), outcome);
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
      const result = await dependencies.coordinator.createPresentation(
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
      const result = await dependencies.coordinator.takeoverPlaybackLease(
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
      const result = await dependencies.coordinator.addCuratedCandidate(
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
      const result = await dependencies.coordinator.approvePublicationTeammate(
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

    return json({ error: "not_found" }, 404, origin);
  };

  return async (request) => {
    const startedAtMs = dependencies?.now() ?? Date.now();
    const path = metricPath(new URL(request.url).pathname);
    const suppliedRequestId = request.headers.get("x-request-id");
    const requestId =
      suppliedRequestId !== null && /^[A-Za-z0-9._:-]{1,128}$/.test(suppliedRequestId)
        ? suppliedRequestId
        : crypto.randomUUID();
    let response: Response;
    try {
      response = await handle(request);
    } catch (error) {
      dependencies?.logger?.error({
        requestId,
        path,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      response = json({ error: "internal_error" }, 500);
    }
    response.headers.set("x-request-id", requestId);
    const durationMs = Math.max(0, (dependencies?.now() ?? Date.now()) - startedAtMs);
    const outcome = responseOutcomes.get(response) ?? httpOutcome(response.status);
    dependencies?.metrics?.observeHttp(request.method, path, response.status, durationMs, outcome);
    dependencies?.logger?.request({
      requestId,
      method: request.method,
      path,
      status: response.status,
      durationMs,
      outcome,
    });
    return response;
  };
}
