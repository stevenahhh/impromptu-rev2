import { createHash } from "node:crypto";
import type {
  AcceptedCommandReceipt,
  CommandId,
  CommandReceipt,
  ControlRevision,
  PlaybackCommand,
  PlaybackControlLease,
  RejectedCommandReceipt,
  StageAppliedReceipt,
} from "@impromptu/contracts/control";
import {
  AcceptedCommandReceiptSchema,
  CommandIdSchema,
  ControlRevisionSchema,
  controlRevision,
  controlRevisionValue,
  nextControlRevision,
  PlaybackCommandSchema,
  PlaybackControlLeaseSchema,
  StageAppliedReceiptSchema,
} from "@impromptu/contracts/control";
import type {
  DisplayBindingEpoch,
  PresentationSessionEpoch,
  PresentationSessionId,
  PublicPlaybackRevision,
  PublicSlideKey,
  PublicSlideOccurrence,
} from "@impromptu/contracts/public";
import {
  DisplayBindingEpochSchema,
  nextPublicPlaybackRevision,
  PresentationSessionEpochSchema,
  PresentationSessionIdSchema,
  PublicPlaybackRevisionSchema,
  PublicSlideKeySchema,
  PublicSlideOccurrenceSchema,
  publicPlaybackRevision,
  Sha256Schema,
} from "@impromptu/contracts/public";
import { safeEncodedCounterValue } from "@impromptu/contracts/shared";
import { z } from "zod";

export type StageStatus = "READY" | "DISCONNECTED" | "UNBOUND";

export type PlaybackEffect = Readonly<{
  commandId: CommandId;
  acceptedControlRevision: ControlRevision;
  occurrence: PublicSlideOccurrence;
  blackout: boolean;
}>;

type AcceptedCommandRecord = Readonly<{
  command: PlaybackCommand;
  requestHash: string;
  receipt: AcceptedCommandReceipt;
  effect: PlaybackEffect;
  appliedReceipt: StageAppliedReceipt | null;
}>;

export type PlaybackAuthorityState = Readonly<{
  presentationSessionId: PresentationSessionId;
  presentationSessionEpoch: PresentationSessionEpoch;
  activeLease: PlaybackControlLease;
  displayBindingEpoch: DisplayBindingEpoch;
  controlRevision: ControlRevision;
  publicPlaybackRevision: PublicPlaybackRevision;
  stageStatus: StageStatus;
  slideOrder: readonly PublicSlideKey[];
  initialSlideKey: PublicSlideKey;
  occurrence: PublicSlideOccurrence;
  nextOccurrenceSeq: number;
  blackout: boolean;
  acceptedCommands: Readonly<Record<string, AcceptedCommandRecord>>;
}>;

export type PlaybackAuthoritySnapshot = PlaybackAuthorityState;

const PlaybackEffectSchema = z
  .object({
    commandId: CommandIdSchema,
    acceptedControlRevision: ControlRevisionSchema,
    occurrence: PublicSlideOccurrenceSchema,
    blackout: z.boolean(),
  })
  .strict();
const AcceptedCommandRecordSchema = z
  .object({
    command: PlaybackCommandSchema,
    requestHash: Sha256Schema,
    receipt: AcceptedCommandReceiptSchema,
    effect: PlaybackEffectSchema,
    appliedReceipt: StageAppliedReceiptSchema.nullable(),
  })
  .strict();
