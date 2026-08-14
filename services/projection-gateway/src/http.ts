import type { ExactOrigin, ProjectionGatewayConfig } from "./config.ts";
import type {
  PlaybackProjection,
  PreparedEvidenceProjectionGateway,
  PublicCardEvent,
  PublicDeckArtifact,
  StageSocket,
} from "./prepared-evidence.ts";

export type ProjectionGatewayHandler = (request: Request) => Response | Promise<Response>;

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
}

function json(body: unknown, status: number, headers?: Headers): Response {
  const responseHeaders = headers ?? new Headers();
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("content-type", "application/json; charset=utf-8");

  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publicDeck(value: unknown): PublicDeckArtifact | null {
  if (!isRecord(value) || !Array.isArray(value.slides)) return null;
  const slides: PublicDeckArtifact["slides"][number][] = [];
  for (const candidate of value.slides) {
    if (!isRecord(candidate) || !isRecord(candidate.image)) return null;
    if (
      typeof candidate.publicSlideKey !== "string" ||
      typeof candidate.ordinal !== "number" ||
      typeof candidate.accessibilityLabel !== "string" ||
      typeof candidate.image.url !== "string" ||
      typeof candidate.image.contentHash !== "string" ||
      typeof candidate.image.width !== "number" ||
      typeof candidate.image.height !== "number"
    ) {
      return null;
    }
    slides.push({
      publicSlideKey: candidate.publicSlideKey,
      ordinal: candidate.ordinal,
      accessibilityLabel: candidate.accessibilityLabel,
      image: {
        url: candidate.image.url,
        contentHash: candidate.image.contentHash,
        width: candidate.image.width,
        height: candidate.image.height,
      },
    });
  }
  return typeof value.deckVersion === "string" &&
    typeof value.manifestHash === "string" &&
    typeof value.title === "string" &&
    slides.length > 0
    ? {
        deckVersion: value.deckVersion,
        manifestHash: value.manifestHash,
        title: value.title,
        slides,
      }
    : null;
}

function playbackEvent(value: unknown): PlaybackProjection | null {
  if (!isRecord(value) || !isRecord(value.occurrence)) return null;
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

function cardEvent(value: unknown): PublicCardEvent | null {
  if (!isRecord(value) || typeof value.projectionId !== "string") return null;
  if (
    (value.status === "RETRACTED" || value.status === "EXPIRED") &&
    typeof value.publicCardRevision === "string" &&
    typeof value.occurredAtMs === "number"
  ) {
    return {
      projectionId: value.projectionId,
      status: value.status,
      publicCardRevision: value.publicCardRevision,
      occurredAtMs: value.occurredAtMs,
    };
  }
  if (value.status !== "PUBLISHED" || !isRecord(value.occurrence)) return null;
  return typeof value.claim === "string" &&
    typeof value.supportSummary === "string" &&
    typeof value.sourceLabel === "string" &&
    typeof value.publishedAtMs === "number" &&
    (typeof value.expiresAtMs === "number" || value.expiresAtMs === null) &&
    typeof value.publicCardRevision === "string" &&
    typeof value.deckVersion === "string" &&
    typeof value.manifestHash === "string" &&
    typeof value.occurrence.publicSlideKey === "string" &&
    typeof value.occurrence.occurrenceSeq === "number"
    ? {
        projectionId: value.projectionId,
        status: value.status,
        ...(value.mode === "CURATED" || value.mode === "LIVE" ? { mode: value.mode } : {}),
        ...(typeof value.leaseExpiresAtMs === "number" || value.leaseExpiresAtMs === null
          ? { leaseExpiresAtMs: value.leaseExpiresAtMs }
          : {}),
        ...(isRecord(value.offlinePackage) &&
        typeof value.offlinePackage.offlineDisplayAllowed === "boolean" &&
        typeof value.offlinePackage.localExpiresAtMs === "number" &&
        typeof value.offlinePackage.signature === "string"
          ? {
              offlinePackage: {
                offlineDisplayAllowed: value.offlinePackage.offlineDisplayAllowed,
                localExpiresAtMs: value.offlinePackage.localExpiresAtMs,
                signature: value.offlinePackage.signature,
              },
            }
          : {}),
        claim: value.claim,
        supportSummary: value.supportSummary,
        sourceLabel: value.sourceLabel,
        publishedAtMs: value.publishedAtMs,
        expiresAtMs: value.expiresAtMs,
        publicCardRevision: value.publicCardRevision,
        deckVersion: value.deckVersion,
        manifestHash: value.manifestHash,
        occurrence: {
          publicSlideKey: value.occurrence.publicSlideKey,
          occurrenceSeq: value.occurrence.occurrenceSeq,
        },
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

function serverEvent(kind: "PLAYBACK" | "CARD" | "CLOSE", payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify({ kind, payload })}\n\n`);
}

function eventStream(
  dependencies: ProjectionGatewayHttpDependencies,
  audienceDisplaySessionId: string,
  headers: Headers,
): Response {
  let socket: StageSocket | null = null;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(": ready\n\n"));
      socket = dependencies.gateway.connectStage(
        audienceDisplaySessionId,
        {
          onPlayback: (event) => controller.enqueue(serverEvent("PLAYBACK", event)),
          onCard: (event) => controller.enqueue(serverEvent("CARD", event)),
          onClose: (reason) => {
            if (!cancelled) {
              controller.enqueue(serverEvent("CLOSE", { reason }));
              controller.close();
            }
          },
        },
        dependencies.now(),
      );
      if (socket === null) controller.error(new Error("display session is unavailable"));
    },
    cancel() {
      cancelled = true;
      socket?.close();
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
  return async (request) => {
    const origin = browserOriginHeaders(request, config.allowedOrigin);
    if (origin instanceof Response) return origin;

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
    if (dependencies === undefined) return json({ error: "not_found" }, 404, origin);

    if (request.method === "POST" && url.pathname.startsWith("/internal/")) {
      if (request.headers.get("authorization") !== `Bearer ${dependencies.internalAuthToken}`) {
        return json({ error: "internal_unauthorized" }, 401);
      }
      const body = await requestBody(request);
      if (body === null) return json({ error: "invalid_request" }, 400);
      if (url.pathname === "/internal/display-bindings") {
        const deck = publicDeck(body.deck);
        if (
          deck === null ||
          typeof body.displayJoinId !== "string" ||
          typeof body.presentationSessionId !== "string" ||
          typeof body.presentationSessionEpoch !== "string" ||
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
      if (url.pathname === "/internal/cards") {
        const event = cardEvent(body.event);
        if (typeof body.presentationSessionId !== "string" || event === null) {
          return json({ error: "invalid_request" }, 400);
        }
        const applied = dependencies.gateway.projectCard(body.presentationSessionId, event);
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

    return json({ error: "not_found" }, 404, origin);
  };
}
