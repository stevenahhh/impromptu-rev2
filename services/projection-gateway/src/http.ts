import {
  type PublishedDeckArtifact,
  PublishedDeckArtifactSchema,
} from "@impromptu/contracts/public";
import type { ExactOrigin, ProjectionGatewayConfig } from "./config.ts";
import { httpOutcome, type JsonLogger, type MetricsRegistry } from "./observability.ts";
import type {
  PlaybackProjectionInput,
  PreparedEvidenceProjectionGateway,
  StageSocket,
} from "./prepared-evidence.ts";
import { clientIpKey, type RateLimiter } from "./rate-limit.ts";

export type ProjectionGatewayHandler = (request: Request) => Response | Promise<Response>;

// Public deck artifact containment contract.
//
// GET /v1/deck-assets/:artifactId/*artifactPath serves nested render outputs
// contained inside the deck store root as immutable bytes with the exact MIME
// type for the extension and Stage CORS headers.

export interface DeckAsset {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export type DeckAssetReadResult =
  | { readonly outcome: "FOUND"; readonly asset: DeckAsset }
  | { readonly outcome: "UNKNOWN" }
  | { readonly outcome: "ESCAPE" };

export interface DeckAssetReader {
  readonly read: (artifactId: string, artifactPath: string) => Promise<DeckAssetReadResult>;
}

interface DeckAssetFilesystem {
  readonly existsSync: (path: string) => boolean;
  readonly readFileSync: (path: string) => Uint8Array;
  readonly realpathSync: (path: string) => string;
}

function nodeDeckAssetFilesystem(): DeckAssetFilesystem {
  const filesystem = process.getBuiltinModule("node:fs");
  if (filesystem === undefined) {
    throw new Error("node:fs is unavailable");
  }
  return filesystem as unknown as DeckAssetFilesystem;
}

function contentTypeForDeckAsset(fileName: string): string | null {
  const normalized = fileName.toLowerCase();
  if (normalized.endsWith(".svg")) return "image/svg+xml";
  if (normalized.endsWith(".png")) return "image/png";
  if (normalized.endsWith(".woff2")) return "font/woff2";
  if (normalized.endsWith(".woff")) return "font/woff";
  if (normalized.endsWith(".ttf")) return "font/ttf";
  if (normalized.endsWith(".otf")) return "font/otf";
  return null;
}

function deckAssetJoin(root: string, part: string): string {
  return root + (root.endsWith("/") || root.endsWith("\\") ? "" : "/") + part;
}

export function createDeckAssetReader(root: string): DeckAssetReader {
  const filesystem = nodeDeckAssetFilesystem();
  const rootReal = filesystem.realpathSync(root);
  return {
    async read(artifactId, artifactPath) {
      const separator = process.platform === "win32" ? "\\" : "/";
      const pathSegments = artifactPath.split("/");
      if (
        artifactId === "" ||
        artifactId === "." ||
        artifactId === ".." ||
        artifactId.includes("/") ||
        artifactId.includes("\\") ||
        pathSegments.some(
          (segment) =>
            segment === "" || segment === "." || segment === ".." || segment.includes("\\"),
        )
      ) {
        return { outcome: "UNKNOWN" };
      }
      const artifactDir = deckAssetJoin(root, artifactId);
      if (!filesystem.existsSync(artifactDir)) return { outcome: "UNKNOWN" };
      const candidate = deckAssetJoin(artifactDir, artifactPath);
      if (!filesystem.existsSync(candidate)) return { outcome: "UNKNOWN" };
      let resolved: string;
      try {
        resolved = filesystem.realpathSync(candidate);
      } catch {
        return { outcome: "UNKNOWN" };
      }
      if (resolved !== rootReal && !resolved.startsWith(`${rootReal}${separator}`)) {
        return { outcome: "ESCAPE" };
      }
      const contentType = contentTypeForDeckAsset(artifactPath);
      if (contentType === null) return { outcome: "UNKNOWN" };
      try {
        return {
          outcome: "FOUND",
          asset: { bytes: filesystem.readFileSync(resolved), contentType },
        };
      } catch {
        return { outcome: "UNKNOWN" };
      }
    },
  };
}

export interface StageReceiptWriter {
  recordApplied(input: {
    readonly audienceDisplaySessionId: string;
    readonly commandId: string;
    readonly displayBindingEpoch: string;
  }): Promise<unknown | null>;
}

export interface ProjectionGatewayHttpDependencies {
  readonly gateway: PreparedEvidenceProjectionGateway;
  readonly internalAuthToken: string;
  readonly now: () => number;
  readonly stageReceiptWriter: StageReceiptWriter;
  readonly persist?: () => Promise<void>;
  readonly deckAssets?: DeckAssetReader;
  readonly logger?: JsonLogger;
  readonly metrics?: MetricsRegistry;
  readonly publicRateLimiter?: RateLimiter;
  readonly readiness?: {
    check(): Promise<
      Readonly<{ outcome: "READY" }> | Readonly<{ outcome: "NOT_READY"; reason: string }>
    >;
  };
}

function json(body: unknown, status: number, headers?: Headers): Response {
  const responseHeaders = headers ?? new Headers();
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("content-type", "application/json; charset=utf-8");

  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

const DECK_ASSET_PATH_PREFIX = "/v1/deck-assets/";

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
    },
  });
}

