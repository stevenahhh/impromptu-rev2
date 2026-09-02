import { AUDIO_CAPTURE_COOKIE_NAME } from "../../audio-ingest.ts";
import { boundedAudioHeader, readAudioFrame, requestBody } from "../request-bodies.ts";
import { audioRejection, json } from "../responses.ts";
import type { AuthedRouteContext } from "../route-context.ts";
import { captureCookie, captureCookieAttributes } from "../session-cookies.ts";

/** Authenticated audio capture routes. Returns null when no route matched. */
export async function audioRoutes(ctx: AuthedRouteContext): Promise<Response | null> {
  const { request, url, origin, dependencies, accountSessionId } = ctx;
  const audio = dependencies.audio;
  if (url.pathname.startsWith("/v1/audio/")) {
    if (audio === undefined) return json({ error: "audio_ingest_unavailable" }, 503, origin);

    if (request.method === "POST" && url.pathname === "/v1/audio/grants") {
      const result = audio.issueGrant(
        accountSessionId,
        ctx.accountId,
        ctx.actorId,
        await requestBody(request),
        dependencies.now(),
      );
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
      const opened = audio.openEvents(accountSessionId, grantId, dependencies.now());
      if (opened.outcome === "REJECTED") return audioRejection(opened.reason, origin);
      origin.set("content-type", "text/event-stream; charset=utf-8");
      origin.set("cache-control", "no-store");
      origin.set("x-accel-buffering", "no");
      return new Response(opened.stream, { status: 200, headers: origin });
    }

    if (request.method === "POST" && url.pathname === "/v1/audio/stream/start") {
      const grantId = captureCookie(request);
      if (grantId === null) return json({ error: "capture_grant_required" }, 401, origin);
      const started = audio.startStream(accountSessionId, grantId, dependencies.now());
      return started.outcome === "STARTED"
        ? json({ status: "started" }, 202, origin)
        : audioRejection(started.reason, origin);
    }

    if (request.method === "POST" && url.pathname === "/v1/audio/frames") {
      const grantId = captureCookie(request);
      if (grantId === null) return json({ error: "capture_grant_required" }, 401, origin);
      const authorized = audio.authorizeFrame(accountSessionId, grantId, dependencies.now());
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
      const accepted = audio.pushFrame(
        accountSessionId,
        grantId,
        sequence,
        frame.bytes,
        durationMs,
        dependencies.now(),
      );
      return accepted.outcome === "ACCEPTED"
        ? json({ status: "accepted" }, 202, origin)
        : audioRejection(accepted.reason, origin);
    }

    if (request.method === "POST" && url.pathname === "/v1/audio/stream/stop") {
      const grantId = captureCookie(request);
      if (grantId === null) return json({ error: "capture_grant_required" }, 401, origin);
      const stopped = audio.stopStream(accountSessionId, grantId, dependencies.now());
      return stopped.outcome === "STOPPED"
        ? json({ status: "stopped" }, 202, origin)
        : audioRejection(stopped.reason, origin);
    }

    if (request.method === "DELETE" && url.pathname === "/v1/audio/grant") {
      const grantId = captureCookie(request);
      if (grantId === null) return json({ error: "capture_grant_required" }, 401, origin);
      const revoked = audio.revokeGrant(accountSessionId, grantId, dependencies.now());
      origin.append(
        "set-cookie",
        `${AUDIO_CAPTURE_COOKIE_NAME}=; ${captureCookieAttributes()}; Max-Age=0`,
      );
      return revoked.outcome === "REVOKED"
        ? json({ status: "revoked" }, 200, origin)
        : audioRejection(revoked.reason, origin);
    }
  }
  return null;
}
