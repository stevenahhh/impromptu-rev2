import type {
  PreparedEvidenceProjectionGateway,
  StageSocket,
  StageSocketCloseReason,
} from "./prepared-evidence.ts";

export interface PublicStageAppliedReceipt {
  readonly status: "STAGE_APPLIED";
  readonly commandId: string;
  readonly presentationSessionEpoch: string;
  readonly displayBindingEpoch: string;
  readonly publicPlaybackRevision: string;
  readonly appliedAtMs: number;
}

export type ProjectionRealtimeMessage =
  | Readonly<{
      kind: "COMMAND";
      payload: Readonly<{
        commandId: string;
        presentationSessionEpoch: string;
        displayBindingEpoch: string;
        acceptedControlRevision: string;
        publicPlaybackRevision: string;
        occurrence: Readonly<{ publicSlideKey: string; occurrenceSeq: number }>;
        blackout: boolean;
      }>;
    }>
  | Readonly<{ kind: "CARD"; payload: unknown }>
  | Readonly<{ kind: "RECEIPT"; payload: PublicStageAppliedReceipt }>
  | Readonly<{ kind: "CLOSE"; payload: Readonly<{ reason: StageSocketCloseReason }> }>
  | Readonly<{
      kind: "ERROR";
      payload: Readonly<{
        code: "INVALID_FRAME" | "STALE_DISPLAY_BINDING" | "RECEIPT_REJECTED";
      }>;
    }>;

export interface ProjectionRealtimeDependencies {
  readonly gateway: PreparedEvidenceProjectionGateway;
  readonly allowedOrigin: string;
  readonly now: () => number;
  readonly recordApplied: (input: {
    readonly audienceDisplaySessionId: string;
    readonly commandId: string;
    readonly displayBindingEpoch: string;
  }) => Promise<unknown | null>;
}

export type RealtimeAuthentication =
  | Readonly<{ outcome: "ACCEPTED"; audienceDisplaySessionId: string }>
  | Readonly<{
      outcome: "REJECTED";
      reason: "ORIGIN_FORBIDDEN" | "DISPLAY_SESSION_REQUIRED";
    }>;

export interface ProjectionRealtimeConnection {
  receive(frame: string | ArrayBuffer | Uint8Array): Promise<void>;
  close(): void;
}

function displayCookie(request: Request): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === "__Host-display") return value.join("=") || null;
  }
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseAppliedFrame(frame: string | ArrayBuffer | Uint8Array): {
  commandId: string;
  displayBindingEpoch: string;
} | null {
  let value: unknown;
  try {
    const text =
      typeof frame === "string"
        ? frame
        : new TextDecoder().decode(frame instanceof Uint8Array ? frame : new Uint8Array(frame));
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const envelope = record(value);
  const payload = record(envelope?.payload);
  return envelope?.kind === "STAGE_APPLIED" &&
    payload !== null &&
    typeof payload.commandId === "string" &&
    typeof payload.displayBindingEpoch === "string" &&
    Object.keys(payload).length === 2
    ? { commandId: payload.commandId, displayBindingEpoch: payload.displayBindingEpoch }
    : null;
}

function publicReceipt(value: unknown, nowMs: number): PublicStageAppliedReceipt | null {
  const receipt = record(value);
  if (
    receipt === null ||
    receipt.status !== "STAGE_APPLIED" ||
    typeof receipt.commandId !== "string" ||
    typeof receipt.presentationSessionEpoch !== "string" ||
    typeof receipt.displayBindingEpoch !== "string" ||
    typeof receipt.publicPlaybackRevision !== "string"
  ) {
    return null;
  }
  const appliedAtMs = receipt.appliedAtMs;
  return {
    status: "STAGE_APPLIED",
    commandId: receipt.commandId,
    presentationSessionEpoch: receipt.presentationSessionEpoch,
    displayBindingEpoch: receipt.displayBindingEpoch,
    publicPlaybackRevision: receipt.publicPlaybackRevision,
    appliedAtMs: typeof appliedAtMs === "number" ? appliedAtMs : nowMs,
  };
}

export function createProjectionRealtimeProtocol(dependencies: ProjectionRealtimeDependencies) {
  return {
    authenticate(request: Request): RealtimeAuthentication {
      if (request.headers.get("origin") !== dependencies.allowedOrigin) {
        return { outcome: "REJECTED", reason: "ORIGIN_FORBIDDEN" };
      }
      const audienceDisplaySessionId = displayCookie(request);
      return audienceDisplaySessionId === null
        ? { outcome: "REJECTED", reason: "DISPLAY_SESSION_REQUIRED" }
        : { outcome: "ACCEPTED", audienceDisplaySessionId };
    },

    connect(
      audienceDisplaySessionId: string,
      send: (message: ProjectionRealtimeMessage) => void,
    ): ProjectionRealtimeConnection | null {
      const initial = dependencies.gateway.snapshot(audienceDisplaySessionId, dependencies.now());
      if (initial === null) return null;
      let socket: StageSocket | null = dependencies.gateway.connectStage(
        audienceDisplaySessionId,
        {
          onPlayback(event) {
            send({
              kind: "COMMAND",
              payload: event,
            });
          },
          onCard(event) {
            send({ kind: "CARD", payload: event });
          },
          onClose(reason) {
            send({ kind: "CLOSE", payload: { reason } });
          },
        },
        dependencies.now(),
      );
      if (socket === null) return null;
      return {
        async receive(frame) {
          const applied = parseAppliedFrame(frame);
          if (applied === null) {
            send({ kind: "ERROR", payload: { code: "INVALID_FRAME" } });
            return;
          }
          const current = dependencies.gateway.snapshot(
            audienceDisplaySessionId,
            dependencies.now(),
          );
          if (current === null || applied.displayBindingEpoch !== current.displayBindingEpoch) {
            send({ kind: "ERROR", payload: { code: "STALE_DISPLAY_BINDING" } });
            return;
          }
          const receipt = publicReceipt(
            await dependencies.recordApplied({ audienceDisplaySessionId, ...applied }),
            dependencies.now(),
          );
          if (
            receipt === null ||
            receipt.commandId !== applied.commandId ||
            receipt.presentationSessionEpoch !== current.presentationSessionEpoch ||
            receipt.displayBindingEpoch !== current.displayBindingEpoch
          ) {
            send({ kind: "ERROR", payload: { code: "RECEIPT_REJECTED" } });
            return;
          }
          send({ kind: "RECEIPT", payload: receipt });
        },
        close() {
          socket?.close();
          socket = null;
        },
      };
    },
  };
}