function metricPath(path: string): string {
  return path.startsWith(DECK_ASSET_PATH_PREFIX) ? `${DECK_ASSET_PATH_PREFIX}:artifact/*` : path;
}

function rateLimited(retryAfterMs: number, headers: Headers): Response {
  headers.set("retry-after", String(Math.max(1, Math.ceil(retryAfterMs / 1_000))));
  return json({ outcome: "REJECTED", reason: "IP_RATE_LIMITED", retryAfterMs }, 429, headers);
}

function isDeckAssetPathComponent(component: string): boolean {
  return (
    component !== "" &&
    component !== "." &&
    component !== ".." &&
    !component.includes("/") &&
    !component.includes("\\")
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
  headers.set("access-control-allow-methods", "GET, POST");
  headers.set("access-control-allow-headers", "content-type, x-csrf-token");
  headers.set("vary", "Origin");
  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function publicDeck(value: unknown): PublishedDeckArtifact | null {
  const parsed = PublishedDeckArtifactSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function playbackEvent(value: unknown): PlaybackProjectionInput | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "commandId",
      "displayBindingEpoch",
      "acceptedControlRevision",
      "occurrence",
      "blackout",
    ]) ||
    !isRecord(value.occurrence) ||
    !hasOnlyKeys(value.occurrence, ["publicSlideKey", "occurrenceSeq"])
  ) {
    return null;
  }
  return typeof value.commandId === "string" &&
    typeof value.displayBindingEpoch === "string" &&
    typeof value.acceptedControlRevision === "string" &&
    typeof value.occurrence.publicSlideKey === "string" &&
    typeof value.occurrence.occurrenceSeq === "number" &&
    typeof value.blackout === "boolean"
    ? {
        commandId: value.commandId,
        displayBindingEpoch: value.displayBindingEpoch,
        acceptedControlRevision: value.acceptedControlRevision,
        occurrence: {
          publicSlideKey: value.occurrence.publicSlideKey,
          occurrenceSeq: value.occurrence.occurrenceSeq,
        },
        blackout: value.blackout,
      }
    : null;
}

async function requestBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

function displayCookie(request: Request): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === "__Host-display") return value.join("=") || null;
  }
  return null;
}