const PlaybackAuthoritySnapshotSchema = z
  .object({
    presentationSessionId: PresentationSessionIdSchema,
    presentationSessionEpoch: PresentationSessionEpochSchema,
    activeLease: PlaybackControlLeaseSchema,
    displayBindingEpoch: DisplayBindingEpochSchema,
    controlRevision: ControlRevisionSchema,
    publicPlaybackRevision: PublicPlaybackRevisionSchema,
    stageStatus: z.enum(["READY", "DISCONNECTED", "UNBOUND"]),
    slideOrder: z.array(PublicSlideKeySchema),
    initialSlideKey: PublicSlideKeySchema,
    occurrence: PublicSlideOccurrenceSchema,
    nextOccurrenceSeq: z.number().int().positive(),
    blackout: z.boolean(),
    acceptedCommands: z.record(z.string(), AcceptedCommandRecordSchema),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (
      snapshot.activeLease.presentationSessionId !== snapshot.presentationSessionId ||
      snapshot.activeLease.presentationSessionEpoch !== snapshot.presentationSessionEpoch
    ) {
      context.addIssue({
        code: "custom",
        path: ["activeLease"],
        message: "lease belongs to another session",
      });
    }
    if (
      new Set(snapshot.slideOrder).size !== snapshot.slideOrder.length ||
      !snapshot.slideOrder.includes(snapshot.occurrence.publicSlideKey)
    ) {
      context.addIssue({ code: "custom", path: ["slideOrder"], message: "invalid slide registry" });
    }
    const controlHead = safeEncodedCounterValue(snapshot.controlRevision);
    const playbackHead = safeEncodedCounterValue(snapshot.publicPlaybackRevision);
    if (controlHead === null || playbackHead === null) return;
    const recordsByRevision = new Map<number, AcceptedCommandRecord>();
    const appliedRevisions = new Set<number>();
    for (const [key, record] of Object.entries(snapshot.acceptedCommands)) {
      const command = record.command;
      const receipt = record.receipt;
      const acceptedRevision = safeEncodedCounterValue(receipt.acceptedControlRevision);
      const canonicalHash = canonicalPlaybackRequestHash(command);
      const identityMatches =
        command.presentationSessionId === receipt.presentationSessionId &&
        command.presentationSessionEpoch === receipt.presentationSessionEpoch &&
        command.actorId === receipt.actorId &&
        command.leaseId === receipt.leaseId &&
        command.controllerEpoch === receipt.controllerEpoch &&
        command.commandId === receipt.commandId;
      let valid =
        key === commandKey(command) &&
        command.presentationSessionId === snapshot.presentationSessionId &&
        command.presentationSessionEpoch === snapshot.presentationSessionEpoch &&
        identityMatches &&
        record.requestHash === canonicalHash &&
        receipt.requestHash === canonicalHash &&
        record.effect.commandId === receipt.commandId &&
        record.effect.acceptedControlRevision === receipt.acceptedControlRevision &&
        acceptedRevision !== null &&
        acceptedRevision >= 1 &&
        acceptedRevision <= controlHead &&
        !recordsByRevision.has(acceptedRevision ?? -1);

      if (record.appliedReceipt !== null) {
        const applied = record.appliedReceipt;
        const appliedRevision = safeEncodedCounterValue(applied.publicPlaybackRevision);
        valid =
          valid &&
          applied.presentationSessionId === receipt.presentationSessionId &&
          applied.presentationSessionEpoch === receipt.presentationSessionEpoch &&
          applied.actorId === receipt.actorId &&
          applied.leaseId === receipt.leaseId &&
          applied.controllerEpoch === receipt.controllerEpoch &&
          applied.commandId === receipt.commandId &&
          applied.requestHash === receipt.requestHash &&
          applied.acceptedControlRevision === receipt.acceptedControlRevision &&
          applied.displayBindingEpoch === snapshot.displayBindingEpoch &&
          appliedRevision !== null &&
          appliedRevision === acceptedRevision &&
          appliedRevision <= playbackHead &&
          !appliedRevisions.has(appliedRevision ?? -1);
        if (appliedRevision !== null) appliedRevisions.add(appliedRevision);
      } else {
        valid = valid && acceptedRevision !== null && acceptedRevision > playbackHead;
      }
      if (acceptedRevision !== null) recordsByRevision.set(acceptedRevision, record);
      if (!valid) {
        context.addIssue({
          code: "custom",
          path: ["acceptedCommands", key],
          message: "invalid accepted command identity or hash",
        });
      }
    }

    if (recordsByRevision.size !== controlHead || appliedRevisions.size !== playbackHead) {
      context.addIssue({
        code: "custom",
        path: ["acceptedCommands"],
        message: "accepted or applied revisions are not gap-free",
      });
      return;
    }
    for (let revision = 1; revision <= controlHead; revision += 1) {
      if (!recordsByRevision.has(revision)) {
        context.addIssue({
          code: "custom",
          path: ["acceptedCommands"],
          message: "accepted revisions contain a gap",
        });
        return;
      }
    }
    for (let revision = 1; revision <= playbackHead; revision += 1) {
      if (!appliedRevisions.has(revision)) {
        context.addIssue({
          code: "custom",
          path: ["acceptedCommands"],
          message: "applied revisions contain a gap",
        });
        return;
      }
    }

    let occurrence: PublicSlideOccurrence = {
      publicSlideKey: snapshot.initialSlideKey,
      occurrenceSeq: 1,
    };
    let nextOccurrenceSeq = 2;
    let blackout = false;
    for (let revision = 1; revision <= controlHead; revision += 1) {
      const record = recordsByRevision.get(revision);
      if (record === undefined) return;
      const command = record.command;
      if (safeEncodedCounterValue(command.baseRevision) !== revision - 1) {
        context.addIssue({
          code: "custom",
          path: ["acceptedCommands"],
          message: "command base revision does not match accepted order",
        });
        return;
      }
      const relative = command.type === "SLIDE_NEXT" || command.type === "SLIDE_PREVIOUS";
      if (
        (relative && command.delivery === "OFFLINE_REPLAY") ||
        (relative && snapshot.stageStatus !== "READY") ||
        (command.type === "SLIDE_SET" && !snapshot.slideOrder.includes(command.publicSlideKey))
      ) {
        context.addIssue({
          code: "custom",
          path: ["acceptedCommands"],
          message: "persisted command violates live acceptance predicates",
        });
        return;
      }
      let target = occurrence.publicSlideKey;
      if (command.type === "SLIDE_SET") target = command.publicSlideKey;
      if (relative) {
        const currentIndex = snapshot.slideOrder.indexOf(occurrence.publicSlideKey);
        const offset = command.type === "SLIDE_NEXT" ? 1 : -1;
        const relativeTarget = snapshot.slideOrder[currentIndex + offset];
        if (relativeTarget === undefined) {
          context.addIssue({
            code: "custom",
            path: ["acceptedCommands"],
            message: "accepted relative command crosses a slide boundary",
          });
          return;
        }
        target = relativeTarget;
      }
      if (target !== occurrence.publicSlideKey) {
        occurrence = { publicSlideKey: target, occurrenceSeq: nextOccurrenceSeq };
        nextOccurrenceSeq += 1;
      }
      if (command.type === "BLACKOUT_SET") blackout = command.enabled;
      if (
        record.effect.occurrence.publicSlideKey !== occurrence.publicSlideKey ||
        record.effect.occurrence.occurrenceSeq !== occurrence.occurrenceSeq ||
        record.effect.blackout !== blackout
      ) {
        context.addIssue({
          code: "custom",
          path: ["acceptedCommands"],
          message: "persisted command effect does not match canonical replay",
        });
        return;
      }
    }
    if (
      snapshot.occurrence.publicSlideKey !== occurrence.publicSlideKey ||
      snapshot.occurrence.occurrenceSeq !== occurrence.occurrenceSeq ||
      snapshot.nextOccurrenceSeq !== nextOccurrenceSeq ||
      snapshot.blackout !== blackout
    ) {
      context.addIssue({
        code: "custom",
        path: ["occurrence"],
        message: "playback state does not match canonical command replay",
      });
    }
  });

