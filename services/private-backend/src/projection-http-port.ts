import type { PublishedDeckArtifact } from "@impromptu/contracts/public";
import type { PreparedEvidenceProjectionPort } from "./prepared-evidence.ts";

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ProjectionHttpPort implements PreparedEvidenceProjectionPort {
  readonly #baseUrl: string;
  readonly #authorization: string;

  constructor(baseUrl: string, internalAuthToken: string) {
    const parsed = new URL(baseUrl);
    if (parsed.origin !== baseUrl)
      throw new Error("projection gateway URL must be an exact origin");
    if (internalAuthToken.length < 16) throw new Error("internal service token is too short");
    this.#baseUrl = baseUrl;
    this.#authorization = `Bearer ${internalAuthToken}`;
  }

  async #post(path: string, body: unknown): Promise<Response> {
    return fetch(`${this.#baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: this.#authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  async bindDisplay(
    input: {
      readonly displayJoinId: string;
      readonly presentationSessionId: string;
      readonly presentationSessionEpoch: string;
      readonly publicationPolicyVersion: string;
      readonly expectedDisplayBindingEpoch: string;
      readonly expectedDeckVersion: string;
      readonly approvedDisplayId: string;
      readonly approvedDisplayFingerprint: string;
      readonly deck: PublishedDeckArtifact;
    },
    nowMs: number,
  ) {
    try {
      const response = await this.#post("/internal/display-bindings", { ...input, nowMs });
      const body = await responseJson(response);
      if (response.ok && isRecord(body) && body.outcome === "BOUND") {
        return { outcome: "BOUND" as const, session: body.session };
      }
      return {
        outcome: "REJECTED" as const,
        reason:
          isRecord(body) && typeof body.reason === "string"
            ? body.reason
            : "PROJECTION_UNAVAILABLE",
      };
    } catch {
      return { outcome: "REJECTED" as const, reason: "PROJECTION_UNAVAILABLE" };
    }
  }

  async projectPlayback(
    presentationSessionId: string,
    event: {
      readonly commandId: string;
      readonly displayBindingEpoch: string;
      readonly acceptedControlRevision: string;
      readonly occurrence: { readonly publicSlideKey: string; readonly occurrenceSeq: number };
      readonly blackout: boolean;
    },
  ): Promise<boolean> {
    try {
      return (await this.#post("/internal/playback", { presentationSessionId, event })).ok;
    } catch {
      return false;
    }
  }

  async recordPlaybackApplied(
    presentationSessionId: string,
    displayBindingEpoch: string,
    publicPlaybackRevision: string,
  ): Promise<boolean> {
    try {
      return (
        await this.#post("/internal/playback-applied", {
          presentationSessionId,
          displayBindingEpoch,
          publicPlaybackRevision,
        })
      ).ok;
    } catch {
      return false;
    }
  }
}