function serverEvent(kind: "PLAYBACK" | "CLOSE", payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify({ kind, payload })}\n\n`);
}

function eventStream(
  dependencies: ProjectionGatewayHttpDependencies,
  audienceDisplaySessionId: string,
  headers: Headers,
): Response {
  let socket: StageSocket | null = null;
  let cancelled = false;
  let measured = false;
  const finish = () => {
    if (measured) dependencies.metrics?.addRealtimeConnections(-1);
    measured = false;
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(": ready\n\n"));
      socket = dependencies.gateway.connectStage(
        audienceDisplaySessionId,
        {
          onPlayback: (event) => controller.enqueue(serverEvent("PLAYBACK", event)),
          onClose: (reason) => {
            finish();
            if (!cancelled) {
              controller.enqueue(serverEvent("CLOSE", { reason }));
              controller.close();
            }
          },
        },
        dependencies.now(),
      );
      if (socket === null) {
        controller.error(new Error("display session is unavailable"));
      } else {
        measured = true;
        dependencies.metrics?.addRealtimeConnections(1);
      }
    },
    cancel() {
      cancelled = true;
      socket?.close();
      finish();
    },
  });
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("connection", "keep-alive");
  return new Response(body, { status: socket === null ? 401 : 200, headers });
}

function validMutationOrigin(request: Request, origin: ExactOrigin): boolean {
  const referer = request.headers.get("referer");
  if (request.headers.get("origin") !== origin || referer === null) return false;
  try {
    return new URL(referer).origin === origin;
  } catch {
    return false;
  }
}

export function createProjectionGatewayHandler(
  config: ProjectionGatewayConfig,
  dependencies?: ProjectionGatewayHttpDependencies,
): ProjectionGatewayHandler {
  const handle = async (request: Request): Promise<Response> => {
    const origin = browserOriginHeaders(request, config.allowedOrigin);
    if (origin instanceof Response) return origin;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: origin });

    const url = new URL(request.url);
    const knownMutationPath =
      url.pathname.startsWith("/internal/") ||
      url.pathname === "/v1/display-joins" ||
      url.pathname === "/v1/display-session" ||
      url.pathname === "/v1/stage-applied";
    if (request.method !== "GET" && !knownMutationPath) {
      return json({ error: "dispatcher_required" }, 403, origin);
    }
    if (url.pathname === "/health") {
      return json({ service: "projection-gateway", status: "ok" }, 200, origin);
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
    if (url.pathname.startsWith("/v1/") && dependencies.publicRateLimiter !== undefined) {
      const decision = dependencies.publicRateLimiter.consume(clientIpKey(request));
      if (decision.outcome === "REJECTED") return rateLimited(decision.retryAfterMs, origin);
    }

    if (request.method === "POST" && url.pathname.startsWith("/internal/")) {
      if (request.headers.get("authorization") !== `Bearer ${dependencies.internalAuthToken}`) {
        return json({ error: "internal_unauthorized" }, 401);
      }
      if (url.pathname === "/internal/cards") {
        return json({ error: "stage_cards_disabled" }, 410);
      }
      const body = await requestBody(request);
      if (body === null) return json({ error: "invalid_request" }, 400);
      if (url.pathname === "/internal/display-bindings") {
        if (
          !hasOnlyKeys(body, [
            "displayJoinId",
            "presentationSessionId",
            "presentationSessionEpoch",
            "publicationPolicyVersion",
            "expectedDisplayBindingEpoch",
            "expectedDeckVersion",
            "approvedDisplayId",
            "approvedDisplayFingerprint",
            "deck",
            "nowMs",
          ])
        ) {
          return json({ error: "invalid_request" }, 400);
        }
        const deck = publicDeck(body.deck);
        if (
          deck === null ||
          typeof body.displayJoinId !== "string" ||
          typeof body.presentationSessionId !== "string" ||
          typeof body.presentationSessionEpoch !== "string" ||
          typeof body.publicationPolicyVersion !== "string" ||
          typeof body.expectedDisplayBindingEpoch !== "string" ||
          typeof body.expectedDeckVersion !== "string" ||
          typeof body.approvedDisplayId !== "string" ||
          typeof body.approvedDisplayFingerprint !== "string" ||
          typeof body.nowMs !== "number"
        ) {
          return json({ error: "invalid_request" }, 400);
        }
        const result = dependencies.gateway.bindDisplay(
          {
            displayJoinId: body.displayJoinId,
            presentationSessionId: body.presentationSessionId,
            presentationSessionEpoch: body.presentationSessionEpoch,
            publicationPolicyVersion: body.publicationPolicyVersion,
            expectedDisplayBindingEpoch: body.expectedDisplayBindingEpoch,
            expectedDeckVersion: body.expectedDeckVersion,
            approvedDisplayId: body.approvedDisplayId,
            approvedDisplayFingerprint: body.approvedDisplayFingerprint,
            deck,
          },
          body.nowMs,
        );
        if (result.outcome === "BOUND") await dependencies.persist?.();
        return json(result, result.outcome === "BOUND" ? 200 : 409);
      }
      if (url.pathname === "/internal/playback") {
        if (!hasOnlyKeys(body, ["presentationSessionId", "event"])) {
          return json({ error: "invalid_request" }, 400);
        }
        const event = playbackEvent(body.event);
        if (typeof body.presentationSessionId !== "string" || event === null) {
          return json({ error: "invalid_request" }, 400);
        }
        const applied = dependencies.gateway.projectPlayback(body.presentationSessionId, event);
        if (applied) await dependencies.persist?.();
        return json({ applied }, applied ? 200 : 409);
      }
      if (url.pathname === "/internal/playback-applied") {
        if (
          !hasOnlyKeys(body, [
            "presentationSessionId",
            "displayBindingEpoch",
            "publicPlaybackRevision",
          ]) ||
          typeof body.presentationSessionId !== "string" ||
          typeof body.displayBindingEpoch !== "string" ||
          typeof body.publicPlaybackRevision !== "string"
        ) {
          return json({ error: "invalid_request" }, 400);
        }
        const applied = dependencies.gateway.recordPlaybackApplied(
          body.presentationSessionId,
          body.displayBindingEpoch,
          body.publicPlaybackRevision,
        );
        if (applied) await dependencies.persist?.();
        return json({ applied }, applied ? 200 : 409);
      }
      return json({ error: "not_found" }, 404);
    }

    if (request.method !== "GET" && !validMutationOrigin(request, config.allowedOrigin)) {
      return json({ error: "mutation_origin_forbidden" }, 403, origin);
    }

    if (request.method === "POST" && url.pathname === "/v1/display-joins") {
      const body = await requestBody(request);
      if (
        body === null ||
        !hasOnlyKeys(body, ["displayId", "deckVersion", "displayFingerprint"]) ||
        typeof body.displayId !== "string" ||
        typeof body.deckVersion !== "string" ||
        typeof body.displayFingerprint !== "string"
      ) {
        return json({ error: "invalid_request" }, 400, origin);
      }
      const join = dependencies.gateway.createDisplayJoin(
        {
          displayId: body.displayId,
          deckVersion: body.deckVersion,
          displayFingerprint: body.displayFingerprint,
        },
        dependencies.now(),
      );
      await dependencies.persist?.();
      return json(join, 201, origin);
    }
    if (request.method === "POST" && url.pathname === "/v1/display-session") {
      const body = await requestBody(request);
      if (
        body === null ||
        !hasOnlyKeys(body, [
          "displayJoinId",
          "displayId",
          "deckVersion",
          "displayFingerprint",
          "expiresAtMs",
        ]) ||
        typeof body.displayJoinId !== "string" ||
        typeof body.displayId !== "string" ||
        typeof body.displayFingerprint !== "string"
      ) {
        return json({ error: "invalid_request" }, 400, origin);
      }
      const session = dependencies.gateway.claimDisplaySession(
        {
          displayJoinId: body.displayJoinId,
          displayId: body.displayId,
          displayFingerprint: body.displayFingerprint,
        },
        dependencies.now(),
      );
      if (session === null) return json({ error: "display_not_approved" }, 409, origin);
      await dependencies.persist?.();
      origin.append(
        "set-cookie",
        `__Host-display=${session.audienceDisplaySessionId}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((session.expiresAtMs - dependencies.now()) / 1_000))}`,
      );
      return json(session, 201, origin);
    }
    if (request.method === "GET" && url.pathname === "/v1/events") {
      const audienceDisplaySessionId = displayCookie(request);
      if (audienceDisplaySessionId === null) {
        return json({ error: "display_session_required" }, 401, origin);
      }
      return eventStream(dependencies, audienceDisplaySessionId, origin);
    }
    if (request.method === "POST" && url.pathname === "/v1/stage-applied") {
      const audienceDisplaySessionId = displayCookie(request);
      if (audienceDisplaySessionId === null) {
        return json({ error: "display_session_required" }, 401, origin);
      }
      const body = await requestBody(request);
      if (
        body === null ||
        !hasOnlyKeys(body, ["commandId", "displayBindingEpoch"]) ||
        typeof body.commandId !== "string" ||
        typeof body.displayBindingEpoch !== "string"
      ) {
        return json({ error: "invalid_request" }, 400, origin);
      }
      const receipt = await dependencies.stageReceiptWriter.recordApplied({
        audienceDisplaySessionId,
        commandId: body.commandId,
        displayBindingEpoch: body.displayBindingEpoch,
      });
      return receipt === null
        ? json({ error: "receipt_rejected" }, 409, origin)
        : json(receipt, 200, origin);
    }
    if (request.method === "GET" && url.pathname === "/v1/snapshot") {
      const audienceDisplaySessionId = displayCookie(request);
      if (audienceDisplaySessionId === null) {
        return json({ error: "display_session_required" }, 401, origin);
      }
      const presentationSessionEpoch = url.searchParams.get("presentationSessionEpoch");
      const displayBindingEpoch = url.searchParams.get("displayBindingEpoch");
      const deckVersion = url.searchParams.get("deckVersion");
      const manifestHash = url.searchParams.get("manifestHash");
      const hasPins =
        presentationSessionEpoch !== null ||
        displayBindingEpoch !== null ||
        deckVersion !== null ||
        manifestHash !== null;
      if (hasPins) {
        if (
          presentationSessionEpoch === null ||
          displayBindingEpoch === null ||
          deckVersion === null ||
          manifestHash === null
        ) {
          return json({ outcome: "RECONCILE_REQUIRED" }, 409, origin);
        }
        const stateHash = url.searchParams.get("stateHash");
        const result = dependencies.gateway.reconcileSnapshot(
          audienceDisplaySessionId,
          {
            role: url.searchParams.get("role") ?? "PUBLIC_STAGE",
            presentationSessionEpoch,
            displayBindingEpoch,
            deckVersion,
            manifestHash,
            ...(stateHash === null ? {} : { stateHash }),
          },
          dependencies.now(),
        );
        if (result.outcome === "RECONCILE_REQUIRED") return json(result, 409, origin);
        if (result.outcome === "SESSION_EXPIRED") {
          return json({ error: "display_session_expired" }, 401, origin);
        }
        return json(result.snapshot, 200, origin);
      }
      const snapshot = dependencies.gateway.snapshot(audienceDisplaySessionId, dependencies.now());
      return snapshot === null
        ? json({ error: "display_session_expired" }, 401, origin)
        : json(snapshot, 200, origin);
    }
    if (request.method === "GET" && url.pathname.startsWith("/v1/deck-assets/")) {
      if (dependencies.deckAssets === undefined) {
        return json({ error: "not_found" }, 404, origin);
      }
      const encodedPath = url.pathname.slice(DECK_ASSET_PATH_PREFIX.length);
      if (/%(?:2f|5c)/i.test(encodedPath)) {
        return json({ error: "invalid_asset_path" }, 400, origin);
      }
      const encodedSegments = encodedPath.split("/");
      let segments: string[];
      try {
        segments = encodedSegments.map((segment) => decodeURIComponent(segment));
      } catch {
        return json({ error: "invalid_asset_path" }, 400, origin);
      }
      const [artifactId, ...artifactSegments] = segments;
      if (
        artifactId === undefined ||
        !isDeckAssetPathComponent(artifactId) ||
        artifactSegments.length === 0 ||
        artifactSegments.some((segment) => !isDeckAssetPathComponent(segment))
      ) {
        return json({ error: "invalid_asset_path" }, 400, origin);
      }
      const result = await dependencies.deckAssets.read(artifactId, artifactSegments.join("/"));
      if (result.outcome === "ESCAPE") {
        return json({ error: "asset_escape_forbidden" }, 403, origin);
      }
      if (result.outcome === "UNKNOWN") {
        return json({ error: "asset_not_found" }, 404, origin);
      }
      origin.set("content-type", result.asset.contentType);
      origin.set("cache-control", "public, max-age=31536000, immutable");
      return new Response(new Uint8Array(result.asset.bytes), { status: 200, headers: origin });
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
    const outcome = httpOutcome(response.status);
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