export type CreatePlaybackAuthorityState = Readonly<{
  presentationSessionId: PresentationSessionId;
  presentationSessionEpoch: PresentationSessionEpoch;
  activeLease: PlaybackControlLease;
  displayBindingEpoch: DisplayBindingEpoch;
  stageStatus: StageStatus;
  slideOrder: readonly PublicSlideKey[];
  initialSlideKey: PublicSlideKey;
}>;

export function createPlaybackAuthorityState(
  input: CreatePlaybackAuthorityState,
): PlaybackAuthorityState {
  if (
    input.activeLease.presentationSessionId !== input.presentationSessionId ||
    input.activeLease.presentationSessionEpoch !== input.presentationSessionEpoch
  ) {
    throw new Error("active lease must belong to the playback presentation session");
  }
  if (!input.slideOrder.includes(input.initialSlideKey)) {
    throw new Error("initial slide must exist in slide order");
  }
  if (new Set(input.slideOrder).size !== input.slideOrder.length) {
    throw new Error("slide order must contain unique public slide keys");
  }
  return {
    presentationSessionId: input.presentationSessionId,
    presentationSessionEpoch: input.presentationSessionEpoch,
    activeLease: input.activeLease,
    displayBindingEpoch: input.displayBindingEpoch,
    stageStatus: input.stageStatus,
    slideOrder: [...input.slideOrder],
    initialSlideKey: input.initialSlideKey,
    controlRevision: controlRevision(0),
    publicPlaybackRevision: publicPlaybackRevision(0),
    occurrence: { publicSlideKey: input.initialSlideKey, occurrenceSeq: 1 },
    nextOccurrenceSeq: 2,
    blackout: false,
    acceptedCommands: {},
  };
}

function canonicalCommandPayload(command: PlaybackCommand): string {
  const payload =
    command.type === "SLIDE_SET"
      ? `publicSlideKey=${JSON.stringify(command.publicSlideKey)}`
      : command.type === "BLACKOUT_SET"
        ? `enabled=${command.enabled ? "true" : "false"}`
        : "";
  return [
    `type=${command.type}`,
    `baseRevision=${command.baseRevision}`,
    `delivery=${command.delivery}`,
    payload,
  ].join("\n");
}

export function canonicalPlaybackRequestHash(command: PlaybackCommand): string {
  return createHash("sha256").update(canonicalCommandPayload(command), "utf8").digest("hex");
}

function commandKey(command: PlaybackCommand): string {
  return JSON.stringify([
    command.presentationSessionId,
    command.presentationSessionEpoch,
    command.actorId,
    command.leaseId,
    command.controllerEpoch,
    command.commandId,
  ]);
}

function receiptIdentity(command: PlaybackCommand, requestHash: string) {
  return {
    presentationSessionId: command.presentationSessionId,
    presentationSessionEpoch: command.presentationSessionEpoch,
    actorId: command.actorId,
    leaseId: command.leaseId,
    controllerEpoch: command.controllerEpoch,
    commandId: command.commandId,
    requestHash,
  };
}

function reject(
  state: PlaybackAuthorityState,
  command: PlaybackCommand,
  requestHash: string,
  reason: RejectedCommandReceipt["reason"],
): PlaybackReduction {
  return {
    state,
    receipt: { status: "REJECTED", ...receiptIdentity(command, requestHash), reason },
    effect: null,
  };
}

function isRelative(command: PlaybackCommand): boolean {
  return command.type === "SLIDE_NEXT" || command.type === "SLIDE_PREVIOUS";
}

function targetSlide(
  state: PlaybackAuthorityState,
  command: PlaybackCommand,
): PublicSlideKey | null {
  if (command.type === "SLIDE_SET") {
    return state.slideOrder.includes(command.publicSlideKey) ? command.publicSlideKey : null;
  }
  if (!isRelative(command)) return state.occurrence.publicSlideKey;
  const currentIndex = state.slideOrder.indexOf(state.occurrence.publicSlideKey);
  const offset = command.type === "SLIDE_NEXT" ? 1 : -1;
  return state.slideOrder[currentIndex + offset] ?? null;
}

export type PlaybackReduction = Readonly<{
  state: PlaybackAuthorityState;
  receipt: CommandReceipt;
  effect: PlaybackEffect | null;
}>;

export function reducePlaybackCommand(
  state: PlaybackAuthorityState,
  command: PlaybackCommand,
  nowMs: number,
): PlaybackReduction {
  const requestHash = canonicalPlaybackRequestHash(command);
  if (command.actorId !== state.activeLease.actorId) {
    return reject(state, command, requestHash, "UNAUTHORIZED");
  }
  if (
    command.presentationSessionId !== state.presentationSessionId ||
    command.presentationSessionEpoch !== state.presentationSessionEpoch
  ) {
    return reject(state, command, requestHash, "STALE_SESSION_EPOCH");
  }
  if (command.leaseId !== state.activeLease.leaseId) {
    return reject(state, command, requestHash, "STALE_LEASE");
  }
  if (nowMs >= state.activeLease.expiresAtMs) {
    return reject(state, command, requestHash, "LEASE_EXPIRED");
  }
  if (command.controllerEpoch !== state.activeLease.controllerEpoch) {
    return reject(state, command, requestHash, "STALE_CONTROLLER_EPOCH");
  }

  const key = commandKey(command);
  const prior = state.acceptedCommands[key];
  if (prior !== undefined) {
    if (prior.requestHash !== requestHash) {
      return reject(state, command, requestHash, "IDEMPOTENCY_CONFLICT");
    }
    return { state, receipt: prior.receipt, effect: prior.effect };
  }
  if (command.baseRevision !== state.controlRevision) {
    return reject(state, command, requestHash, "REVISION_MISMATCH");
  }
  if (isRelative(command) && command.delivery === "OFFLINE_REPLAY") {
    return reject(state, command, requestHash, "OFFLINE_RELATIVE_COMMAND");
  }
  if (isRelative(command) && state.stageStatus !== "READY") {
    return reject(state, command, requestHash, "STAGE_NOT_READY");
  }

  const nextSlide = targetSlide(state, command);
  if (nextSlide === null) {
    return reject(
      state,
      command,
      requestHash,
      command.type === "SLIDE_SET" ? "UNKNOWN_SLIDE" : "SLIDE_BOUNDARY",
    );
  }

  const slideChanged = nextSlide !== state.occurrence.publicSlideKey;
  const occurrence = slideChanged
    ? { publicSlideKey: nextSlide, occurrenceSeq: state.nextOccurrenceSeq }
    : state.occurrence;
  const nextOccurrenceSeq = slideChanged ? state.nextOccurrenceSeq + 1 : state.nextOccurrenceSeq;
  const blackout = command.type === "BLACKOUT_SET" ? command.enabled : state.blackout;
  const acceptedControlRevision = nextControlRevision(state.controlRevision);
  const receipt: AcceptedCommandReceipt = {
    status: "ACCEPTED",
    ...receiptIdentity(command, requestHash),
    acceptedControlRevision,
  };
  const effect: PlaybackEffect = {
    commandId: command.commandId,
    acceptedControlRevision,
    occurrence,
    blackout,
  };
  const record: AcceptedCommandRecord = {
    command,
    requestHash,
    receipt,
    effect,
    appliedReceipt: null,
  };
  return {
    state: {
      ...state,
      controlRevision: acceptedControlRevision,
      occurrence,
      nextOccurrenceSeq,
      blackout,
      acceptedCommands: { ...state.acceptedCommands, [key]: record },
    },
    receipt,
    effect,
  };
}

export type StageApplyOutcome =
  | "APPLIED"
  | "DUPLICATE"
  | "OUT_OF_ORDER"
  | "UNKNOWN_COMMAND"
  | "STALE_BINDING";
export type StageApplyResult = Readonly<{
  state: PlaybackAuthorityState;
  outcome: StageApplyOutcome;
  receipt: StageAppliedReceipt | null;
}>;

export function markStageApplied(
  state: PlaybackAuthorityState,
  commandId: CommandId,
  displayBindingEpoch: DisplayBindingEpoch,
): StageApplyResult {
  if (displayBindingEpoch !== state.displayBindingEpoch) {
    return { state, outcome: "STALE_BINDING", receipt: null };
  }
  const lease = state.activeLease;
  const key = JSON.stringify([
    state.presentationSessionId,
    state.presentationSessionEpoch,
    lease.actorId,
    lease.leaseId,
    lease.controllerEpoch,
    commandId,
  ]);
  const record = state.acceptedCommands[key];
  if (record === undefined) return { state, outcome: "UNKNOWN_COMMAND", receipt: null };
  if (record.appliedReceipt !== null) {
    return { state, outcome: "DUPLICATE", receipt: record.appliedReceipt };
  }

  const firstPendingRevision = Object.values(state.acceptedCommands)
    .filter((candidate) => candidate.appliedReceipt === null)
    .reduce(
      (minimum, candidate) =>
        Math.min(minimum, controlRevisionValue(candidate.receipt.acceptedControlRevision)),
      Number.POSITIVE_INFINITY,
    );
  if (controlRevisionValue(record.receipt.acceptedControlRevision) !== firstPendingRevision) {
    return { state, outcome: "OUT_OF_ORDER", receipt: null };
  }

  const receipt: StageAppliedReceipt = {
    status: "STAGE_APPLIED",
    presentationSessionId: record.receipt.presentationSessionId,
    presentationSessionEpoch: record.receipt.presentationSessionEpoch,
    actorId: record.receipt.actorId,
    leaseId: record.receipt.leaseId,
    controllerEpoch: record.receipt.controllerEpoch,
    commandId: record.receipt.commandId,
    requestHash: record.receipt.requestHash,
    acceptedControlRevision: record.receipt.acceptedControlRevision,
    publicPlaybackRevision: nextPublicPlaybackRevision(state.publicPlaybackRevision),
    displayBindingEpoch,
  };
  return {
    state: {
      ...state,
      publicPlaybackRevision: receipt.publicPlaybackRevision,
      acceptedCommands: {
        ...state.acceptedCommands,
        [key]: { ...record, appliedReceipt: receipt },
      },
    },
    outcome: "APPLIED",
    receipt,
  };
}

export function replacePlaybackLease(
  state: PlaybackAuthorityState,
  activeLease: PlaybackControlLease,
): PlaybackAuthorityState {
  if (
    activeLease.presentationSessionId !== state.presentationSessionId ||
    activeLease.presentationSessionEpoch !== state.presentationSessionEpoch
  ) {
    throw new Error("replacement lease belongs to a different presentation session");
  }
  return { ...state, activeLease };
}

export function snapshotPlaybackAuthority(
  state: PlaybackAuthorityState,
): PlaybackAuthoritySnapshot {
  return structuredClone(state);
}

export type PlaybackAuthorityRestoreResult =
  | Readonly<{ outcome: "RESTORED"; state: PlaybackAuthorityState }>
  | Readonly<{ outcome: "INVALID_SNAPSHOT" }>;

export function restorePlaybackAuthority(snapshot: unknown): PlaybackAuthorityRestoreResult {
  const parsed = PlaybackAuthoritySnapshotSchema.safeParse(snapshot);
  return parsed.success
    ? { outcome: "RESTORED", state: parsed.data }
    : { outcome: "INVALID_SNAPSHOT" };
}
